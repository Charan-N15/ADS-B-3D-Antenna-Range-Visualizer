#!/usr/bin/env python3
"""Fetch OpenStreetMap tiles covering the receiver's coverage area.

Downloads once into viewer/basemap/ and writes a meta.json describing the area
covered, so the viewer can compose the tiles into a texture itself. Keeping the
tiles local means the Pi needs no internet to draw the map, and means the tile
server sees one small burst rather than traffic every time the page is opened.

Tiles are stored as fetched. Nothing is executed from the download directory.

install.sh runs this for you. Run it by hand to change the zoom level or radius.

Usage:
  python tools/fetch-basemap.py --base-url http://localhost/tar1090
  python tools/fetch-basemap.py --lat 51.48 --lon -0.45 --radius-nm 250 --zoom 9

Zoom 8 covers a 250 nm radius in about 70 tiles and is enough to read coastlines
and major roads. Zoom 9 is four times the tiles and noticeably sharper close in.
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


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--lat", type=float, default=None)
    parser.add_argument("--lon", type=float, default=None)
    parser.add_argument("--base-url", default=None,
                        help="tar1090 base URL to read receiver.json from")
    parser.add_argument("--radius-nm", type=float, default=250.0)
    parser.add_argument("--zoom", type=int, default=8)
    parser.add_argument("--template", default=DEFAULT_TEMPLATE)
    parser.add_argument("--attribution", default="© OpenStreetMap contributors")
    parser.add_argument("--max-tiles", type=int, default=400,
                        help="refuse to download more than this many tiles")
    parser.add_argument("--delay", type=float, default=0.12,
                        help="seconds between requests")
    parser.add_argument("--force", action="store_true",
                        help="re-download tiles already present")
    args = parser.parse_args()

    lat, lon = args.lat, args.lon
    if lat is None or lon is None:
        if not args.base_url:
            parser.error("give --lat/--lon or --base-url")
        receiver = json.loads(fetch(args.base_url.rstrip("/") + "/data/receiver.json"))
        lat, lon = receiver["lat"], receiver["lon"]
        print("receiver position %.6f, %.6f" % (lat, lon))

    south, north, west, east = bounding_box(lat, lon, args.radius_nm)
    n = 2 ** args.zoom
    x0 = int(mercator_x(west) * n)
    x1 = int(mercator_x(east) * n)
    y0 = int(mercator_y(north) * n)     # north is the smaller tile y
    y1 = int(mercator_y(south) * n)

    x0, x1 = max(0, x0), min(n - 1, x1)
    y0, y1 = max(0, y0), min(n - 1, y1)
    across, down = x1 - x0 + 1, y1 - y0 + 1
    total = across * down

    print("zoom %d, %d x %d = %d tiles, texture %d x %d px"
          % (args.zoom, across, down, total, across * 256, down * 256))
    if total > args.max_tiles:
        print("that exceeds --max-tiles (%d); lower --zoom or --radius-nm"
              % args.max_tiles, file=sys.stderr)
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    fetched = skipped = failed = 0
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            path = os.path.join(OUT_DIR, str(args.zoom), str(x), "%d.png" % y)
            if os.path.exists(path) and not args.force:
                skipped += 1
                continue
            url = args.template.format(z=args.zoom, x=x, y=y)
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
        "zoom": args.zoom,
        "x0": x0, "x1": x1, "y0": y0, "y1": y1,
        "tileSize": 256,
        "center": {"lat": lat, "lon": lon},
        "radiusNm": args.radius_nm,
        "attribution": args.attribution,
        "fetched": int(time.time()),
    }
    with open(os.path.join(OUT_DIR, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)

    size = sum(os.path.getsize(os.path.join(dirpath, name))
               for dirpath, _, names in os.walk(OUT_DIR) for name in names)
    print("fetched %d, already present %d, failed %d, %.1f MB on disk"
          % (fetched, skipped, failed, size / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
