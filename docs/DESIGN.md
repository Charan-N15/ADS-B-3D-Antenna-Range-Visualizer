# range3d — altitude-resolved coverage envelope

A 3D view of what an ADS-B receiver can actually hear, as a function of bearing
*and* altitude. Installs alongside an existing tar1090 setup and is reachable from a
button in the tar1090 UI.

This document is the design rationale. For setup, see the README.

## 1. The problem with the blue outline

tar1090 serves `data/outline.json`: 360 points, one per degree of bearing, each the
farthest contact seen in the last 24 h, carried with the altitude of that contact.
Measured on the receiver this was built against:

- 360 record-holding contacts, altitudes 400 ft to 47,025 ft
- **332 of 360 are above 5,000 ft**

So the outline is close to a 36,000 ft contour being presented as "range". It answers
"how far have I ever heard anything", which is a single number dressed up as a shape.
It cannot answer the question that matters for antenna work: *at 3,000 ft, how far out
does my coverage actually reach, and on which bearings?*

## 2. What gets measured

For each 1° azimuth bin and each altitude band, the maximum **ground range** at which
a position was received. Stored raw, with no smoothing or interpolation.

Read the other way around, the same array is the **coverage floor**: for a bearing and
a ground range, the lowest altitude ever received there. That is the surface the viewer
draws — a bowl, near zero overhead, rising with distance, pushed higher on bearings
where terrain blocks the path.

### 2.1 Monotonicity

Coverage is monotone **upward** in altitude and **inward** in range.

A contact at 1,000 ft / 50 NM proves coverage at 50 NM for every altitude *above*
1,000 ft. It proves nothing about 500 ft at 50 NM, which is probably below the horizon
there. Low altitude is the hard case; the geometric horizon is what limits it.

The closure is therefore

```
R_closed(az, band) = max( R_raw(az, j) for all j <= band )
```

applied at render time, not at write time, so the stored data stays a record of
observations rather than inferences. The viewer can toggle it off.

### 2.2 Bins

**Azimuth:** 1°, bin = `floor(bearing_true)`, 360 bins. Rendered with an adjustable
boxcar smooth, default 5°, because single degrees are sparse at low altitude.

**Altitude:** non-uniform, 49 bands. Detail belongs low down, where the horizon is
doing the limiting:

| Range | Step | Bands |
|---|---|---|
| 0 – 2,000 ft | 250 ft | 8 |
| 2,000 – 10,000 ft | 500 ft | 16 |
| 10,000 – 25,000 ft | 1,000 ft | 15 |
| 25,000 – 50,000 ft | 2,500 ft | 10 |

49 bands × 360 bearings = 17,640 cells, most of them empty.

### 2.3 Altitude source

`alt_geom` (GNSS, when present) in preference to `alt_baro`, because the geometry is
geometric and pressure altitude is not. `alt_baro` is the fallback and the source is
recorded per cell. `"ground"` is discarded.

### 2.4 Quality filters

One bad position decode would otherwise inflate an all-time cell permanently. In order:

- `type` must be `adsb_icao`, `adsb_icao_nt` or `adsb_other`. MLAT, Mode S and TIS-B
  positions are estimates, not receptions, and are dropped.
- `lat`/`lon` present; `nic >= 7`; `rc <= 1852` m when present.
- Range ≤ 350 NM, altitude ≤ 52,000 ft.
- Each position is counted once. Fix time is `now - seen_pos` from the feed; a hex is
  only accepted when its fix time advances, so a 1 Hz poll of a stale record does not
  inflate the hit count.
- Every cell carries a hit count and first/last timestamps. The viewer ignores cells
  with a single hit by default, so an uncorroborated freak decode never shapes the
  surface.

## 3. Theoretical horizon overlay

Line of sight over a 4/3-radius earth, in nautical miles with heights in feet:

```
d_nm = 1.23 * ( sqrt(h_rx_ft) + sqrt(h_ac_ft) )
```

Drawn as a reference surface against the measured one. The gap between them is the
interesting part: it is antenna pattern, receiver sensitivity and terrain, separated
out from pure geometry.

`h_rx_ft` is antenna height above sea level and must be configured; it cannot be
measured remotely. At 100 ft it predicts 245 NM for a 36,000 ft target, against a
measured outline reaching roughly 130 NM — so there is real headroom to explain.

Terrain masking from a 30 m DEM is deliberately out of scope for v1. It is the obvious
next layer, since to the north and east terrain is almost certainly the limit.

## 4. Storage

One JSON file, grown in place, written atomically (temp file + rename) every 60 s.
All-time only; no per-day buckets.

```jsonc
{
  "version": 1,
  "rx": { "lat": 51.4775, "lon": -0.4614, "altFt": null },
  "bandEdges": [0, 250, 500, "..."],
  "created": 1792730171,
  "updated": 1792744000,
  "samples": 418233,
  "cells": {
    "196,24": {                  // azimuth bin, altitude band
      "d": 55.93,                // max ground range, NM
      "n": 37,                   // accepted positions in this cell
      "t0": 1792730171,
      "t1": 1792743910,
      "rec": { "hex": "a972ee", "t": 1792730171, "lat": 51.1234, "lon": -0.9876, "alt": 36550, "src": "geom",
               "rssi": -24.8, "nic": 8 }
    }
  }
}
```

Keeping `rec` means any point on the rendered surface can name the aircraft that set
it, with a timestamp and signal level. The data stays auditable, which matters when a
cell looks too good to be true. Worst case the file is about 2 MB; in practice far less,
and it gzips well.

## 5. Collector

`collector/range3d_collect.py`. Python 3, standard library only, no build step, no
dependencies to maintain on production infrastructure.

| Mode | Purpose |
|---|---|
| `collect` | Poll `aircraft.json` at 1 Hz, accumulate, save every 60 s. SIGTERM saves cleanly. |
| `seed-outline` | Fold `outline.json`'s 360 last-24h points into an envelope as a baseline. Real contacts, so honest to include. |
| `merge` | Cell-wise merge of two state files. Used to carry locally collected data onto the Pi. |
| `stats` | Print coverage summary: cells filled, range by band, measured against theoretical. |

`tools/fetch-basemap.py` downloads the map tiles. They are **not** in git — third-party
raster data that one command regenerates — so a fresh clone needs this before
installing the viewer, or it installs without a map:

```
python tools/fetch-basemap.py --base-url http://localhost/tar1090
```

Runs as its own systemd unit under its own user, reading `aircraft.json` over
localhost. It does not touch readsb or tar1090 configuration and restarts nothing that
serves live data.

## 6. Viewer

`viewer/`, three.js vendored, plain ES modules, no bundler.

**Frame.** Local east-north-up, centred on the receiver, units of nautical miles.
Earth curvature drop `d² / (2kR)` applied to the ground plane so the bowl is
geometrically true rather than suggestive. Vertical exaggeration slider, default 8× —
250 NM across against 40,000 ft is 6.6 NM tall and unreadable at 1:1.

**Layers,** each independently toggleable:

0. OpenStreetMap on the ground. The tiles are Web Mercator and the scope is azimuthal
   equidistant, so rather than reconcile the two the ground is built as a disc in
   bearing and range — the same frame as the range rings — with each vertex carrying
   the UV of its own latitude and longitude. The map is warped into the scope's
   projection, so a range ring crosses the coastline exactly where it really does.
   Tiles are fetched once by `tools/fetch-basemap.py` and stored locally, so the Pi
   needs no internet and the tile server sees one small burst rather than traffic on
   every page load.

   They are darkened and mostly desaturated before use. The one subtlety: OSM renders
   land at #f2efe9 and water at #aad3df — luminance 239 against 231, separated by hue
   alone. Desaturating naively erases the coastline, which on a coastal receiver is
   the most useful landmark on the map, so water is detected by its blueness and
   pushed down hard while everything else just dims.
1. Range rings and bearing spokes at tar1090's steps.
2. Stacked contour rings — the measured outline repeated at 2k, 5k, 10k, 20k, 30k,
   40k ft, each at its true height. This is the default, and it is the familiar blue
   outline turned into a stack.
3. Coverage floor as a wireframe bowl over the azimuth × range grid.
4. Theoretical horizon as a second, dimmer reference surface.
5. Live aircraft at true 3D positions, each with a thin drop line to the ground plane
   and a shadow tick. The drop lines are what make a 3D scatter readable.

**Views.** Orbit, top-down (degenerates to something tar1090-shaped, deliberately),
and a profile slice along a selected bearing showing measured floor against theoretical
horizon in cross-section. The slice is expected to be the most useful panel here for
antenna work.

**Colour.** Altitude drives colour, using tar1090's own ramp so the two tools agree:
orange near the surface through yellow and green to blue and magenta at the top. The
table and the interpolation in `altitude.js` are taken from this receiver's install —
the ramp lives in tar1090's `defaults_*.js`, since the copy in `config.js` sits inside
a block comment and is inactive. Hue is piecewise-linear in altitude, lightness
piecewise-linear in the resulting hue, saturation fixed at 88.

tar1090 rounds altitude to 50/200/500 ft before picking a colour, to limit how many
marker images it caches. That is a rendering optimisation rather than part of the
ramp, and rounding would band a smooth surface, so it is not reproduced. The narrowest
altitude band here is 250 ft, well above tar1090's own rounding, so nothing visible
changes.

The ramp drives the envelope surface and its wire (per-vertex), the altitude rings
(per ring), live traffic, and the slice staircase. `colour by altitude` turns it off
and returns everything to the monochrome blue, which stays the better choice when
reading shape rather than height.

**Everything else.** tar1090's dark background, grey and white furniture, flat fills,
no gradients, no glow.

## 7. Integration with tar1090

`tar1090-update` overwrites `/usr/local/share/tar1090/html`, so nothing of value is
placed there.

- The viewer is served from its own directory via a lighttpd alias, at `/range3d/`.
- One button is injected into the tar1090 UI by a small idempotent patch script, safe
  to re-run after every tar1090 update.
- The collector's state file is served read-only from the same alias.

## 8. Open points

1. Antenna height above sea level — required for the horizon overlay.
2. Whether readsb is writing globe history to disk. If it is, months of past contacts
   can be folded in at once instead of starting from an empty envelope. Needs shell
   access to check.
