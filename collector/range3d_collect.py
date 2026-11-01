#!/usr/bin/env python3
"""range3d coverage envelope collector.

Accumulates the maximum ground range at which an ADS-B position was received, per
1-degree azimuth bin and per altitude band. See ../DESIGN.md for the data model and
the reasoning behind the filters.

Standard library only. Python 3.9+.
"""

import argparse
import array
import gzip
import json
import math
import os
import signal
import sys
import time
import urllib.error
import urllib.request

STATE_VERSION = 1

# Great-circle radius in nautical miles. Matches the value used elsewhere in this
# repo so every distance in the project rides on one sphere.
EARTH_RADIUS_NM = 3440.065

# Line-of-sight constant over a 4/3-radius earth, nautical miles from feet.
LOS_K_NM_PER_SQRT_FT = 1.23

ACCEPTED_TYPES = ("adsb_icao", "adsb_icao_nt", "adsb_other")

MAX_RANGE_NM = 350.0
MAX_ALT_FT = 52000
MIN_NIC = 7
MAX_RC_M = 1852


def build_band_edges():
    """Altitude band edges in feet. Fine low down, coarse at cruise."""
    edges = []
    for lo, hi, step in ((0, 2000, 250), (2000, 10000, 500),
                         (10000, 25000, 1000), (25000, 50000, 2500)):
        alt = lo
        while alt < hi:
            edges.append(alt)
            alt += step
    edges.append(50000)
    return edges


BAND_EDGES = build_band_edges()
N_BANDS = len(BAND_EDGES) - 1


# --------------------------------------------------------------------- heatmap
#
# The envelope keeps only extremes, so it cannot answer "where does traffic
# actually fly". That needs density, which is a second accumulator.
#
# Cartesian rather than polar: airways are straight lines, and a bearing/range
# grid both curves them and changes resolution with distance — 1 degree is 0.1 nm
# wide overhead and 4 nm wide at the edge. A square grid in nautical miles keeps
# cells the same size everywhere and drops straight onto a texture.
#
# Coarse altitude bands. The envelope's 49 are for measuring a boundary precisely;
# eight is plenty for showing where traffic sits, and keeps the grid 6x smaller.

HEAT_BAND_EDGES = [0, 2000, 5000, 10000, 15000, 20000, 30000, 40000, 50000]
HEAT_N_BANDS = len(HEAT_BAND_EDGES) - 1
HEAT_CELL_NM = 2.0
HEAT_HALF_NM = 300.0
HEAT_SIZE = int(2 * HEAT_HALF_NM / HEAT_CELL_NM)    # 300 x 300 cells per band
HEAT_MAX_COUNT = 65535                              # uint16 saturates here


def heat_band_of(alt_ft):
    """Index of the coarse heatmap altitude band, or None if out of range."""
    if alt_ft < HEAT_BAND_EDGES[0] or alt_ft >= HEAT_BAND_EDGES[-1]:
        return None
    for i in range(HEAT_N_BANDS - 1, -1, -1):
        if alt_ft >= HEAT_BAND_EDGES[i]:
            return i
    return None


def band_of(alt_ft):
    """Index of the altitude band containing alt_ft, or None if out of range."""
    if alt_ft < BAND_EDGES[0] or alt_ft >= BAND_EDGES[-1]:
        return None
    lo, hi = 0, N_BANDS
    while lo < hi - 1:
        mid = (lo + hi) // 2
        if BAND_EDGES[mid] <= alt_ft:
            lo = mid
        else:
            hi = mid
    return lo


def theoretical_range_nm(rx_alt_ft, ac_alt_ft):
    """Radio line-of-sight limit over a 4/3-radius earth."""
    return LOS_K_NM_PER_SQRT_FT * (math.sqrt(max(rx_alt_ft, 0.0))
                                   + math.sqrt(max(ac_alt_ft, 0.0)))


def haversine_nm(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = (math.sin(dp / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2)
    return 2 * EARTH_RADIUS_NM * math.asin(min(1.0, math.sqrt(a)))


def initial_bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def fetch_json(url, timeout=10.0):
    req = urllib.request.Request(url, headers={
        "Accept-Encoding": "gzip",
        "User-Agent": "range3d-collector/1",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
    return json.loads(raw.decode("utf-8", "replace"))


class Envelope:
    """The accumulator. Cells are keyed "<azimuth bin>,<altitude band>"."""

    def __init__(self, rx_lat=None, rx_lon=None, rx_alt_ft=None):
        now = int(time.time())
        self.version = STATE_VERSION
        self.rx = {"lat": rx_lat, "lon": rx_lon, "altFt": rx_alt_ft}
        self.band_edges = list(BAND_EDGES)
        self.created = now
        self.updated = now
        self.samples = 0
        self.cells = {}

    @classmethod
    def load(cls, path):
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        if doc.get("version") != STATE_VERSION:
            raise SystemExit("state file version %r is not %d; refusing to touch it"
                             % (doc.get("version"), STATE_VERSION))
        if doc.get("bandEdges") != BAND_EDGES:
            raise SystemExit(
                "state file band edges differ from this build's. Migrate or start "
                "a new file; silently rebinning would corrupt the record.")
        env = cls()
        env.rx = doc.get("rx", {"lat": None, "lon": None, "altFt": None})
        env.created = doc.get("created", env.created)
        env.updated = doc.get("updated", env.updated)
        env.samples = doc.get("samples", 0)
        env.cells = doc.get("cells", {})
        return env

    @classmethod
    def load_or_new(cls, path, rx_lat=None, rx_lon=None, rx_alt_ft=None):
        if os.path.exists(path):
            env = cls.load(path)
            if rx_alt_ft is not None:
                env.rx["altFt"] = rx_alt_ft
            if env.rx.get("lat") is None and rx_lat is not None:
                env.rx["lat"], env.rx["lon"] = rx_lat, rx_lon
            return env
        return cls(rx_lat, rx_lon, rx_alt_ft)

    def to_doc(self):
        return {
            "version": self.version,
            "rx": self.rx,
            "bandEdges": self.band_edges,
            "created": self.created,
            "updated": self.updated,
            "samples": self.samples,
            "cells": self.cells,
        }

    def save(self, path):
        """Atomic: write a sibling temp file, then rename over the target."""
        self.updated = int(time.time())
        directory = os.path.dirname(os.path.abspath(path))
        os.makedirs(directory, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.to_doc(), fh, separators=(",", ":"))
        os.replace(tmp, path)

    def record(self, az_bin, band, range_nm, when, rec):
        """Fold one accepted position in. Returns True if it set a new record."""
        key = "%d,%d" % (az_bin, band)
        cell = self.cells.get(key)
        self.samples += 1
        if cell is None:
            self.cells[key] = {"d": round(range_nm, 2), "n": 1,
                               "t0": when, "t1": when, "rec": rec}
            return True
        cell["n"] += 1
        cell["t1"] = max(cell.get("t1", when), when)
        cell["t0"] = min(cell.get("t0", when), when)
        if range_nm > cell["d"]:
            cell["d"] = round(range_nm, 2)
            cell["rec"] = rec
            return True
        return False

    def merge_cells(self, other_cells):
        added = 0
        for key, cell in other_cells.items():
            mine = self.cells.get(key)
            if mine is None:
                self.cells[key] = dict(cell)
                added += 1
                continue
            mine["n"] = mine.get("n", 0) + cell.get("n", 0)
            mine["t0"] = min(mine.get("t0", cell.get("t0", 0)),
                             cell.get("t0", mine.get("t0", 0)))
            mine["t1"] = max(mine.get("t1", 0), cell.get("t1", 0))
            if cell.get("d", 0) > mine.get("d", 0):
                mine["d"] = cell["d"]
                mine["rec"] = cell.get("rec")
        return added


class Heatmap:
    """Dense position-count grid: eight altitude bands of HEAT_SIZE^2 cells.

    Stored as two files beside the envelope — a small JSON header and a raw
    little-endian uint16 array — because a sparse JSON dict of this many cells
    would be larger than the binary and far slower to parse in a browser. The
    grid is mostly zeros, so it compresses to a fraction of its size in transit.
    """

    def __init__(self, rx_lat=None, rx_lon=None):
        now = int(time.time())
        self.rx = {"lat": rx_lat, "lon": rx_lon}
        self.created = now
        self.updated = now
        self.samples = 0
        self.cells = array.array("H", bytes(2 * HEAT_N_BANDS * HEAT_SIZE * HEAT_SIZE))
        if self.cells.itemsize != 2:
            raise SystemExit("this platform's array('H') is not 2 bytes wide")

    @staticmethod
    def paths(base):
        return base + ".json", base + ".bin"

    def meta(self):
        return {
            "version": 1,
            "rx": self.rx,
            "bandEdges": HEAT_BAND_EDGES,
            "cellNm": HEAT_CELL_NM,
            "halfNm": HEAT_HALF_NM,
            "size": HEAT_SIZE,
            "dtype": "uint16",
            "byteOrder": "little",
            "layout": "band, y (north up), x (east right)",
            "created": self.created,
            "updated": self.updated,
            "samples": self.samples,
        }

    @classmethod
    def load_or_new(cls, base, rx_lat=None, rx_lon=None):
        meta_path, bin_path = cls.paths(base)
        heat = cls(rx_lat, rx_lon)
        if not (os.path.exists(meta_path) and os.path.exists(bin_path)):
            return heat
        with open(meta_path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        # Changing the grid would silently reinterpret every existing count, so
        # refuse rather than corrupt a record that cannot be regenerated.
        if (doc.get("bandEdges") != HEAT_BAND_EDGES
                or doc.get("size") != HEAT_SIZE
                or doc.get("cellNm") != HEAT_CELL_NM):
            raise SystemExit(
                "%s was written with a different heatmap grid. Move it aside to "
                "start a new one." % meta_path)
        with open(bin_path, "rb") as fh:
            raw = fh.read()
        if len(raw) != len(heat.cells) * 2:
            raise SystemExit("%s is %d bytes, expected %d"
                             % (bin_path, len(raw), len(heat.cells) * 2))
        heat.cells = array.array("H")
        heat.cells.frombytes(raw)
        if sys.byteorder != "little":
            heat.cells.byteswap()
        heat.created = doc.get("created", heat.created)
        heat.samples = doc.get("samples", 0)
        if heat.rx.get("lat") is None:
            heat.rx = doc.get("rx", heat.rx)
        return heat

    def record(self, az_deg, range_nm, alt_ft):
        """Count one accepted position. Returns True if it landed on the grid."""
        band = heat_band_of(alt_ft)
        if band is None:
            return False
        a = math.radians(az_deg)
        xi = int((range_nm * math.sin(a) + HEAT_HALF_NM) / HEAT_CELL_NM)
        yi = int((range_nm * math.cos(a) + HEAT_HALF_NM) / HEAT_CELL_NM)
        if not (0 <= xi < HEAT_SIZE and 0 <= yi < HEAT_SIZE):
            return False
        i = (band * HEAT_SIZE + yi) * HEAT_SIZE + xi
        if self.cells[i] < HEAT_MAX_COUNT:
            self.cells[i] += 1
        self.samples += 1
        return True

    def save(self, base):
        """Atomic for both files; the header is written last so a reader never
        sees a header that claims more than the array holds."""
        meta_path, bin_path = self.paths(base)
        self.updated = int(time.time())
        os.makedirs(os.path.dirname(os.path.abspath(base)), exist_ok=True)

        payload = self.cells
        if sys.byteorder != "little":
            payload = array.array("H", self.cells)
            payload.byteswap()
        tmp_bin = bin_path + ".tmp"
        with open(tmp_bin, "wb") as fh:
            fh.write(payload.tobytes())
        os.replace(tmp_bin, bin_path)

        tmp_meta = meta_path + ".tmp"
        with open(tmp_meta, "w", encoding="utf-8") as fh:
            json.dump(self.meta(), fh, separators=(",", ":"))
        os.replace(tmp_meta, meta_path)

    def filled(self):
        return sum(1 for v in self.cells if v)


def accept(ac, now, last_fix, rx):
    """Filter and normalize one aircraft entry.

    Returns (az_bin, band, range_nm, fix_time, record) or None. See DESIGN.md §2.4 —
    the point of each rejection is that an all-time maximum must not be set by an
    estimate or a bad decode.
    """
    if ac.get("type") not in ACCEPTED_TYPES:
        return None

    lat, lon = ac.get("lat"), ac.get("lon")
    if lat is None or lon is None:
        return None

    nic = ac.get("nic")
    if nic is None or nic < MIN_NIC:
        return None
    rc = ac.get("rc")
    if rc is not None and rc > MAX_RC_M:
        return None

    alt, src = ac.get("alt_geom"), "geom"
    if not isinstance(alt, (int, float)):
        alt, src = ac.get("alt_baro"), "baro"
    if not isinstance(alt, (int, float)):
        return None
    if alt < 0 or alt > MAX_ALT_FT:
        return None

    band = band_of(alt)
    if band is None:
        return None

    seen_pos = ac.get("seen_pos")
    if seen_pos is None:
        return None
    fix_t = now - seen_pos

    hexid = ac.get("hex")
    if hexid is None:
        return None
    previous = last_fix.get(hexid)
    if previous is not None and fix_t <= previous + 1e-3:
        return None

    # readsb computes these against its configured receiver position whenever it has
    # one; they agree with our own geodesy and save the trig.
    range_nm = ac.get("r_dst")
    bearing = ac.get("r_dir")
    if range_nm is None or bearing is None:
        if rx.get("lat") is None:
            return None
        range_nm = haversine_nm(rx["lat"], rx["lon"], lat, lon)
        bearing = initial_bearing_deg(rx["lat"], rx["lon"], lat, lon)
    if range_nm <= 0 or range_nm > MAX_RANGE_NM:
        return None

    az_bin = int(math.floor(bearing)) % 360
    rec = {"hex": hexid, "t": int(fix_t), "lat": round(lat, 6),
           "lon": round(lon, 6), "alt": int(alt), "src": src}
    if isinstance(ac.get("rssi"), (int, float)):
        rec["rssi"] = ac["rssi"]
    rec["nic"] = nic
    if ac.get("flight"):
        rec["flight"] = ac["flight"].strip()
    return az_bin, band, range_nm, int(fix_t), rec


def heatmap_base(args):
    """Path prefix for heatmap.json/.bin, or None when disabled.

    Defaults to sitting beside the envelope, so an existing install picks the
    heatmap up on upgrade with no configuration change — and the web server
    alias that already serves the state directory serves it too.
    """
    if getattr(args, "no_heatmap", False):
        return None
    if getattr(args, "heatmap", None):
        return args.heatmap
    return os.path.join(os.path.dirname(os.path.abspath(args.state)), "heatmap")


def cmd_collect(args):
    base = args.base_url.rstrip("/")
    rx_lat = rx_lon = None
    try:
        receiver = fetch_json(base + "/data/receiver.json")
        rx_lat, rx_lon = receiver.get("lat"), receiver.get("lon")
        print("receiver position %s, %s" % (rx_lat, rx_lon), flush=True)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print("could not read receiver.json (%s); relying on r_dst/r_dir" % exc,
              flush=True)

    env = Envelope.load_or_new(args.state, rx_lat, rx_lon, args.rx_alt_ft)
    print("state %s: %d cells, %d samples"
          % (args.state, len(env.cells), env.samples), flush=True)

    # The heatmap is written far less often than the envelope: it is a fixed
    # 1.4 MB regardless of content, and rewriting that every minute is pointless
    # churn on an SD card for a layer nobody watches second by second.
    heat = None
    heat_base = heatmap_base(args)
    if heat_base:
        heat = Heatmap.load_or_new(heat_base, rx_lat, rx_lon)
        print("heatmap %s.bin: %d cells filled, %d samples"
              % (heat_base, heat.filled(), heat.samples), flush=True)

    last_fix = {}
    stopping = {"now": False}

    def on_signal(_signum, _frame):
        stopping["now"] = True

    for name in ("SIGTERM", "SIGINT"):
        if hasattr(signal, name):
            try:
                signal.signal(getattr(signal, name), on_signal)
            except (ValueError, OSError):
                pass

    url = base + "/data/aircraft.json"
    last_save = time.time()
    last_heat_save = time.time()
    backoff = 1.0
    records = 0
    deadline = time.time() + args.duration if args.duration else None

    while not stopping["now"]:
        cycle_start = time.time()
        try:
            snapshot = fetch_json(url)
            backoff = 1.0
        except (urllib.error.URLError, OSError, ValueError) as exc:
            print("fetch failed: %s (retry in %.0fs)" % (exc, backoff), flush=True)
            time.sleep(backoff)
            backoff = min(backoff * 2, 30.0)
            continue

        now = snapshot.get("now", time.time())
        for ac in snapshot.get("aircraft", ()):
            accepted = accept(ac, now, last_fix, env.rx)
            if accepted is None:
                continue
            az_bin, band, range_nm, fix_t, rec = accepted
            last_fix[rec["hex"]] = now - ac["seen_pos"]
            if env.record(az_bin, band, range_nm, fix_t, rec):
                records += 1
            if heat is not None:
                # The exact bearing, not the 1-degree bin: the grid is Cartesian
                # and rounding to a bin here would quantise paths into spokes.
                heat.record(ac.get("r_dir", az_bin), range_nm, rec["alt"])

        # Aircraft go away; their dedupe entries should not accumulate forever.
        if len(last_fix) > 4000:
            cutoff = now - 600
            last_fix = {k: v for k, v in last_fix.items() if v > cutoff}

        if time.time() - last_save >= args.save_every:
            env.save(args.state)
            last_save = time.time()
            print("saved: %d cells, %d samples, %d records set"
                  % (len(env.cells), env.samples, records), flush=True)

        if heat is not None and time.time() - last_heat_save >= args.heatmap_every:
            heat.save(heat_base)
            last_heat_save = time.time()
            print("heatmap saved: %d cells filled, %d samples"
                  % (heat.filled(), heat.samples), flush=True)

        if deadline and time.time() >= deadline:
            break

        elapsed = time.time() - cycle_start
        if elapsed < args.interval:
            time.sleep(args.interval - elapsed)

    env.save(args.state)
    if heat is not None:
        heat.save(heat_base)
    print("stopped: %d cells, %d samples%s"
          % (len(env.cells), env.samples,
             "" if heat is None else ", heatmap %d samples" % heat.samples),
          flush=True)
    return 0


def cmd_seed_outline(args):
    base = args.base_url.rstrip("/")
    outline = fetch_json(base + "/data/outline.json")
    points = outline.get("actualRange", {}).get("last24h", {}).get("points", [])
    if not points:
        print("outline.json carried no points")
        return 1

    rx_lat = rx_lon = None
    try:
        receiver = fetch_json(base + "/data/receiver.json")
        rx_lat, rx_lon = receiver.get("lat"), receiver.get("lon")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise SystemExit("seeding needs receiver.json for geodesy: %s" % exc)

    env = Envelope.load_or_new(args.state, rx_lat, rx_lon, args.rx_alt_ft)
    if env.rx.get("lat") is None:
        env.rx["lat"], env.rx["lon"] = rx_lat, rx_lon

    when = int(time.time())
    seeded = 0
    for lat, lon, alt in points:
        band = band_of(alt)
        if band is None:
            continue
        range_nm = haversine_nm(rx_lat, rx_lon, lat, lon)
        if range_nm <= 0 or range_nm > MAX_RANGE_NM:
            continue
        az_bin = int(math.floor(initial_bearing_deg(rx_lat, rx_lon, lat, lon))) % 360
        rec = {"hex": None, "t": when, "lat": round(lat, 6), "lon": round(lon, 6),
               "alt": int(alt), "src": "outline"}
        env.record(az_bin, band, range_nm, when, rec)
        seeded += 1

    env.save(args.state)
    print("seeded %d of %d outline points into %d cells"
          % (seeded, len(points), len(env.cells)))
    return 0


def cmd_merge(args):
    target = Envelope.load_or_new(args.state)
    for path in args.sources:
        other = Envelope.load(path)
        added = target.merge_cells(other.cells)
        target.samples += other.samples
        target.created = min(target.created, other.created)
        if target.rx.get("lat") is None:
            target.rx = other.rx
        print("%s: %d cells, %d new" % (path, len(other.cells), added))
    target.save(args.state)
    print("merged into %s: %d cells, %d samples"
          % (args.state, len(target.cells), target.samples))
    return 0


def closed_ranges(env, min_hits):
    """Per bearing, the monotone-upward closure of the raw maxima. DESIGN.md §2.1."""
    grid = [[0.0] * N_BANDS for _ in range(360)]
    for key, cell in env.cells.items():
        if cell.get("n", 0) < min_hits:
            continue
        az_text, band_text = key.split(",")
        grid[int(az_text)][int(band_text)] = cell.get("d", 0.0)
    for az in range(360):
        running = 0.0
        for band in range(N_BANDS):
            running = max(running, grid[az][band])
            grid[az][band] = running
    return grid


def cmd_stats(args):
    env = Envelope.load(args.state)
    rx_alt = env.rx.get("altFt")
    grid = closed_ranges(env, args.min_hits)
    filled = sum(1 for cell in env.cells.values()
                 if cell.get("n", 0) >= args.min_hits)

    print("state     %s" % args.state)
    print("receiver  %s, %s  alt %s ft"
          % (env.rx.get("lat"), env.rx.get("lon"),
             rx_alt if rx_alt is not None else "unset"))
    print("collected %s -> %s"
          % (time.strftime("%Y-%m-%d %H:%M", time.localtime(env.created)),
             time.strftime("%Y-%m-%d %H:%M", time.localtime(env.updated))))
    print("samples   %d" % env.samples)
    print("cells     %d filled (>=%d hits) of %d"
          % (filled, args.min_hits, 360 * N_BANDS))
    print()
    header = "  band          max NM  mean NM  bearings"
    if rx_alt is not None:
        header += "  theory NM  achieved"
    print(header)

    for band in range(N_BANDS):
        values = [grid[az][band] for az in range(360)]
        covered = [v for v in values if v > 0]
        if not covered:
            continue
        lo, hi = BAND_EDGES[band], BAND_EDGES[band + 1]
        line = "  %5d-%-5d  %7.1f  %7.1f  %4d/360" % (
            lo, hi, max(covered), sum(covered) / len(covered), len(covered))
        if rx_alt is not None:
            theory = theoretical_range_nm(rx_alt, lo)
            line += "  %9.1f  %6.0f%%" % (theory, 100.0 * max(covered) / theory)
        print(line)

    base = heatmap_base(args)
    if base and os.path.exists(base + ".bin"):
        heat = Heatmap.load_or_new(base)
        total = HEAT_N_BANDS * HEAT_SIZE * HEAT_SIZE
        print()
        print("heatmap  %d of %d cells (%.1f%%), %s positions"
              % (heat.filled(), total, 100.0 * heat.filled() / total,
                 f"{heat.samples:,}"))
        print("  band             cells   busiest cell")
        for b in range(HEAT_N_BANDS):
            lo, hi = HEAT_BAND_EDGES[b], HEAT_BAND_EDGES[b + 1]
            start = b * HEAT_SIZE * HEAT_SIZE
            chunk = heat.cells[start:start + HEAT_SIZE * HEAT_SIZE]
            filled = sum(1 for v in chunk if v)
            if filled:
                print("  %5d-%-5d  %10d   %12d" % (lo, hi, filled, max(chunk)))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base-url", default="http://localhost/tar1090",
                        help="tar1090 base URL (default: %(default)s)")
    parser.add_argument("--state", default="envelope.json",
                        help="envelope state file (default: %(default)s)")
    parser.add_argument("--rx-alt-ft", type=float, default=None,
                        help="antenna height above sea level, feet")
    parser.add_argument("--heatmap", default=None,
                        help="path prefix for heatmap.json/.bin "
                             "(default: beside --state)")
    parser.add_argument("--no-heatmap", action="store_true",
                        help="do not accumulate the traffic density heatmap")
    sub = parser.add_subparsers(dest="cmd", required=True)

    collect = sub.add_parser("collect", help="poll aircraft.json and accumulate")
    collect.add_argument("--interval", type=float, default=1.0)
    collect.add_argument("--save-every", type=float, default=60.0)
    collect.add_argument("--heatmap-every", type=float, default=300.0,
                         help="seconds between heatmap saves (default: "
                              "%(default)s; it is a fixed 1.4 MB each time)")
    collect.add_argument("--duration", type=float, default=None,
                         help="stop after N seconds (for testing)")
    collect.set_defaults(func=cmd_collect)

    seed = sub.add_parser("seed-outline", help="fold outline.json in as a baseline")
    seed.set_defaults(func=cmd_seed_outline)

    merge = sub.add_parser("merge", help="merge other state files into --state")
    merge.add_argument("sources", nargs="+")
    merge.set_defaults(func=cmd_merge)

    stats = sub.add_parser("stats", help="print a coverage summary")
    stats.add_argument("--min-hits", type=int, default=2)
    stats.set_defaults(func=cmd_stats)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
