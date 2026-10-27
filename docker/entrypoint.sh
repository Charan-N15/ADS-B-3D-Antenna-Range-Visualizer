#!/bin/bash
# Container entrypoint: the docker equivalent of install.sh plus the systemd unit.
#
# Every setting is an environment variable with a default that suits the usual
# sdr-enthusiasts ultrafeeder stack. See "Docker" in README.md for the full table.
#
#   TAR1090_URL          tar1090 base URL                    http://ultrafeeder
#   PUID / PGID          owner of everything under /data     1000 / 1000
#   RANGE3D_ANTENNA_FT   antenna height above sea level, ft  (unset)
#   FEEDER_ALT_M         the same in metres, used if the
#                        above is unset                      (unset)
#   RANGE3D_BASEMAP      0 skips the map tile download       1
#   RANGE3D_RADIUS_NM    map radius around the receiver      250
#   RANGE3D_ZOOM         map tile zoom level                 8
#   RANGE3D_INTERVAL     seconds between aircraft.json polls 1
#   RANGE3D_SAVE_EVERY   seconds between envelope saves      60

set -euo pipefail

TAR1090_URL="${TAR1090_URL:-http://ultrafeeder}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA=/data
STATE="$DATA/envelope.json"

say() { echo "range3d: $*"; }
die() { echo "range3d: error: $*" >&2; exit 1; }

is_number() { [[ "$1" =~ ^[0-9]+([.][0-9]+)?$ ]]; }

# /data is usually a bind mount that docker created as root. Hand it to PUID:PGID,
# then re-run this script unprivileged. If the container was started with --user,
# this is skipped and /data must already be writable by that user.
if [ "$(id -u)" -eq 0 ]; then
  [[ "$PUID" =~ ^[0-9]+$ && "$PGID" =~ ^[0-9]+$ ]] || die "PUID and PGID must be numeric"
  mkdir -p "$DATA/basemap"
  chown -R "$PUID:$PGID" "$DATA"
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$0" "$@"
fi

mkdir -p "$DATA/basemap" || die "$DATA is not writable by uid $(id -u)"

# Antenna height only drives the theoretical-horizon overlay; measured coverage
# does not depend on it.
ALT_ARGS=()
if [ -n "${RANGE3D_ANTENNA_FT:-}" ]; then
  is_number "$RANGE3D_ANTENNA_FT" || die "RANGE3D_ANTENNA_FT must be a number of feet"
  ALT_ARGS=(--rx-alt-ft "$RANGE3D_ANTENNA_FT")
elif [ -n "${FEEDER_ALT_M:-}" ]; then
  is_number "$FEEDER_ALT_M" || die "FEEDER_ALT_M must be a number of metres"
  ALT_ARGS=(--rx-alt-ft "$(python3 -c 'import sys; print(round(float(sys.argv[1]) * 3.28084))' "$FEEDER_ALT_M")")
fi
if [ ${#ALT_ARGS[@]} -gt 0 ]; then
  say "antenna height ${ALT_ARGS[1]} ft above sea level"
else
  say "antenna height not set; the viewer assumes 100 ft until you set it"
fi

COLLECT=(python3 /app/collector/range3d_collect.py
         --base-url "$TAR1090_URL" --state "$STATE" "${ALT_ARGS[@]}")

# Seed from tar1090's outline so there is something to look at straight away.
# Never touches an existing envelope.
if [ ! -f "$STATE" ]; then
  if "${COLLECT[@]}" seed-outline >/dev/null 2>&1; then
    say "seeded the envelope from tar1090's range outline"
  else
    say "no range outline to seed from; starting empty"
  fi
fi

# One-time tile download into /data/basemap, which viewer/basemap links to. It runs
# in the background so the viewer is reachable meanwhile; reload the page once it
# reports done.
if [ "${RANGE3D_BASEMAP:-1}" != "0" ] && [ ! -f "$DATA/basemap/meta.json" ]; then
  say "downloading map tiles in the background"
  ( python3 /app/tools/fetch-basemap.py --base-url "$TAR1090_URL" \
      --radius-nm "${RANGE3D_RADIUS_NM:-250}" --zoom "${RANGE3D_ZOOM:-8}" \
    || say "map download failed; restart the container to retry" ) &
fi

"${COLLECT[@]}" collect \
  --interval "${RANGE3D_INTERVAL:-1}" --save-every "${RANGE3D_SAVE_EVERY:-60}" &
COLLECTOR=$!

python3 /app/docker/range3d_server.py --port 8080 --upstream "$TAR1090_URL" \
  --state "$STATE" &
SERVER=$!

stop() {
  kill -TERM "$COLLECTOR" "$SERVER" 2>/dev/null || true
  wait "$COLLECTOR" 2>/dev/null || true     # the collector saves on SIGTERM
}

# docker stop: shut both down, let the collector save, exit cleanly.
trap 'stop; exit 0' TERM INT

# If either process dies on its own, take the other down too and exit non-zero so
# the restart policy brings the pair back.
set +e
wait -n "$COLLECTOR" "$SERVER"
status=$?
stop
exit $(( status == 0 ? 1 : status ))
