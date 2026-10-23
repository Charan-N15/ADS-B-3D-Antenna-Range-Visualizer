#!/bin/bash
# Install the ADS-B Antenna Range Visualizer alongside an existing tar1090 setup.
#
#   sudo ./install.sh
#
# Additive only. Nothing belonging to readsb or tar1090 is reconfigured, and nothing
# that serves live data is restarted. The one file of tar1090's this touches is
# html/config.js, which gets a link to the viewer appended; tar1090-update preserves
# that file, so the button survives updates.
#
# Safe to re-run: every step is idempotent, and an envelope already collecting here
# is never overwritten.
#
# Options:
#   --base-url URL     tar1090 base URL           (default http://localhost/tar1090)
#   --antenna-ft N     antenna height above sea level, feet
#   --radius-nm N      map and coverage radius    (default 250)
#   --zoom N           map tile zoom level        (default 8)
#   --no-basemap       skip downloading map tiles
#   --no-button        do not touch tar1090's config.js
#   --tar1090-html DIR override tar1090's html directory

set -euo pipefail

BASE_URL=http://localhost/tar1090
ANTENNA_FT=""
RADIUS_NM=250
ZOOM=8
WANT_BASEMAP=1
WANT_BUTTON=1
TAR1090_HTML=""

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

USER_NAME=range3d
STATE_DIR=/var/lib/range3d
STATE_FILE="$STATE_DIR/envelope.json"
WEB_DIR=/usr/local/share/range3d
BIN=/usr/local/bin/range3d_collect.py
UNIT_NAME=range3d-collector.service
UNIT=/etc/systemd/system/$UNIT_NAME
DEFAULTS=/etc/default/range3d
LIGHTTPD_CONF=/etc/lighttpd/conf-enabled/89-range3d.conf
BEGIN_MARK='// >>> range3d button'
END_MARK='// <<< range3d button'

die() { echo "error: $*" >&2; exit 1; }
say() { echo "==> $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2 ;;
    --antenna-ft) ANTENNA_FT="$2"; shift 2 ;;
    --radius-nm) RADIUS_NM="$2"; shift 2 ;;
    --zoom) ZOOM="$2"; shift 2 ;;
    --no-basemap) WANT_BASEMAP=0; shift ;;
    --no-button) WANT_BUTTON=0; shift ;;
    --tar1090-html) TAR1090_HTML="$2"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run with sudo"

# ----------------------------------------------------------------- prerequisites
command -v python3 >/dev/null || die "python3 is required"
command -v systemctl >/dev/null || die "this installer expects systemd"

BASE_URL="${BASE_URL%/}"
RECEIVER_JSON="$(curl -fsS --max-time 10 "$BASE_URL/data/receiver.json" 2>/dev/null || true)"
if [ -z "$RECEIVER_JSON" ]; then
  die "could not read $BASE_URL/data/receiver.json
     Is tar1090 running and reachable? If it is served from somewhere else, pass
     --base-url, for example: sudo ./install.sh --base-url http://localhost/tar1090"
fi

read -r RX_LAT RX_LON <<EOF
$(printf '%s' "$RECEIVER_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("lat",""), d.get("lon",""))')
EOF
[ -n "$RX_LAT" ] || die "receiver.json has no position.
     readsb needs --lat/--lon configured; without a receiver position there is no
     range to measure."
say "receiver at $RX_LAT, $RX_LON"

# ------------------------------------------------------------- collector service
if ! id -u "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$USER_NAME"
  say "created system user $USER_NAME"
fi

install -d -o "$USER_NAME" -g "$USER_NAME" -m 0755 "$STATE_DIR"
install -o root -g root -m 0755 "$SRC_DIR/collector/range3d_collect.py" "$BIN"

# The defaults file is the supported place to change settings; it is never
# overwritten once it exists, so upgrades keep your configuration.
if [ ! -f "$DEFAULTS" ]; then
  install -o root -g root -m 0644 "$SRC_DIR/systemd/range3d.default" "$DEFAULTS"
  sed -i "s|__BASE_URL__|$BASE_URL|" "$DEFAULTS"
  if [ -n "$ANTENNA_FT" ]; then
    sed -i "s|^#RANGE3D_ANTENNA_FT=.*|RANGE3D_ANTENNA_FT=\"--rx-alt-ft $ANTENNA_FT\"|" \
      "$DEFAULTS"
  fi
  say "wrote $DEFAULTS"
else
  say "keeping existing $DEFAULTS"
  if [ -n "$ANTENNA_FT" ]; then
    echo "    note: --antenna-ft ignored; edit $DEFAULTS to change it" >&2
  fi
fi

install -o root -g root -m 0644 "$SRC_DIR/systemd/$UNIT_NAME" "$UNIT"
systemctl daemon-reload
systemctl enable "$UNIT_NAME" >/dev/null

# Seed an empty envelope from tar1090's own range outline, so there is something to
# look at before any traffic has been observed. Never touches an existing one.
if [ ! -f "$STATE_FILE" ]; then
  if sudo -u "$USER_NAME" python3 "$BIN" --base-url "$BASE_URL" \
      --state "$STATE_FILE" seed-outline >/dev/null 2>&1; then
    say "seeded the envelope from tar1090's range outline"
  else
    say "no range outline to seed from; starting empty"
  fi
fi

systemctl restart "$UNIT_NAME"
say "collector running"

# ------------------------------------------------------------------------ basemap
if [ "$WANT_BASEMAP" -eq 1 ]; then
  if [ -f "$SRC_DIR/viewer/basemap/meta.json" ]; then
    say "map tiles already downloaded; skipping"
  else
    say "downloading map tiles (one time, a few hundred of them at most)"
    if python3 "$SRC_DIR/tools/fetch-basemap.py" \
        --lat "$RX_LAT" --lon "$RX_LON" \
        --radius-nm "$RADIUS_NM" --zoom "$ZOOM"; then
      say "map tiles stored in the repository"
    else
      echo "    map download failed; installing without a basemap." >&2
      echo "    Re-run tools/fetch-basemap.py later and re-run this installer." >&2
    fi
  fi
fi

# ------------------------------------------------------------------------- viewer
install -d -m 0755 "$WEB_DIR"
cp -r "$SRC_DIR/viewer/." "$WEB_DIR"/
find "$WEB_DIR" -type d -exec chmod 0755 {} +
find "$WEB_DIR" -type f -exec chmod 0644 {} +
say "installed the viewer into $WEB_DIR"

if [ -d /etc/lighttpd/conf-enabled ]; then
  cat > "$LIGHTTPD_CONF" <<CONF
# ADS-B Antenna Range Visualizer. Added by install.sh.

url.redirect += (
  "^/range3d\$" => "/range3d/"
)

alias.url += (
  "/range3d/state/" => "$STATE_DIR/",
  "/range3d/" => "$WEB_DIR/"
)

\$HTTP["url"] =~ "^/range3d/state/" {
    setenv.add-response-header += ( "Cache-Control" => "no-store" )
}
CONF

  # A broken config here would take tar1090 down with it, so test before reloading.
  if lighttpd -tt -f /etc/lighttpd/lighttpd.conf >/dev/null 2>&1; then
    systemctl reload lighttpd
    say "lighttpd reloaded; /range3d/ is being served"
  else
    rm -f "$LIGHTTPD_CONF"
    die "lighttpd rejected the new config, so it was removed and nothing changed.
     Run: lighttpd -tt -f /etc/lighttpd/lighttpd.conf"
  fi
else
  echo
  echo "    lighttpd was not found, so nothing is serving the viewer yet." >&2
  echo "    Point your web server at:" >&2
  echo "      /range3d/        -> $WEB_DIR/" >&2
  echo "      /range3d/state/  -> $STATE_DIR/" >&2
  WANT_BUTTON=0
fi

chmod 0755 "$STATE_DIR"

# -------------------------------------------------------------- tar1090 button
if [ "$WANT_BUTTON" -eq 1 ]; then
  if [ -z "$TAR1090_HTML" ]; then
    for candidate in /usr/local/share/tar1090/html /usr/share/tar1090/html; do
      [ -d "$candidate" ] && TAR1090_HTML="$candidate" && break
    done
  fi
  CONFIG_JS="$TAR1090_HTML/config.js"

  if [ -n "$TAR1090_HTML" ] && [ -f "$CONFIG_JS" ]; then
    cp -n "$CONFIG_JS" "$CONFIG_JS.range3d-backup" 2>/dev/null || true
    if grep -qF "$BEGIN_MARK" "$CONFIG_JS"; then
      sed -i "\|$BEGIN_MARK|,\|$END_MARK|d" "$CONFIG_JS"
    fi
    cat "$SRC_DIR/systemd/tar1090-button.js" >> "$CONFIG_JS"
    say "added the 3D button to tar1090"
  else
    echo "    tar1090's config.js not found; skipping the button." >&2
    echo "    The viewer still works at /range3d/." >&2
  fi
fi

HOST="$(hostname)"
echo
echo "Done."
echo "  viewer     http://$HOST/range3d/"
echo "  collector  systemctl status $UNIT_NAME"
echo "  settings   $DEFAULTS"
echo
if [ -z "$ANTENNA_FT" ] && ! grep -q '^RANGE3D_ANTENNA_FT' "$DEFAULTS" 2>/dev/null; then
  echo "  Set your antenna's height above sea level in $DEFAULTS to make the"
  echo "  theoretical horizon overlay meaningful, then: systemctl restart $UNIT_NAME"
  echo
fi
echo "  The envelope fills as aircraft fly through it. Low-altitude coverage takes"
echo "  days to appear, because distant low traffic is rare."
