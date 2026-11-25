#!/usr/bin/env python3
"""range3d coverage envelope collector.

Accumulates the maximum ground range at which an ADS-B position was received, per
1-degree azimuth bin and per altitude band. See ../DESIGN.md for the data model and
the reasoning behind the filters.

Standard library only. Python 3.9+.
"""

import argparse
import array
import calendar
import gzip
import json
import math
import os
import shutil
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

# The top of every altitude band, envelope and heatmap alike. High enough for the
# business jets that cruise up to 51,000 ft, with a little room over; a report of
# exactly the top still counts, in the highest band.
ALT_TOP_FT = 53000
MAX_ALT_FT = ALT_TOP_FT
MIN_NIC = 7
MAX_RC_M = 1852


def build_band_edges():
    """Altitude band edges in feet. Finest low down, where the horizon cuts
    range off sharply with height; 1,000 ft from 10,000 ft to the top, so the
    cruise levels and the envelope's ceiling are as fine as the climb."""
    edges = []
    for lo, hi, step in ((0, 2000, 250), (2000, 10000, 500),
                         (10000, ALT_TOP_FT, 1000)):
        alt = lo
        while alt < hi:
            edges.append(alt)
            alt += step
    edges.append(ALT_TOP_FT)
    return edges


BAND_EDGES = build_band_edges()
N_BANDS = len(BAND_EDGES) - 1

# Older layouts all match this one below 25,000 ft and differ above it: 2,500 ft
# bands to 50,000 ft as released, and two short-lived development tops. Their
# cells from 25,000 ft up are re-filed on load (rebin).
REBIN_FROM_FT = 25000


def rebin(path, doc):
    """Moves a state file from an older band layout onto this one. Returns
    False, touching nothing, if the layout is not one this can convert.

    A cell keeps one record: the farthest contact in that band at that bearing,
    with its altitude. So each cell from REBIN_FROM_FT up is filed under the new
    band that contact was actually in. Nothing measured is lost; the new bands
    the old one covered start without a record of their own, and closure covers
    them from below until contacts arrive. A record is never copied down into a
    lower band: being heard at one height says nothing about hearing a lower
    aircraft that far out. Records above the top are dropped.
    """
    old = doc.get("bandEdges")
    cut = BAND_EDGES.index(REBIN_FROM_FT)
    if not isinstance(old, list) or len(old) <= cut + 1 \
            or old[:cut + 1] != BAND_EDGES[:cut + 1]:
        return False

    cells = {}
    moved = dropped = 0
    for key, cell in doc.get("cells", {}).items():
        az, band = (int(x) for x in key.split(","))
        if band < cut:
            cells[key] = cell
            continue
        alt = (cell.get("rec") or {}).get("alt")
        new_band = band_of(alt) if isinstance(alt, (int, float)) else None
        if new_band is None and band < len(old) - 1:
            new_band = band_of(old[band])   # no altitude: the old band's floor
        if new_band is None:
            dropped += 1
            continue
        moved += 1
        new_key = "%d,%d" % (az, new_band)
        mine = cells.get(new_key)
        if mine is None:
            cells[new_key] = cell
            continue
        mine["n"] = mine.get("n", 0) + cell.get("n", 0)
        mine["t0"] = min(mine.get("t0", cell.get("t0", 0)), cell.get("t0", mine.get("t0", 0)))
        mine["t1"] = max(mine.get("t1", 0), cell.get("t1", 0))
        if cell.get("d", 0) > mine.get("d", 0):
            mine["d"] = cell["d"]
            mine["rec"] = cell.get("rec")

    backup = path + ".before-band-change"
    if not os.path.exists(backup):
        shutil.copy2(path, backup)
    doc["cells"] = cells
    doc["bandEdges"] = BAND_EDGES
    print("%s: altitude bands from %s ft re-filed into 1,000 ft steps: %d cells "
          "moved by their contact's altitude, %d above the top dropped; the old "
          "file is kept as %s"
          % (path, f"{REBIN_FROM_FT:,}", moved, dropped, backup), flush=True)
    return True


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

HEAT_BAND_EDGES = [0, 2000, 5000, 10000, 15000, 20000, 30000, 40000, 50000, ALT_TOP_FT]

# The 60,000 ft development build had the same bands with a higher top; its top
# band becomes 50,000 to 53,000 ft as it stands.
HEAT_EDGES_60K = HEAT_BAND_EDGES[:-1] + [60000]
HEAT_N_BANDS = len(HEAT_BAND_EDGES) - 1
HEAT_CELL_NM = 2.0
HEAT_HALF_NM = MAX_RANGE_NM                         # the grid reaches as far as we accept
HEAT_SIZE = int(2 * HEAT_HALF_NM / HEAT_CELL_NM)    # 350 x 350 cells per band
HEAT_CELLS = HEAT_N_BANDS * HEAT_SIZE * HEAT_SIZE
HEAT_VERSION = 2

# Six months, as a rolling window of whole weeks: patterns change with the seasons
# and with runway use, and an all-time total would never let the old ones fade.
# Weeks rather than days keep it to 26 files; the window steps forward a week at
# a time, so it spans between 25 and 26 weeks.
HEAT_WINDOW_WEEKS = 26

# An aircraft back in a cell it was in less than this long ago is still on the
# same pass. Long enough that a holding pattern or circuit counts once, not once
# a lap; short enough that nothing scheduled comes back through that quickly.
HEAT_PASS_GAP_S = 1800


def heat_band_of(alt_ft):
    """Index of the coarse heatmap altitude band, or None if out of range."""
    if alt_ft == HEAT_BAND_EDGES[-1]:
        return HEAT_N_BANDS - 1
    if alt_ft < HEAT_BAND_EDGES[0] or alt_ft >= HEAT_BAND_EDGES[-1]:
        return None
    for i in range(HEAT_N_BANDS - 1, -1, -1):
        if alt_ft >= HEAT_BAND_EDGES[i]:
            return i
    return None


def band_of(alt_ft):
    """Index of the altitude band containing alt_ft, or None if out of range."""
    if alt_ft == BAND_EDGES[-1]:
        return N_BANDS - 1
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
        if doc.get("bandEdges") != BAND_EDGES and not rebin(path, doc):
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
    """Flights through each cell of the grid over the last six months.

    A count is one aircraft passing through a cell, not one position report. An
    aircraft adds one to every cell it is heard in, and adds to the same cell
    again only after HEAT_PASS_GAP_S away from it. Counting time instead would
    weigh a hovering helicopter like forty airliners, and would make routes at
    the edge of coverage, where a position is heard every ten seconds rather
    than every second, look far quieter than they are.

    Kept as one small file per week (Monday to Sunday, UTC) under <base>-weeks/,
    named for the Monday, each holding only the cells that week touched, as
    little-endian uint32 (cell, count) pairs. The six-month total is their sum,
    kept in memory as it runs: this week's passes add to it, and a week falling
    out of the window is subtracted and its file deleted. What the viewer reads is that total, written beside the envelope as
    heatmap.json and heatmap.bin in the same sparse pairs, since most of the
    grid is empty and a sparse file is a fraction of the size to write and send.
    """

    def __init__(self, base, rx_lat=None, rx_lon=None):
        self.base = base
        self.weeks_dir = base + "-weeks"
        self.rx = {"lat": rx_lat, "lon": rx_lon}
        self.updated = int(time.time())
        self.totals = array.array("I", bytes(4 * HEAT_CELLS))
        if self.totals.itemsize != 4:
            raise SystemExit("this platform's array('I') is not 4 bytes wide")
        self.passes = 0               # in the window
        self.weeks = []               # weeks on disk, oldest first, by Monday's date
        self.week = None              # the week being counted
        self.week_counts = {}         # cell -> passes, this week
        self.recent = {}              # hex -> {cell: last time heard in it}

    # ------------------------------------------------------------ files

    @staticmethod
    def paths(base):
        return base + ".json", base + ".bin"

    def week_path(self, week):
        return os.path.join(self.weeks_dir, week + ".bin")

    @staticmethod
    def week_of(t):
        """The week holding time t, named by the date of its Monday, UTC."""
        monday = t - time.gmtime(t).tm_wday * 86400
        return time.strftime("%Y-%m-%d", time.gmtime(monday))

    @staticmethod
    def week_start(week):
        return calendar.timegm(time.strptime(week, "%Y-%m-%d"))

    @staticmethod
    def read_pairs(path):
        pairs = array.array("I")
        with open(path, "rb") as fh:
            pairs.frombytes(fh.read())
        if sys.byteorder != "little":
            pairs.byteswap()
        return pairs

    @staticmethod
    def write_pairs(path, counts):
        """counts: iterable of (cell, count). Atomic, like every other write here."""
        pairs = array.array("I")
        for cell, count in counts:
            pairs.append(cell)
            pairs.append(count)
        if sys.byteorder != "little":
            pairs.byteswap()
        tmp = path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(pairs.tobytes())
        os.replace(tmp, path)

    def grid(self):
        return {"bandEdges": HEAT_BAND_EDGES, "cellNm": HEAT_CELL_NM,
                "halfNm": HEAT_HALF_NM, "size": HEAT_SIZE}

    def set_aside_v1(self):
        """The first heatmap counted seconds, not passes, so its numbers cannot be
        carried into this one. Kept beside it under a new name, never deleted."""
        meta_path, bin_path = self.paths(self.base)
        if not os.path.exists(meta_path):
            return
        try:
            with open(meta_path, "r", encoding="utf-8") as fh:
                version = json.load(fh).get("version")
        except (OSError, ValueError):
            version = None
        if version == HEAT_VERSION:
            return
        for path in (meta_path, bin_path):
            if os.path.exists(path):
                root, ext = os.path.splitext(path)
                os.replace(path, "%s-v1%s" % (root, ext))
        print("%s: the old heatmap counted time, not passes, and has been kept as "
              "%s-v1.json/.bin; a new one starts now" % (meta_path, self.base),
              flush=True)

    @classmethod
    def load_or_new(cls, base, rx_lat=None, rx_lon=None, now=None):
        heat = cls(base, rx_lat, rx_lon)
        heat.set_aside_v1()
        os.makedirs(heat.weeks_dir, exist_ok=True)

        # The weeks are only meaningful on the grid they were counted on.
        grid_path = os.path.join(heat.weeks_dir, "grid.json")
        if os.path.exists(grid_path):
            with open(grid_path, "r", encoding="utf-8") as fh:
                stored = json.load(fh)
            if dict(stored, bandEdges=HEAT_BAND_EDGES) == heat.grid() \
                    and stored.get("bandEdges") == HEAT_EDGES_60K:
                with open(grid_path, "w", encoding="utf-8") as fh:
                    json.dump(heat.grid(), fh)
                print("%s: top band relabelled from 50,000-60,000 to 50,000-%s ft"
                      % (heat.weeks_dir, f"{ALT_TOP_FT:,}"), flush=True)
                stored = heat.grid()
            if stored != heat.grid():
                raise SystemExit(
                    "%s holds weeks counted on a different grid. Move the "
                    "folder aside to start a new heatmap." % heat.weeks_dir)
        else:
            with open(grid_path, "w", encoding="utf-8") as fh:
                json.dump(heat.grid(), fh)

        meta_path = heat.paths(base)[0]
        if os.path.exists(meta_path):
            with open(meta_path, "r", encoding="utf-8") as fh:
                rx = json.load(fh).get("rx")
            if heat.rx.get("lat") is None and rx:
                heat.rx = rx

        for name in sorted(os.listdir(heat.weeks_dir)):
            if name.endswith(".bin") and len(name) == len("YYYY-MM-DD.bin"):
                week = name[:-4]
                pairs = cls.read_pairs(heat.week_path(week))
                for k in range(0, len(pairs) - 1, 2):
                    if pairs[k] < HEAT_CELLS:
                        heat.totals[pairs[k]] += pairs[k + 1]
                        heat.passes += pairs[k + 1]
                heat.weeks.append(week)
        heat.roll(now if now is not None else time.time())
        return heat

    # ------------------------------------------------------------ counting

    def roll(self, now):
        """Moves on to a new week when Monday comes, and lets go of any week
        that has fallen out of the window."""
        week = self.week_of(now)
        if week != self.week:
            if self.week is not None:
                self.write_pairs(self.week_path(self.week), sorted(self.week_counts.items()))
            self.week = week
            self.week_counts = {}
            if week in self.weeks:
                pairs = self.read_pairs(self.week_path(week))
                for k in range(0, len(pairs) - 1, 2):
                    self.week_counts[pairs[k]] = pairs[k + 1]
            else:
                self.weeks.append(week)
                self.weeks.sort()

        # The window is this week and the weeks before it, HEAT_WINDOW_WEEKS in all.
        oldest = self.week_of(now - (HEAT_WINDOW_WEEKS - 1) * 7 * 86400)
        while self.weeks and self.weeks[0] < oldest:
            gone = self.weeks.pop(0)
            path = self.week_path(gone)
            if os.path.exists(path):
                pairs = self.read_pairs(path)
                for k in range(0, len(pairs) - 1, 2):
                    if pairs[k] < HEAT_CELLS:
                        self.totals[pairs[k]] -= min(self.totals[pairs[k]], pairs[k + 1])
                        self.passes -= pairs[k + 1]
                os.remove(path)

    def record(self, hexid, az_deg, range_nm, alt_ft, t):
        """Counts a pass if this aircraft has not been in this cell lately.
        Returns True when it counted."""
        band = heat_band_of(alt_ft)
        if band is None:
            return False
        a = math.radians(az_deg)
        xi = int((range_nm * math.sin(a) + HEAT_HALF_NM) / HEAT_CELL_NM)
        yi = int((range_nm * math.cos(a) + HEAT_HALF_NM) / HEAT_CELL_NM)
        if not (0 <= xi < HEAT_SIZE and 0 <= yi < HEAT_SIZE):
            return False
        cell = (band * HEAT_SIZE + yi) * HEAT_SIZE + xi
        seen = self.recent.setdefault(hexid, {})
        last = seen.get(cell)
        seen[cell] = t
        if last is not None and t - last < HEAT_PASS_GAP_S:
            return False
        self.week_counts[cell] = self.week_counts.get(cell, 0) + 1
        self.totals[cell] += 1
        self.passes += 1
        return True

    def forget(self, now):
        """Drops cells an aircraft left long enough ago to count again anyway."""
        cutoff = now - HEAT_PASS_GAP_S
        for hexid in list(self.recent):
            cells = {c: t for c, t in self.recent[hexid].items() if t >= cutoff}
            if cells:
                self.recent[hexid] = cells
            else:
                del self.recent[hexid]

    # ------------------------------------------------------------ output

    def window_start(self):
        return self.week_start(self.weeks[0]) if self.weeks else self.updated

    def meta(self):
        return {
            "version": HEAT_VERSION,
            "rx": self.rx,
            "bandEdges": HEAT_BAND_EDGES,
            "cellNm": HEAT_CELL_NM,
            "halfNm": HEAT_HALF_NM,
            "size": HEAT_SIZE,
            "dtype": "uint32",
            "byteOrder": "little",
            "layout": "sparse (cell, count) pairs; cell = (band * size + y) * size + x,"
                      " y north up, x east right",
            "counts": "passes",
            "windowWeeks": HEAT_WINDOW_WEEKS,
            "weeks": len(self.weeks),
            "created": self.window_start(),
            "updated": self.updated,
            "passes": self.passes,
        }

    def save(self):
        """This week's file, then the total; the header last, so a reader never
        sees a header newer than the counts it describes."""
        self.updated = int(time.time())
        if self.week is not None:
            self.write_pairs(self.week_path(self.week), sorted(self.week_counts.items()))
        meta_path, bin_path = self.paths(self.base)
        totals = self.totals
        self.write_pairs(bin_path, ((i, v) for i, v in enumerate(totals) if v))
        tmp_meta = meta_path + ".tmp"
        with open(tmp_meta, "w", encoding="utf-8") as fh:
            json.dump(self.meta(), fh, separators=(",", ":"))
        os.replace(tmp_meta, meta_path)

    def filled(self):
        return sum(1 for v in self.totals if v)


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


# -------------------------------------------------------------------- profiles
#
# Each antenna setup is a profile: its own envelope, heatmap and map, with a name,
# an antenna height, the receiver position it was recorded at, and dates. One
# profile is collecting; the rest are archived, kept read-only for the viewer.
#
#   <root>/antennas.json              the list, and which profile is collecting
#   <root>/antennas/<slug>/           envelope.json, heatmap*, map.json
#   <root>/maps/tiles/<z>/<x>/<y>.png one tile cache that every profile's map uses
#   <root>/status.json                what the collector is doing, and warnings
#
# <root> is the directory of --state. An install from before profiles has its
# envelope and heatmap there; they become the profile "Antenna 1" on first run,
# and links are left at the old names so anything reading them still works.

PROFILES_VERSION = 1

# A receiver this far from where its profile was recorded has moved, and its
# readings would no longer line up with the profile's: a new one is started.
MOVE_LIMIT_NM = 1.0 / 1.852     # 1 km

# Files that belong to a profile, moved into it from an older install.
PROFILE_FILES = ("envelope.json", "heatmap.json", "heatmap.bin",
                 "heatmap-v1.json", "heatmap-v1.bin", "heatmap-weeks")

# Left at the state directory's top level for older viewers and servers, pointing
# into whichever profile is collecting.
COMPAT_LINKS = ("envelope.json", "heatmap.json", "heatmap.bin")


def slugify(name):
    slug = "".join(ch if ch.isalnum() else "-" for ch in name.lower())
    slug = "-".join(part for part in slug.split("-") if part)
    return slug[:40] or "antenna"


def today_label(t):
    tm = time.localtime(t)
    return "%d %s" % (tm.tm_mday, time.strftime("%b %Y", tm))


def write_json(path, doc):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1)
    os.replace(tmp, path)


class Profiles:
    def __init__(self, root):
        self.root = root
        self.index_path = os.path.join(root, "antennas.json")
        self.doc = {"version": PROFILES_VERSION, "collecting": None, "profiles": []}

    # ---------------------------------------------------------------- paths

    def dir(self, p):
        return os.path.join(self.root, "antennas", p["slug"])

    def envelope_path(self, p):
        return os.path.join(self.dir(p), "envelope.json")

    def heat_base(self, p):
        return os.path.join(self.dir(p), "heatmap")

    def map_path(self, p):
        return os.path.join(self.dir(p), "map.json")

    def tiles_dir(self):
        return os.path.join(self.root, "maps", "tiles")

    # ---------------------------------------------------------------- reading

    @property
    def profiles(self):
        return self.doc["profiles"]

    @property
    def collecting(self):
        return self.find(self.doc.get("collecting"))

    def find(self, name):
        """By slug, or by name ignoring case."""
        if not name:
            return None
        for p in self.profiles:
            if p["slug"] == name or p["name"].lower() == str(name).lower():
                return p
        return None

    def need(self, name):
        p = self.find(name)
        if p is None:
            raise SystemExit("no antenna called %r. `range3d antenna list` shows them."
                             % name)
        return p

    # ---------------------------------------------------------------- writing

    def save(self):
        self.doc["updated"] = int(time.time())
        os.makedirs(self.root, exist_ok=True)
        write_json(self.index_path, self.doc)
        self.link_compat()

    def link_compat(self):
        """Points the old top-level names at the collecting profile's files.
        Best effort: a filesystem without symlinks just goes without them."""
        p = self.collecting
        if p is None:
            return
        for name in COMPAT_LINKS:
            link = os.path.join(self.root, name)
            if os.path.exists(link) and not os.path.islink(link):
                continue        # a real file: not ours to replace
            target = os.path.join("antennas", p["slug"], name)
            tmp = link + ".link"
            try:
                if os.path.lexists(tmp):
                    os.remove(tmp)
                os.symlink(target, tmp)
                os.replace(tmp, link)
            except (OSError, NotImplementedError):
                return

    def unique_slug(self, name):
        base = slugify(name)
        slug, n = base, 2
        taken = {p["slug"] for p in self.profiles}
        while slug in taken or os.path.exists(os.path.join(self.root, "antennas", slug)):
            slug = "%s-%d" % (base, n)
            n += 1
        return slug

    def add(self, name, rx, antenna_ft=None, now=None):
        """A new profile, collecting from now; the one collecting before is archived."""
        if self.find(name):
            raise SystemExit("there is already an antenna called %r" % name)
        now = int(now or time.time())
        current = self.collecting
        if current is not None:
            current["archived"] = now
        p = {"slug": self.unique_slug(name), "name": name, "antennaFt": antenna_ft,
             "rx": {"lat": rx.get("lat"), "lon": rx.get("lon")},
             "created": now, "archived": None}
        os.makedirs(self.dir(p), exist_ok=True)
        self.profiles.append(p)
        self.doc["collecting"] = p["slug"]
        return p

    # ---------------------------------------------------------------- loading

    @classmethod
    def open(cls, root, rx=None):
        """The profiles under root, converting an install from before profiles."""
        profiles = cls(root)
        if os.path.exists(profiles.index_path):
            with open(profiles.index_path, "r", encoding="utf-8") as fh:
                profiles.doc = json.load(fh)
            if profiles.collecting is None and profiles.profiles:
                profiles.doc["collecting"] = profiles.profiles[-1]["slug"]
            return profiles
        profiles.migrate(rx or {})
        return profiles

    def migrate(self, rx):
        """Everything already here becomes "Antenna 1", collecting as before."""
        os.makedirs(self.root, exist_ok=True)
        env_path = os.path.join(self.root, "envelope.json")
        created, env_rx = int(time.time()), {}
        if os.path.isfile(env_path) and not os.path.islink(env_path):
            try:
                with open(env_path, "r", encoding="utf-8") as fh:
                    head = json.load(fh)
                created = head.get("created", created)
                env_rx = head.get("rx") or {}
            except (OSError, ValueError):
                pass
        # The installed antenna height keeps coming from the settings file, as it
        # always has, so nothing changes for an install that never uses profiles.
        p = {"slug": "antenna-1", "name": "Antenna 1", "antennaFt": None,
             "rx": {"lat": env_rx.get("lat", rx.get("lat")),
                    "lon": env_rx.get("lon", rx.get("lon"))},
             "created": created, "archived": None}
        os.makedirs(self.dir(p), exist_ok=True)
        moved = []
        for name in PROFILE_FILES:
            src = os.path.join(self.root, name)
            if os.path.lexists(src) and not os.path.islink(src):
                os.replace(src, os.path.join(self.dir(p), name))
                moved.append(name)
        self.profiles.append(p)
        self.doc["collecting"] = p["slug"]
        self.save()
        print("profiles: this install's data is now the antenna profile %r (%s)"
              % (p["name"], ", ".join(moved) if moved else "nothing collected yet"),
              flush=True)


# -------------------------------------------------------------------- status
#
# status.json is how the collector tells the viewer about things the person at
# the browser should know, such as the receiver having moved. Warnings stay until
# a command that deals with them clears them; the viewer lets each be dismissed.

def status_path(root):
    return os.path.join(root, "status.json")


def read_status(root):
    try:
        with open(status_path(root), "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        if isinstance(doc, dict):
            return doc
    except (OSError, ValueError):
        pass
    return {"warnings": []}


def write_status(root, profiles, add=None, clear_kinds=()):
    doc = read_status(root)
    warnings = [w for w in doc.get("warnings", []) if w.get("kind") not in clear_kinds]
    if add:
        warnings.append(add)
    doc.update({"version": 1, "updated": int(time.time()),
                "collecting": profiles.doc.get("collecting"), "warnings": warnings})
    os.makedirs(root, exist_ok=True)
    write_json(status_path(root), doc)


def check_move(profiles, rx_lat, rx_lon, now=None):
    """Starts a new profile if the receiver is no longer where the collecting one
    was recorded. Returns the profile to collect into."""
    p = profiles.collecting
    if rx_lat is None or rx_lon is None:
        return p
    prx = p.get("rx") or {}
    if prx.get("lat") is None or prx.get("lon") is None:
        p["rx"] = {"lat": rx_lat, "lon": rx_lon}
        profiles.save()
        return p
    moved_nm = haversine_nm(prx["lat"], prx["lon"], rx_lat, rx_lon)
    if moved_nm <= MOVE_LIMIT_NM:
        return p
    now = int(now or time.time())
    name = "New location (%s)" % today_label(now)
    n = 2
    while profiles.find(name):
        name = "New location (%s, %d)" % (today_label(now), n)
        n += 1
    old_name = p["name"]
    new = profiles.add(name, {"lat": rx_lat, "lon": rx_lon}, None, now)
    profiles.save()
    km = moved_nm * 1.852
    write_status(profiles.root, profiles, add={
        "kind": "moved", "id": "moved-%d" % now, "at": now,
        "from": old_name, "to": name, "km": round(km, 1),
        "text": "Receiver moved %s km from where \"%s\" was recorded. \"%s\" is "
                "archived; collecting continues in \"%s\". Rename it with: sudo "
                "range3d antenna rename \"%s\" \"<name>\""
                % (f"{km:,.0f}" if km >= 10 else f"{km:.1f}", old_name, old_name,
                   name, name)})
    print("profiles: receiver moved %.1f km from %r; archived it and started %r"
          % (km, old_name, name), flush=True)
    return new


# ------------------------------------------------------------------ commands

def profile_summary(profiles, p):
    env_path = profiles.envelope_path(p)
    max_nm, cells = 0.0, 0
    try:
        with open(env_path, "r", encoding="utf-8") as fh:
            cells_doc = json.load(fh).get("cells", {})
        cells = len(cells_doc)
        max_nm = max((c.get("d", 0) for c in cells_doc.values()), default=0.0)
    except (OSError, ValueError):
        pass
    size = 0
    for dirpath, _, names in os.walk(profiles.dir(p)):
        for name in names:
            size += os.path.getsize(os.path.join(dirpath, name))
    return max_nm, cells, size


def fmt_date(t):
    return time.strftime("%Y-%m-%d", time.localtime(t)) if t else "-"


def receiver_position(args):
    lat, lon = getattr(args, "lat", None), getattr(args, "lon", None)
    if lat is not None and lon is not None:
        return {"lat": lat, "lon": lon}
    try:
        receiver = fetch_json(args.base_url.rstrip("/") + "/data/receiver.json")
        if receiver.get("lat") is not None:
            return {"lat": receiver["lat"], "lon": receiver["lon"]}
    except (urllib.error.URLError, OSError, ValueError):
        pass
    raise SystemExit("could not read the receiver's position from %s; give --lat "
                     "and --lon" % args.base_url)


def fetch_map(profiles, p, args):
    fetcher = getattr(args, "fetcher", None)
    if not fetcher:
        print("no map downloaded (no --fetcher given). Run: sudo range3d antenna map "
              "\"%s\"" % p["name"])
        return 1
    rx = p.get("rx") or {}
    if rx.get("lat") is None:
        raise SystemExit("%r has no recorded position to centre a map on" % p["name"])
    cmd = [sys.executable, fetcher, "--lat", str(rx["lat"]), "--lon", str(rx["lon"]),
           "--envelope", profiles.envelope_path(p),
           "--out-dir", profiles.tiles_dir(), "--meta", profiles.map_path(p)]
    if getattr(args, "radius_nm", None):
        cmd += ["--radius-nm", str(args.radius_nm)]
    print("downloading the map for %r" % p["name"], flush=True)
    import subprocess
    return subprocess.call(cmd)


def cmd_antenna(args):
    profiles = Profiles.open(args.root)
    action = args.action

    if action == "list":
        print("%-28s %-11s %-10s %-10s %8s %7s %6s %8s"
              % ("antenna", "status", "since", "until", "height", "range", "map", "size"))
        for p in profiles.profiles:
            max_nm, _cells, size = profile_summary(profiles, p)
            status = ("collecting" if p["slug"] == profiles.doc.get("collecting")
                      else "archived")
            height = ("%d ft" % p["antennaFt"]) if p.get("antennaFt") is not None else "-"
            has_map = "yes" if os.path.exists(profiles.map_path(p)) else "no"
            print("%-28s %-11s %-10s %-10s %8s %5.0fnm %6s %6.1fMB"
                  % (p["name"][:28], status, fmt_date(p.get("created")),
                     fmt_date(p.get("archived")), height, max_nm, has_map, size / 1e6))
        return 0

    if action == "new":
        rx = receiver_position(args)
        p = profiles.add(args.name, rx, args.height)
        profiles.save()
        write_status(profiles.root, profiles, clear_kinds=("moved",))
        print("started %r; it is collecting from now on" % p["name"])
        return fetch_map(profiles, p, args)

    if action == "use":
        p = profiles.need(args.name)
        if p["slug"] == profiles.doc.get("collecting"):
            print("%r is already collecting" % p["name"])
            return 0
        rx = p.get("rx") or {}
        if rx.get("lat") is not None and not args.force:
            here = receiver_position(args)
            far = haversine_nm(rx["lat"], rx["lon"], here["lat"], here["lon"])
            if far > MOVE_LIMIT_NM:
                raise SystemExit("%r was recorded %.1f km from where the receiver is "
                                 "now; collecting into it would mix two places. Use "
                                 "--force if that really is what you want."
                                 % (p["name"], far * 1.852))
        now = int(time.time())
        current = profiles.collecting
        if current is not None:
            current["archived"] = now
        p["archived"] = None
        profiles.doc["collecting"] = p["slug"]
        profiles.save()
        write_status(profiles.root, profiles, clear_kinds=("moved",))
        print("%r is collecting again; %r is archived"
              % (p["name"], current["name"] if current else "-"))
        return 0

    if action == "rename":
        p = profiles.need(args.name)
        if profiles.find(args.new_name) and profiles.find(args.new_name) is not p:
            raise SystemExit("there is already an antenna called %r" % args.new_name)
        old = p["name"]
        p["name"] = args.new_name
        profiles.save()
        write_status(profiles.root, profiles, clear_kinds=("moved",))
        print("renamed %r to %r" % (old, args.new_name))
        return 0

    if action == "height":
        p = profiles.need(args.name)
        p["antennaFt"] = args.feet
        profiles.save()
        env_path = profiles.envelope_path(p)
        if os.path.exists(env_path):
            env = Envelope.load(env_path)
            env.rx["altFt"] = args.feet
            env.save(env_path)
        print("%r: antenna height set to %g ft" % (p["name"], args.feet))
        return 0

    if action == "delete":
        p = profiles.need(args.name)
        if p["slug"] == profiles.doc.get("collecting"):
            raise SystemExit("%r is collecting; switch to another first with "
                             "`range3d antenna use`" % p["name"])
        typed = args.confirm
        if typed is None and sys.stdin.isatty():
            max_nm, cells, size = profile_summary(profiles, p)
            print("This permanently deletes %r: %d envelope cells, %.0f nm max range, "
                  "%.1f MB. It cannot be undone." % (p["name"], cells, max_nm, size / 1e6))
            typed = input("Type the antenna's name to confirm: ")
        if typed != p["name"]:
            raise SystemExit("not deleted: the name did not match")
        shutil.rmtree(profiles.dir(p), ignore_errors=True)
        profiles.profiles.remove(p)
        profiles.save()
        print("deleted %r" % p["name"])
        return 0

    if action == "map":
        p = profiles.need(args.name)
        return fetch_map(profiles, p, args)

    raise SystemExit("unknown antenna action %r" % action)


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
    if getattr(args, "profile_heat", None):
        return args.profile_heat
    return os.path.join(os.path.dirname(os.path.abspath(args.state)), "heatmap")


def use_profile(args, profiles, p):
    """Points the envelope, heatmap and antenna height at a profile's own."""
    args.state = profiles.envelope_path(p)
    args.profile_heat = profiles.heat_base(p)
    if p.get("antennaFt") is not None:
        args.rx_alt_ft = p["antennaFt"]


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

    # A receiver that has moved gets a new profile before anything is recorded,
    # so two places are never mixed into one envelope.
    profile = check_move(args.profiles, rx_lat, rx_lon)
    use_profile(args, args.profiles, profile)
    write_status(args.root, args.profiles)
    print("collecting into the antenna profile %r" % profile["name"], flush=True)

    env = Envelope.load_or_new(args.state, rx_lat, rx_lon, args.rx_alt_ft)
    print("state %s: %d cells, %d samples"
          % (args.state, len(env.cells), env.samples), flush=True)

    # The heatmap is written less often than the envelope: nobody watches it
    # second by second, and every write is wear on an SD card.
    heat = None
    heat_base = heatmap_base(args)
    if heat_base:
        heat = Heatmap.load_or_new(heat_base, rx_lat, rx_lon)
        print("heatmap %s: %d weeks, %d cells, %d passes"
              % (heat_base, len(heat.weeks), heat.filled(), heat.passes), flush=True)

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
    last_check = time.time()
    last_heat_save = time.time()
    backoff = 1.0
    records = 0
    records_saved = 0     # records already on disk
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
        if heat is not None:
            heat.roll(now)
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
                heat.record(rec["hex"], ac.get("r_dir", az_bin), range_nm, rec["alt"], fix_t)

        # Aircraft go away; their dedupe entries should not accumulate forever.
        if len(last_fix) > 4000:
            cutoff = now - 600
            last_fix = {k: v for k, v in last_fix.items() if v > cutoff}

        # The envelope is rewritten whole, a few MB each time, so it is written
        # only when it matters. Every --save-every it is checked: a new farthest
        # record since the last write is saved then, since records are the
        # envelope. Otherwise only hit counts and times have moved, and those
        # wait for --save-idle. On a mature envelope records are rare, which cuts
        # the writes to the SD card from one a minute to a few an hour.
        now_t = time.time()
        if now_t - last_check >= args.save_every:
            last_check = now_t
            fresh = records - records_saved
            if fresh or now_t - last_save >= args.save_idle:
                env.save(args.state)
                last_save = now_t
                records_saved = records
                print("saved: %d cells, %d samples, %d records set (%s)"
                      % (len(env.cells), env.samples, records,
                         "%d new" % fresh if fresh else "no new records; periodic save"),
                      flush=True)

        if heat is not None and time.time() - last_heat_save >= args.heatmap_every:
            heat.forget(now)
            heat.save()
            last_heat_save = time.time()
            print("heatmap saved: %d weeks, %d passes" % (len(heat.weeks), heat.passes),
                  flush=True)

        if deadline and time.time() >= deadline:
            break

        elapsed = time.time() - cycle_start
        if elapsed < args.interval:
            time.sleep(args.interval - elapsed)

    env.save(args.state)
    if heat is not None:
        heat.save()
    print("stopped: %d cells, %d samples%s"
          % (len(env.cells), env.samples,
             "" if heat is None else ", heatmap %d passes" % heat.passes),
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
    if base and os.path.isdir(base + "-weeks"):
        heat = Heatmap.load_or_new(base)
        total = HEAT_CELLS
        print()
        print("heatmap  %d of %d cells (%.1f%%), %s passes over %d weeks"
              % (heat.filled(), total, 100.0 * heat.filled() / total,
                 f"{heat.passes:,}", len(heat.weeks)))
        print("  band             cells   busiest cell")
        for b in range(HEAT_N_BANDS):
            lo, hi = HEAT_BAND_EDGES[b], HEAT_BAND_EDGES[b + 1]
            start = b * HEAT_SIZE * HEAT_SIZE
            chunk = heat.totals[start:start + HEAT_SIZE * HEAT_SIZE]
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
    collect.add_argument("--save-every", type=float, default=60.0,
                         help="seconds between checks for new records to save "
                              "(default: %(default)s)")
    collect.add_argument("--save-idle", type=float, default=1800.0,
                         help="with no new records, seconds before saving anyway, "
                              "for hit counts and times (default: %(default)s)")
    collect.add_argument("--heatmap-every", type=float, default=300.0,
                         help="seconds between heatmap saves (default: "
                              "%(default)s)")
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

    antenna = sub.add_parser("antenna", help="list, add and switch antenna profiles")
    actions = antenna.add_subparsers(dest="action", required=True)
    actions.add_parser("list", help="every antenna profile and which is collecting")
    new = actions.add_parser("new", help="archive the collecting antenna and start a "
                                         "new one here")
    new.add_argument("name")
    new.add_argument("--height", type=float, default=None,
                     help="antenna height above sea level, feet")
    use = actions.add_parser("use", help="collect into an archived antenna again")
    use.add_argument("name")
    use.add_argument("--force", action="store_true",
                     help="even if it was recorded somewhere else")
    rename = actions.add_parser("rename", help="rename an antenna")
    rename.add_argument("name")
    rename.add_argument("new_name")
    height = actions.add_parser("height", help="set an antenna's height")
    height.add_argument("name")
    height.add_argument("feet", type=float)
    delete = actions.add_parser("delete", help="permanently delete an archived antenna")
    delete.add_argument("name")
    delete.add_argument("--confirm", default=None,
                        help="the antenna's name again, instead of being asked")
    amap = actions.add_parser("map", help="download or refresh an antenna's map")
    amap.add_argument("name")
    for cmd in (new, use):
        cmd.add_argument("--lat", type=float, default=None,
                         help="receiver position, if receiver.json cannot be read")
        cmd.add_argument("--lon", type=float, default=None)
    for cmd in (new, amap):
        cmd.add_argument("--fetcher", default=None,
                         help="path to fetch-basemap.py, to download the map")
        cmd.add_argument("--radius-nm", type=float, default=None)
    antenna.set_defaults(func=cmd_antenna)

    args = parser.parse_args(argv)
    # Everything lives beside --state, now in one folder per antenna profile.
    args.root = os.path.dirname(os.path.abspath(args.state))
    if args.cmd != "antenna":
        args.profiles = Profiles.open(args.root)
        use_profile(args, args.profiles, args.profiles.collecting)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
