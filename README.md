# ADS-B-3D-Antenna-Range-Visualizer

A visualizer to view the true range of your ADS-B antenna at different altitudes in 3D space. A single-button add-on to your current readsb/tar1090 setup.

![coverage envelope after three days of collection](docs/screenshot.png)

## Why

The current blue outline that tar1090 has is great for viewing your farthest possible range but doesn't really show at what altitude a plane was flying for your antenna to receive a signal from it. I live in an area surrounded by mountains and have an ADS-B setup with a DIY spider antenna, so my range is very different for 10 nautical miles vs 100 nautical miles out.

This map shows coverage as volume in 3D space rather than a polygon in 2D space to truly visualize that difference.

## Features

- Click a single button when viewing your local feed to start the 3D viewer
- Maximum range per 1° bearing and per altitude band, 49 bands from the surface to 50,000 ft, finest at low altitude where the horizon does the limiting
- Live aircraft from your antenna rendered inside the coverage envelope
- The same OpenStreetMap that tar1090 has so you can get a sense of where your range increases with an increase in altitude.
- Click any point on the surface to see the aircraft that set that record, with its altitude, signal strength and timestamp
- Save your view settings to the browser
- Per-cell hit counts, so a single bad position decode never permanently inflates your range


## Modes

**Orbit** - The coverage envelope as a surface you can spin

**Top** - Looking straight down, as you would in tar1090

**Slice** - A vertical cross-section along a bearing you pick. It splits the picture into three regions: coverage you have confirmed, coverage that is geometrically possible but you have not achieved, and everything below the horizon that should be impossible. The gap in the middle is your headroom.


## Requirements

- A working readsb or dump1090 receiver with tar1090 on top
- A configured receiver position
- systemd, lighttpd, and python3
- An internet connection once to download map tiles

## Install

```bash
git clone https://github.com/Charan-N15/ADS-B-3D-Antenna-Range-Visualizer.git
cd ADS-B-3D-Antenna-Range-Visualizer
sudo ./install.sh
```

That reads your receiver position from tar1090, installs a collector service, downloads map tiles for your area, installs the viewer, and adds a `3D` button to your tar1090 page.

Then open `http://your-pi/range3d/`, or click the `3D` button in tar1090.

## Configuration

Settings live in `/etc/default/range3d`. The one worth setting is your antenna's height above sea level:

```
RANGE3D_ANTENNA_FT="--rx-alt-ft 120"
```

That only affects the theoretical horizon overlay. Restart after editing it

```bash
sudo systemctl restart range3d-collector
```


## Updating

```bash
git pull
sudo ./install.sh
```

Collected data will not get rewritten if you run `install.sh` again

## Uninstall

```bash
sudo ./uninstall.sh --purge
```

## Credits

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL. Altitude colours match [tar1090](https://github.com/wiedehopf/tar1090). 3D rendering by [three.js](https://threejs.org/).

## Licence

MIT. See [LICENSE](LICENSE).
