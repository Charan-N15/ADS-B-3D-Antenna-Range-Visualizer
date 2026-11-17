#!/usr/bin/env python3
"""Dev server for the range3d viewer: edit a file, save, the page reloads.

Serves viewer/ at / and stands in for the paths lighttpd provides on the Pi:

  /state/<file>          the collector's envelope and heatmap: from data/ when a
                         local copy is there, otherwise proxied from the receiver
  /tar1090/<path>        proxied: live traffic, and the aircraft database the
                         viewer reads types from. Same origin as the viewer, which
                         avoids the CORS problem of talking to the Pi directly

Usage:
  python tools/devserver.py --receiver http://your-pi/tar1090

Then open http://127.0.0.1:8099/ and edit anything under viewer/. Saving
triggers a reload in the browser.

Nothing here runs on the Pi; install.sh does not copy it.
"""

import argparse
import http.server
import os
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIEWER_DIR = os.path.join(ROOT, "viewer")
STATE_DIR = os.path.join(ROOT, "data")

# What the collector writes beside its envelope, and how each is served.
STATE_FILES = {
    "envelope.json": "application/json",
    "heatmap.json": "application/json",
    "heatmap.bin": "application/octet-stream",
}

WATCH_SUFFIXES = (".html", ".css", ".js")
# The vendored library never changes and the tiles are hundreds of files;
# walking them on every poll would cost more than the watch is worth.
WATCH_SKIP = ("vendor", "basemap")

RELOAD_CLIENT = b"""
// Injected by tools/devserver.py. Polls for a newer mtime under viewer/ and
// reloads when one appears. Never served by the real install.
(function () {
    var seen = 0;
    function poll() {
        fetch('/__changed', { cache: 'no-store' })
            .then(function (r) { return r.text(); })
            .then(function (text) {
                var stamp = Number(text);
                if (seen && stamp > seen) { location.reload(); return; }
                seen = stamp;
                setTimeout(poll, 500);
            })
            .catch(function () { setTimeout(poll, 2000); });
    }
    poll();
})();
"""


def newest_mtime():
    newest = 0.0
    for dirpath, dirnames, filenames in os.walk(VIEWER_DIR):
        dirnames[:] = [d for d in dirnames if d not in WATCH_SKIP]
        for name in filenames:
            if name.endswith(WATCH_SUFFIXES):
                try:
                    newest = max(newest, os.path.getmtime(os.path.join(dirpath, name)))
                except OSError:
                    pass
    return newest


class Handler(http.server.SimpleHTTPRequestHandler):
    receiver = "http://localhost/tar1090"
    state_url = None    # the receiver's /range3d/state/, for files not in data/

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=VIEWER_DIR, **kwargs)

    def log_message(self, fmt, *args):
        message = fmt % args
        if "404" in message or "500" in message:
            super().log_message(fmt, *args)

    def end_headers(self):
        # A cached stylesheet or module silently renders the previous version of
        # the viewer while the source on disk has already moved on. Nothing about
        # a dev server benefits from caching, so switch it off everywhere.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]

        if path == "/__changed":
            return self.send_body(b"%.3f" % newest_mtime(), "text/plain")
        if path == "/__livereload.js":
            return self.send_body(RELOAD_CLIENT, "text/javascript")
        if path in ("/", "/index.html"):
            return self.serve_index()
        if path.startswith("/state/") and path[len("/state/"):] in STATE_FILES:
            return self.serve_state(path[len("/state/"):])
        if path.startswith("/tar1090/"):
            return self.proxy(path[len("/tar1090/"):])
        return super().do_GET()

    def send_body(self, body, ctype, status=200, encoding=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_index(self):
        """index.html with the reload client appended.

        Injected here rather than written into the file so the page in the
        repository stays exactly what gets installed on the Pi.
        """
        try:
            with open(os.path.join(VIEWER_DIR, "index.html"), "rb") as fh:
                page = fh.read()
        except OSError as exc:
            self.send_error(404, "no index.html: %s" % exc)
            return
        tag = b'<script src="/__livereload.js"></script>\n</body>'
        page = page.replace(b"</body>", tag, 1)
        self.send_body(page, "text/html; charset=utf-8")

    def serve_state(self, name):
        """Local snapshot if there is one, otherwise straight from the receiver."""
        ctype = STATE_FILES[name]
        try:
            with open(os.path.join(STATE_DIR, name), "rb") as fh:
                return self.send_body(fh.read(), ctype)
        except OSError:
            pass
        if not self.state_url:
            self.send_error(404, "no local %s and no receiver to fetch it from" % name)
            return
        try:
            url = urllib.parse.urljoin(self.state_url, name)
            with urllib.request.urlopen(url, timeout=20) as resp:
                body = resp.read()
        except (urllib.error.URLError, OSError) as exc:
            self.send_error(502, "%s upstream: %s" % (name, exc))
            return
        self.send_body(body, ctype)

    def proxy(self, rest):
        # tar1090 serves its database pre-gzipped and says so in a header; the
        # body is passed on still compressed, so the header has to go with it.
        if ".." in rest or "\\" in rest:
            self.send_error(400, "bad path")
            return
        url = "%s/%s" % (self.receiver.rstrip("/"), rest)
        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                body = resp.read()
                ctype = resp.headers.get("Content-Type", "application/octet-stream")
                encoding = resp.headers.get("Content-Encoding")
        except (urllib.error.URLError, OSError) as exc:
            self.send_error(502, "upstream: %s" % exc)
            return
        self.send_body(body, ctype, encoding=encoding)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8099)
    parser.add_argument("--receiver", default=Handler.receiver,
                        help="tar1090 base URL (default: %(default)s)")
    parser.add_argument("--envelope", default=None,
                        help="envelope URL to fall back on when there is no "
                             "local data/envelope.json (default: derived from "
                             "--receiver)")
    args = parser.parse_args()

    Handler.receiver = args.receiver
    envelope_url = args.envelope or urllib.parse.urljoin(
        args.receiver.rstrip("/") + "/", "../range3d/state/envelope.json")
    # Everything the collector writes sits beside the envelope.
    Handler.state_url = urllib.parse.urljoin(envelope_url, ".")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("viewer    http://127.0.0.1:%d/" % args.port)
    print("receiver  %s" % args.receiver)
    for name in ("envelope.json", "heatmap.bin"):
        local = os.path.join(STATE_DIR, name)
        print("%-9s %s" % (name.split(".")[0], local if os.path.exists(local)
                                               else Handler.state_url + name))
    print("watching  %s for changes" % VIEWER_DIR)
    print("edit and save anything under viewer/ and the page will reload",
          flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
