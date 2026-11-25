#!/usr/bin/env python3
"""Fetch OpenStreetMap tiles covering the receiver's coverage area.

Downloads once into viewer/basemap/ and writes a meta.json describing the area
covered, so the viewer can compose the tiles into a texture itself. Keeping the
tiles local means the Pi needs no internet to draw the map, and means the tile
server sees one small burst rather than traffic every time the page is opened.

Tiles are stored as fetched. Nothing is executed from the download directory.

install.sh runs this for you. Run it by hand to change the zoom level or radius.

Usage:
  python tools/fetch-basemap.py --base-url http://localhost/tar1090 \
      --envelope /var/lib/range3d/envelope.json
  python tools/fetch-basemap.py --lat 51.48 --lon -0.45 --radius-nm 250 --zoom 9

By default the radius is the envelope's farthest edge plus 20%, so the map covers
what the receiver actually hears and no more, and the zoom is the sharpest that
fits that circle in the tile and texture limits. A 140 nm envelope gets zoom 9;
a 250 nm one zoom 8. With no envelope to read, the radius falls back to 250 nm.
Run it again as coverage grows: tiles already on disk are not fetched twice.
"""

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "viewer", "basemap")

# Identifying the client is a condition of the OSM tile usage policy.
USER_AGENT = "range3d-basemap/1 (ADS-B coverage viewer; one-time local cache)"

DEFAULT_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"

EARTH_RADIUS_NM = 3440.065

# Without an envelope to size it from, a radius that covers nearly any receiver.
DEFAULT_RADIUS_NM = 250.0

# How far past the envelope's farthest edge the map reaches, as a share of it.
EDGE_MARGIN = 0.2

# The viewer composes every tile into one texture. 4096 px a side is the most
# that every GPU it might run on, a Pi's included, can take without shrinking it.
MAX_TEXTURE_PX = 4096


def mercator_x(lon):
    return (lon + 180.0) / 360.0


def mercator_y(lat):
    p = math.radians(max(-85.05, min(85.05, lat)))
    return (1 - math.log(math.tan(p) + 1 / math.cos(p)) / math.pi) / 2


def destination(lat, lon, bearing_deg, dist_nm):
    p1, l1 = math.radians(lat), math.radians(lon)
    brg = math.radians(bearing_deg)
    ang = dist_nm / EARTH_RADIUS_NM
    sin_p2 = (math.sin(p1) * math.cos(ang)
              + math.cos(p1) * math.sin(ang) * math.cos(brg))
    p2 = math.asin(max(-1.0, min(1.0, sin_p2)))
    l2 = l1 + math.atan2(math.sin(brg) * math.sin(ang) * math.cos(p1),
                         math.cos(ang) - math.sin(p1) * sin_p2)
    return math.degrees(p2), (math.degrees(l2) + 540) % 360 - 180


def bounding_box(lat, lon, radius_nm):
    """Extremes of a circle of the given radius, sampled around the compass."""
    lats, lons = [], []
    for bearing in range(0, 360, 5):
        la, lo = destination(lat, lon, bearing, radius_nm)
        lats.append(la)
        lons.append(lo)
    return min(lats), max(lats), min(lons), max(lons)


def fetch(url, timeout=20.0):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def farthest_edge_nm(source):
    """The longest range anywhere in an envelope, from a path or a URL; None
    if there is no envelope there yet or it holds nothing."""
    try:
        if source.startswith(("http://", "https://")):
            raw = fetch(source)
        else:
            with open(source, "rb") as fh:
                raw = fh.read()
        cells = json.loads(raw).get("cells", {})
    except (OSError, ValueError, urllib.error.URLError) as exc:
        print("could not read the envelope at %s: %s" % (source, exc), file=sys.stderr)
        return None
    ranges = [cell.get("d", 0) for cell in cells.values()]
    return max(ranges) if ranges else None


def tile_span(lat, lon, radius_nm, zoom):
    """The tiles covering a circle: x0, x1, y0, y1, inclusive."""
    south, north, west, east = bounding_box(lat, lon, radius_nm)
    n = 2 ** zoom
    x0 = max(0, int(mercator_x(west) * n))
    x1 = min(n - 1, int(mercator_x(east) * n))
    y0 = max(0, int(mercator_y(north) * n))     # north is the smaller tile y
    y1 = min(n - 1, int(mercator_y(south) * n))
    return x0, x1, y0, y1


def fits(span, max_tiles):
    x0, x1, y0, y1 = span
    across, down = x1 - x0 + 1, y1 - y0 + 1
    return (across * down <= max_tiles
            and max(across, down) * 256 <= MAX_TEXTURE_PX)


def auto_zoom(lat, lon, radius_nm, max_tiles):
    """The sharpest zoom whose tiles fit both limits."""
    for zoom in range(12, 3, -1):
        if fits(tile_span(lat, lon, radius_nm, zoom), max_tiles):
            return zoom
    return 4


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--lat", type=float, default=None)
    parser.add_argument("--lon", type=float, default=None)
    parser.add_argument("--base-url", default=None,
                        help="tar1090 base URL to read receiver.json from")
    parser.add_argument("--radius-nm", default="auto",
                        help="map radius in nm, or 'auto' for the envelope's "
                             "farthest edge plus 20%% (default)")
    parser.add_argument("--envelope", default=None,
                        help="envelope.json path or URL to size the map from")
    parser.add_argument("--zoom", default="auto",
                        help="tile zoom level, or 'auto' for the sharpest that "
                             "fits (default)")
    parser.add_argument("--template", default=DEFAULT_TEMPLATE)
    parser.add_argument("--attribution", default="© OpenStreetMap contributors")
    parser.add_argument("--max-tiles", type=int, default=400,
                        help="refuse to download more than this many tiles")
    parser.add_argument("--delay", type=float, default=0.12,
                        help="seconds between requests")
    parser.add_argument("--force", action="store_true",
                        help="re-download tiles already present")
    parser.add_argument("--out-dir", default=OUT_DIR,
                        help="where tiles are stored, as <z>/<x>/<y>.png "
                             "(default: the viewer's basemap folder)")
    parser.add_argument("--meta", default=None,
                        help="where to write the map's meta.json "
                             "(default: inside --out-dir)")
    parser.add_argument("--dry-run", action="store_true",
                        help="work out the radius, zoom and tiles, then stop")
    args = parser.parse_args()

    lat, lon = args.lat, args.lon
    if lat is None or lon is None:
        if not args.base_url:
            parser.error("give --lat/--lon or --base-url")
        receiver = json.loads(fetch(args.base_url.rstrip("/") + "/data/receiver.json"))
        lat, lon = receiver["lat"], receiver["lon"]
        print("receiver position %.6f, %.6f" % (lat, lon))

    if args.radius_nm == "auto":
        edge = farthest_edge_nm(args.envelope) if args.envelope else None
        if edge:
            # Rounded up to the next 10 nm, so small growth does not move it.
            radius_nm = math.ceil(edge * (1 + EDGE_MARGIN) / 10) * 10
            print("envelope reaches %.1f nm; map radius %d nm" % (edge, radius_nm))
        else:
            radius_nm = DEFAULT_RADIUS_NM
            print("no envelope to size from; map radius %d nm" % radius_nm)
    else:
        radius_nm = float(args.radius_nm)

    zoom = (auto_zoom(lat, lon, radius_nm, args.max_tiles) if args.zoom == "auto"
            else int(args.zoom))
    x0, x1, y0, y1 = tile_span(lat, lon, radius_nm, zoom)
    across, down = x1 - x0 + 1, y1 - y0 + 1
    total = across * down

    print("zoom %d, %d x %d = %d tiles, texture %d x %d px"
          % (zoom, across, down, total, across * 256, down * 256))
    if total > args.max_tiles:
        print("that exceeds --max-tiles (%d); lower --zoom or --radius-nm"
              % args.max_tiles, file=sys.stderr)
        return 1
    if args.dry_run:
        return 0

    out_dir = args.out_dir
    meta_path = args.meta or os.path.join(out_dir, "meta.json")
    os.makedirs(out_dir, exist_ok=True)
    fetched = skipped = failed = 0
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            path = os.path.join(out_dir, str(zoom), str(x), "%d.png" % y)
            if os.path.exists(path) and not args.force:
                skipped += 1
                continue
            url = args.template.format(z=zoom, x=x, y=y)
            try:
                body = fetch(url)
            except (urllib.error.URLError, OSError) as exc:
                print("  %s failed: %s" % (url, exc), file=sys.stderr)
                failed += 1
                continue
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as fh:
                fh.write(body)
            fetched += 1
            time.sleep(args.delay)
        print("  column %d/%d" % (x - x0 + 1, across), flush=True)

    meta = {
        "zoom": zoom,
        "x0": x0, "x1": x1, "y0": y0, "y1": y1,
        "tileSize": 256,
        "center": {"lat": lat, "lon": lon},
        "radiusNm": radius_nm,
        "attribution": args.attribution,
        "fetched": int(time.time()),
    }
    os.makedirs(os.path.dirname(os.path.abspath(meta_path)), exist_ok=True)
    with open(meta_path + ".tmp", "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    os.replace(meta_path + ".tmp", meta_path)

    size = sum(os.path.getsize(os.path.join(dirpath, name))
               for dirpath, _, names in os.walk(out_dir) for name in names)
    print("fetched %d, already present %d, failed %d, %.1f MB on disk"
          % (fetched, skipped, failed, size / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
