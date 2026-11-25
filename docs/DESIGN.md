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

**Altitude:** non-uniform, 67 bands. Detail belongs low down, where the horizon is
doing the limiting:

| Range | Step | Bands |
|---|---|---|
| 0 – 2,000 ft | 250 ft | 8 |
| 2,000 – 10,000 ft | 500 ft | 16 |
| 10,000 – 53,000 ft | 1,000 ft | 43 |

67 bands × 360 bearings = 24,120 cells, most of them empty. The top reaches 53,000 ft,
over the 51,000 ft ceiling of the highest business jets; a report of exactly 53,000 ft
counts in the top band. The viewer draws the envelope only up to the highest band
anything has been heard in, on any bearing, so it never claims coverage above the
highest aircraft actually received.

Up to v1.2 the bands from 25,000 ft were 2,500 ft wide, ending at 50,000 ft. An older
state file is converted on first load: each cell keeps one record, its farthest
contact, with that contact's altitude, so cells from 25,000 ft up are re-filed under
the 1,000 ft band the contact was in. Nothing measured is lost; the other new bands
start without a record and fill as traffic is heard. The original file is kept
beside it.

### 2.3 Altitude source

`alt_geom` (GNSS, when present) in preference to `alt_baro`, because the geometry is
geometric and pressure altitude is not. `alt_baro` is the fallback and the source is
recorded per cell. `"ground"` is discarded.

### 2.4 Quality filters

One bad position decode would otherwise inflate an all-time cell permanently. In order:

- `type` must be `adsb_icao`, `adsb_icao_nt` or `adsb_other`. MLAT, Mode S and TIS-B
  positions are estimates, not receptions, and are dropped.
- `lat`/`lon` present; `nic >= 7`; `rc <= 1852` m when present.
- Range ≤ 350 NM, altitude ≤ 53,000 ft.
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

One JSON file, grown in place, written atomically (temp file + rename). It is checked
every 60 s and written only if a new farthest record has been set since the last write;
otherwise it waits up to 30 minutes, since only hit counts and times have changed. A
mature envelope sets few records, so this keeps a several-MB rewrite from happening
every minute on an SD card. An unclean shutdown can lose up to 30 minutes of hit
counts, never a record.
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

### 4.1 Heatmap

A second accumulator beside the envelope: where traffic flies, not how far it is
heard. A square grid of 2 NM cells reaching 350 NM from the receiver in each
direction, in nine coarse altitude bands up to 53,000 ft.

A count is a **pass**: one aircraft going through one cell. An aircraft adds one to
each cell it is heard in, and adds to the same cell again only after 30 minutes away
from it, so a holding pattern or a hovering helicopter counts once rather than once
a lap or once a second. Counting positions instead, as the first version did, made
slow and circling aircraft outweigh airliners many times over, and made routes at
the edge of coverage, heard every few seconds rather than every second, look far
quieter than they are.

The window is the last **26 weeks**, kept as one file per week (Monday to Sunday,
UTC) in `heatmap-weeks/YYYY-MM-DD.bin`, named for the Monday and holding only the
cells that week touched. The collector keeps the window's total in memory: the
current week adds to it, and a week falling out of the window is subtracted and its
file deleted, so the window steps forward a week at a time and spans 25 to 26 weeks.
Every five minutes it writes the current week and the total.

The total is what the viewer reads, as `heatmap.json` (grid, window, number of
passes) and `heatmap.bin`. Both day files and `heatmap.bin` are sparse: little-endian
uint32 `(cell, count)` pairs, with cell = `(band × size + y) × size + x`, y north up
and x east right. Most of the grid is empty, so the file is about a tenth of the
dense grid it describes.

A heatmap from the first version (dense uint16, counting positions) cannot be
converted, since its counts measure time rather than flights. The collector moves it
aside as `heatmap-v1.json`/`.bin` and starts a new one. The viewer reads both.

### 4.2 Antenna profiles

Each antenna setup is a **profile** with its own envelope, heatmap and map, a name, an
antenna height, the receiver position it was recorded at, and dates. One profile is
collecting; the rest are archived and stay viewable. Everything sits beside `--state`:

```
antennas.json                 the profiles, and which one is collecting
antennas/<slug>/              envelope.json, heatmap.*, heatmap-weeks/, map.json
maps/tiles/<z>/<x>/<y>.png    one tile cache shared by every profile's map
status.json                   warnings for the viewer, such as a receiver move
```

An install from before profiles has its files at the top level. On first run they are
moved into the profile **Antenna 1**, and links are left at the old names pointing into
whichever profile is collecting, so older viewers and servers keep working. Antenna 1
takes its height from the settings file as before; a profile's own height, once set,
takes precedence.

Profiles are changed only on the Pi, never from the browser, since anyone on the
network can open the viewer:

| `sudo range3d antenna ...` | |
|---|---|
| `list` | every profile, its dates, height, range, map and size |
| `new NAME [--height FT]` | archive the collecting profile and start a new one here, with its map |
| `use NAME` | collect into an archived profile again; refused if it was recorded elsewhere |
| `rename NAME NEW` | rename (the folder name stays) |
| `height NAME FT` | set a profile's antenna height |
| `delete NAME` | delete an archived profile; the name must be typed back |
| `map NAME` | download or refresh a profile's map |

Changes pause the collector for a moment; it reads the profiles when it starts.

**Moving.** At start the collector compares the receiver position readsb reports with
the collecting profile's. More than 1 km apart, it archives that profile untouched and
collects into a new one named for the date, and writes a warning to `status.json`. Two
places are never mixed into one envelope, and collecting never stops. The viewer shows
the warning as a banner until it is dismissed, and keeps it under Info.

**Viewer.** With more than one profile, a switcher sits above the panel. Choosing the
collecting profile follows it, including to a new one after a move. Live traffic is
drawn only on profiles at the receiver's current position. Each profile uses its own
map, or the installer's map when it is at the place that map was made for; otherwise
the viewer says how to download one.

## 5. Collector

`collector/range3d_collect.py`. Python 3, standard library only, no build step, no
dependencies to maintain on production infrastructure.

| Mode | Purpose |
|---|---|
| `collect` | Poll `aircraft.json` at 1 Hz, accumulate, save when a record is set (checked every 60 s) or every 30 min. SIGTERM saves cleanly. |
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
