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
- systemd, lighttpd, and python3, or Docker (see [Docker](#docker))
- An internet connection once to download map tiles

## Install

```bash
git clone https://github.com/Charan-N15/ADS-B-3D-Antenna-Range-Visualizer.git
cd ADS-B-3D-Antenna-Range-Visualizer
sudo ./install.sh
```

That reads your receiver position from tar1090, installs a collector service, downloads map tiles for your area, installs the viewer, and adds a `3D` button to your tar1090 page.

Then open `http://your-pi/range3d/`, or click the `3D` button in tar1090.

## Docker

If your receiver runs in Docker, such as the [sdr-enthusiasts ultrafeeder](https://github.com/sdr-enthusiasts/docker-adsb-ultrafeeder) stack, run range3d as a container next to it instead of using `install.sh`. One container runs the collector and serves the viewer, and it also proxies tar1090 so the viewer's live aircraft and `RETURN TO 2D` link work from the same address.

Add it to the `docker-compose.yml` that runs tar1090:

```yaml
services:
  range3d:
    build: ./ADS-B-3D-Antenna-Range-Visualizer   # path to this repository
    image: range3d:local
    container_name: range3d
    restart: unless-stopped
    init: true
    depends_on:
      - ultrafeeder
    ports:
      - 8099:8080
    environment:
      - TAR1090_URL=http://ultrafeeder
      - PUID=1000
      - PGID=1000
      - RANGE3D_ANTENNA_FT=120
    volumes:
      - ./range3d:/data
```

```bash
docker compose up -d --build range3d
```

Then open `http://your-docker-host:8099/`.

On first start the container:

1. Seeds the envelope from tar1090's range outline.
2. Downloads map tiles for your area into `/data/basemap`, in the background. Reload the page once the log says `fetched`.
3. Starts collecting.

Restarts and rebuilds keep everything in `/data`.

### Settings

| Variable | Default | Purpose |
|---|---|---|
| `TAR1090_URL` | `http://ultrafeeder` | tar1090's base URL, reachable from the container. The collector reads `data/aircraft.json` under it. Use the compose service name, or a full URL such as `http://192.0.2.10/tar1090` for tar1090 on another host. |
| `PUID` / `PGID` | `1000` / `1000` | Owner of the files in `/data`. The container starts as root only to `chown` `/data`, then runs as this user. |
| `RANGE3D_ANTENNA_FT` | unset | Antenna height above sea level in feet (ground elevation plus mast). Only affects the theoretical-horizon overlay. If unset, the viewer assumes 100 ft. |
| `FEEDER_ALT_M` | unset | The same in metres, used when `RANGE3D_ANTENNA_FT` is unset. The ultrafeeder example `.env` already defines it, so you can pass `FEEDER_ALT_M=${FEEDER_ALT_M}`. |
| `RANGE3D_BASEMAP` | `1` | Set to `0` to skip downloading map tiles. |
| `RANGE3D_RADIUS_NM` | `250` | Map radius around the receiver. |
| `RANGE3D_ZOOM` | `8` | Map tile zoom level. 9 is four times the tiles and sharper close in. |
| `RANGE3D_INTERVAL` | `1` | Seconds between `aircraft.json` polls. |
| `RANGE3D_SAVE_EVERY` | `60` | Seconds between envelope saves. The envelope is also saved on `docker stop`. |

### Data

| Path | Contents |
|---|---|
| `/data/envelope.json` | The coverage envelope. This is the record of everything the receiver has heard and cannot be regenerated, so back it up. |
| `/data/basemap/` | Map tiles. Delete this directory and restart to re-download, for example after changing `RANGE3D_ZOOM`. |

### Endpoints

| Path | Serves |
|---|---|
| `/` | The viewer. |
| `/state/envelope.json` | The live envelope, uncached. |
| `/tar1090/` | A pass-through to `TAR1090_URL`, so the full 2D map is also reachable here. |

### Notes

- The `3D` button inside tar1090 is not added, because tar1090's files belong to the other container. Open the viewer directly or bookmark it.
- To move from a bare-metal install, copy `/var/lib/range3d/envelope.json` into the data directory before the first start. The container keeps an envelope it finds and never overwrites it.
- To update, run `git pull`, then `docker compose up -d --build range3d`.

## Configuration

For an `install.sh` install, settings live in `/etc/default/range3d` (for Docker, see [Settings](#settings)). The one worth setting is your antenna's height above sea level:

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
