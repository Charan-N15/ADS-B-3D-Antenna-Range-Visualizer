#!/usr/bin/env python3
"""Dev server for the range3d viewer.

Serves viewer/ at / and stands in for the two paths lighttpd provides on the Pi:

  /state/envelope.json      -> local data/envelope.json
  /tar1090/data/<file>      -> proxied from the receiver, which avoids the CORS
                               problem the hub already works around

Usage:
  python tools/devserver.py --receiver http://your-pi/tar1090

Point --receiver at any reachable tar1090 instance. The envelope is read from a
local copy; fetch one with:

  curl http://your-pi/range3d/state/envelope.json -o data/envelope.json
"""

import argparse
import http.server
import os
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIEWER_DIR = os.path.join(ROOT, "viewer")
STATE_FILE = os.path.join(ROOT, "data", "envelope.json")


class Handler(http.server.SimpleHTTPRequestHandler):
    receiver = "http://localhost/tar1090"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=VIEWER_DIR, **kwargs)

    def log_message(self, fmt, *args):
        if "404" in (fmt % args):
            super().log_message(fmt, *args)

    def do_GET(self):
        path = self.path.split("?", 1)[0]

        if path == "/state/envelope.json":
            return self.serve_state()
        if path.startswith("/tar1090/data/"):
            return self.proxy(path[len("/tar1090/data/"):])
        return super().do_GET()

    def serve_state(self):
        try:
            with open(STATE_FILE, "rb") as fh:
                body = fh.read()
        except OSError as exc:
            self.send_error(404, "no local envelope: %s" % exc)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def proxy(self, name):
        if "/" in name or ".." in name:
            self.send_error(400, "bad path")
            return
        url = "%s/data/%s" % (self.receiver.rstrip("/"), name)
        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                body = resp.read()
                ctype = resp.headers.get("Content-Type", "application/json")
        except (urllib.error.URLError, OSError) as exc:
            self.send_error(502, "upstream: %s" % exc)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8099)
    parser.add_argument("--receiver", default=Handler.receiver)
    args = parser.parse_args()
    Handler.receiver = args.receiver

    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("viewer   http://127.0.0.1:%d/" % args.port)
    print("state    %s" % STATE_FILE)
    print("receiver %s" % args.receiver, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
