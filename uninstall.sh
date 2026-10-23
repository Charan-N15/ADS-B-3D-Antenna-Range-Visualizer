#!/bin/bash
# Remove the ADS-B Antenna Range Visualizer.
#
#   sudo ./uninstall.sh            keeps your collected data
#   sudo ./uninstall.sh --purge    removes it too
#
# The envelope in /var/lib/range3d is the one thing here that cannot be regenerated:
# it is months of observations that only accumulate in real time. So it is kept by
# default, and --purge is the only way to lose it.

set -euo pipefail

PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

USER_NAME=range3d
STATE_DIR=/var/lib/range3d
WEB_DIR=/usr/local/share/range3d
BIN=/usr/local/bin/range3d_collect.py
UNIT_NAME=range3d-collector.service
UNIT=/etc/systemd/system/$UNIT_NAME
DEFAULTS=/etc/default/range3d
LIGHTTPD_CONF=/etc/lighttpd/conf-enabled/89-range3d.conf
BEGIN_MARK='// >>> range3d button'
END_MARK='// <<< range3d button'

say() { echo "==> $*"; }

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }

if systemctl list-unit-files "$UNIT_NAME" >/dev/null 2>&1; then
  systemctl disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
fi
rm -f "$UNIT" "$BIN"
systemctl daemon-reload
say "collector stopped and removed"

rm -rf "$WEB_DIR"
say "viewer removed"

if [ -f "$LIGHTTPD_CONF" ]; then
  rm -f "$LIGHTTPD_CONF"
  if lighttpd -tt -f /etc/lighttpd/lighttpd.conf >/dev/null 2>&1; then
    systemctl reload lighttpd
    say "lighttpd reloaded"
  else
    echo "    lighttpd config is unhappy; check it before reloading" >&2
  fi
fi

for candidate in /usr/local/share/tar1090/html/config.js /usr/share/tar1090/html/config.js; do
  if [ -f "$candidate" ] && grep -qF "$BEGIN_MARK" "$candidate"; then
    sed -i "\|$BEGIN_MARK|,\|$END_MARK|d" "$candidate"
    say "removed the 3D button from $candidate"
  fi
done

if [ "$PURGE" -eq 1 ]; then
  rm -rf "$STATE_DIR"
  rm -f "$DEFAULTS"
  userdel "$USER_NAME" 2>/dev/null || true
  say "purged collected data, settings and the $USER_NAME user"
else
  echo
  echo "Kept:"
  echo "  $STATE_DIR   your collected coverage data"
  echo "  $DEFAULTS       your settings"
  echo "  the $USER_NAME system user"
  echo
  echo "Re-running install.sh will pick all of it back up."
  echo "Use --purge to remove it."
fi
