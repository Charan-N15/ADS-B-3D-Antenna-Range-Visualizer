#!/usr/bin/env python3
"""HTTP front end for the range3d container.

Stands in for the lighttpd config install.sh writes on a Pi:

  /                  -> the viewer
  /state/envelope.json -> the collector's state file, never cached
  /tar1090/<path>    -> reverse-proxied to the tar1090 instance (e.g. ultrafeeder),
                        so the viewer's ../tar1090/data/aircraft.json and its
                        "Return to 2D" link both work from one origin

Standard library only.
"""

import argparse
import http.server
import os
import urllib.error
import urllib.request

# Request headers worth forwarding upstream, and response headers worth passing back.
# Everything else (hop-by-hop, Host, cookies) is dropped.
FORWARD_REQUEST = ("Accept", "Accept-Encoding", "If-None-Match", "If-Modified-Since",
                   "Range")
FORWARD_RESPONSE = ("Content-Type", "Content-Encoding", "Cache-Control", "ETag",
                    "Last-Modified", "Expires", "Content-Range", "Accept-Ranges")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Pass upstream redirects through to the browser instead of following them."""

    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


class Handler(http.server.SimpleHTTPRequestHandler):
    viewer_dir = "/app/viewer"
    state_file = "/data/envelope.json"
    upstream = "http://ultrafeeder"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=self.viewer_dir, **kwargs)

    # The viewer polls aircraft.json every second; log failures only.
    def log_request(self, code="-", size="-"):
        if isinstance(code, int) and code >= 400:
            super().log_request(code, size)

    def log_error(self, fmt, *args):
        pass    # log_request already records the failed request

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/state/envelope.json":
            return self.serve_state()
        if path == "/tar1090":
            return self.redirect("/tar1090/")
        if path.startswith("/tar1090/"):
            return self.proxy(self.path[len("/tar1090"):])
        return super().do_GET()

    def do_HEAD(self):
        if self.path.split("?", 1)[0].startswith(("/tar1090", "/state/")):
            self.send_error(405)
            return
        super().do_HEAD()

    def redirect(self, location):
        self.send_response(301)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def serve_state(self):
        try:
            with open(self.state_file, "rb") as fh:
                body = fh.read()
        except OSError:
            self.send_error(404, "no envelope yet; the collector writes one shortly")
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def proxy(self, rest):
        if ".." in rest.split("?", 1)[0]:
            self.send_error(400, "bad path")
            return
        req = urllib.request.Request(self.upstream.rstrip("/") + rest)
        for name in FORWARD_REQUEST:
            if self.headers.get(name):
                req.add_header(name, self.headers[name])
        try:
            resp = OPENER.open(req, timeout=15)
        except urllib.error.HTTPError as err:
            resp = err          # 304, 404 etc. still carry a usable response
        except (urllib.error.URLError, OSError) as exc:
            self.send_error(502, "tar1090 upstream: %s" % exc)
            return
        with resp:
            body = resp.read()
            self.send_response(resp.status)
            for name in FORWARD_RESPONSE:
                if resp.headers.get(name):
                    self.send_header(name, resp.headers[name])
            location = resp.headers.get("Location")
            if location:
                # Keep upstream-relative redirects inside /tar1090/.
                if location.startswith("/"):
                    location = "/tar1090" + location
                self.send_header("Location", location)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--upstream", default=Handler.upstream,
                        help="tar1090 base URL (default: %(default)s)")
    parser.add_argument("--viewer-dir", default=Handler.viewer_dir)
    parser.add_argument("--state", default=Handler.state_file)
    args = parser.parse_args()
    Handler.upstream = args.upstream
    Handler.viewer_dir = args.viewer_dir
    Handler.state_file = args.state

    server = http.server.ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print("serving viewer on :%d, tar1090 upstream %s" % (args.port, args.upstream),
          flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
