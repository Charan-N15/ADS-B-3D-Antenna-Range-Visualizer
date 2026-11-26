#!/usr/bin/env python3
"""Writes the viewer's icons from the pixel art below.

The logo is the envelope's bowl in the altitude colours, each band filled with
its own colour, and a plane seen from above in the middle, heading to the bottom
right. It is drawn twice, one character per pixel: 32 x 32 for the corner logo
and the home-screen icon, and a simpler 16 x 16 for the browser tab, where the
larger one's detail would only blur. Edit a grid and run this again:

  python tools/make-icons.py

Writes, into viewer/:
  favicon.svg            the tab icon (the 16 x 16 grid), crisp at any size
  favicon-32.png         the same, for browsers that want a bitmap
  logo.svg               the corner logo (the 32 x 32 grid)
  apple-touch-icon.png   180 x 180, for a phone's home screen

Standard library only. Every output pixel is one of a grid's, scaled up whole
with no smoothing.
"""

import os
import struct
import zlib

# 32 x 32: the corner logo and home-screen icon.
LOGO = [
    "................................",
    "................................",
    "................................",
    "mmMMMMMMMMMMMMMMMMMMMMMMMMMMMMmm",
    "mmMMMMMMMMMMMKMMMMMKKMMMMMMMMMmm",
    ".mmMMMMMMMMMKWKMMMKWWKMMMMMMMmm.",
    ".mmMMMMMMMMKWWKMMKWWKMMMMMMMMmm.",
    ".bbBBBBBBBKWWKBBKWWWKBBBBBBBBbb.",
    "..bbBBBBBKWWWWKBKWWWKBBBBBBBbb..",
    "..bbBBBBBBKKWWWKWWWWKBBBBBBBbb..",
    "...bbBBBBBBBKWWWWWWWKBBBBBBbb...",
    "...ccCCCCCCCCKWWWWWKCCCCCCCcc...",
    "...ccCCCCCCKKWWWWWWKCCCCCCCcc...",
    "....ccCCCCKWWWWWWWWWKCCCCCcc....",
    "....ggEEEKWWWWWWWWWWWKEEEEgg....",
    ".....ggEKWWWWWKKKKWWWKEEEgg.....",
    ".....ggEEKKKKKEEEEKWWWKEEgg.....",
    "......ggEEEEEEEEEEEKKKEEgg......",
    "......yyYYYYYYYYYYYYYYYYyy......",
    ".......yyYYYYYYYYYYYYYYyy.......",
    ".......yyYYYYYYYYYYYYYYyy.......",
    "........yyYYYYYYYYYYYYyy........",
    ".........ooOOOOOOOOOOoo.........",
    "..........ooOOOOOOOOoo..........",
    "...........ooOOOOOOoo...........",
    "............ooooooo.............",
    "................................",
    "................................",
    "....GGGGGGGGGGGGGGGGGGGGGGGG....",
    "................................",
    "................................",
    "................................",
]

# 16 x 16: the browser tab. The plane is placed by hand; at this size an
# outline would swallow it.
TAB = [
    "................",
    "................",
    "mMMMMMMMMMMMMMMm",
    ".mMMMWMMMMMMMMm.",
    ".bBBWWBBWBBBBBb.",
    ".bBBBBWBWBBBBBb.",
    "..cCCCCWWCCCCc..",
    "..gEEWWWWEEEEg..",
    "...gEEEEEWEEg...",
    "...yYYYYYYWYy...",
    "....yYYYYYYy....",
    ".....oOOOOo.....",
    "......oooo......",
    "................",
    "..GGGGGGGGGGGG..",
    "................",
]

# The bowl's walls in the altitude ramp, lower case, from the surface (orange)
# up to the top (magenta); its inside in the same colours dimmed toward the
# background, upper case. The plane in the UI's white with a near-black outline,
# the ground in its grey. "." is see-through.
COLOURS = {
    "o": "#ec6a24", "y": "#f0b41f", "g": "#5fcf3a",
    "c": "#3fb6d9", "b": "#4f5be6", "m": "#c33fe0",
    "O": "#6a3317", "Y": "#6b5215", "E": "#2e5d20",
    "C": "#215363", "B": "#282d68", "M": "#582166",
    "W": "#f2f3f5", "K": "#141518", "G": "#6b7078",
}

# Behind the home-screen icon, which phones show on a square: the viewer's own.
BACKGROUND = "#0b0b0d"

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "viewer")


def check(grid, size, name):
    assert len(grid) == size, "%s must be %d rows" % (name, size)
    for n, row in enumerate(grid):
        assert len(row) == size, "%s row %d is %d wide, not %d" % (name, n, len(row), size)
        for ch in row:
            assert ch == "." or ch in COLOURS, "%s row %d: no colour for %r" % (name, n, ch)


def rgb(hex_colour):
    return tuple(int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))


def write_svg(path, grid):
    size = len(grid)
    rects = []
    for y, row in enumerate(grid):
        x = 0
        while x < size:
            ch = row[x]
            if ch == ".":
                x += 1
                continue
            # Runs of one colour become one rectangle, to keep the file small.
            end = x
            while end + 1 < size and row[end + 1] == ch:
                end += 1
            rects.append('<rect x="%d" y="%d" width="%d" height="1" fill="%s"/>'
                         % (x, y, end - x + 1, COLOURS[ch]))
            x = end + 1
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" '
           'shape-rendering="crispEdges">\n%s\n</svg>\n' % (size, size, "\n".join(rects)))
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(svg)


def write_png(path, grid, scale, pad=0, background=None):
    """A grid with every pixel drawn scale x scale, inside an optional margin."""
    n = len(grid)
    size = n * scale + 2 * pad
    bg = rgb(background) + (255,) if background else (0, 0, 0, 0)
    raw = bytearray()
    for py in range(size):
        raw.append(0)   # no filter on this row
        for px in range(size):
            gx, gy = (px - pad) // scale, (py - pad) // scale
            inside = px >= pad and py >= pad and gx < n and gy < n
            ch = grid[gy][gx] if inside else "."
            raw.extend(rgb(COLOURS[ch]) + (255,) if ch != "." else bg)

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    check(LOGO, 32, "LOGO")
    check(TAB, 16, "TAB")
    write_svg(os.path.join(OUT, "favicon.svg"), TAB)
    write_png(os.path.join(OUT, "favicon-32.png"), TAB, 2)
    write_svg(os.path.join(OUT, "logo.svg"), LOGO)
    # 32 x 5 = 160, with 10 px of the viewer's background around it.
    write_png(os.path.join(OUT, "apple-touch-icon.png"), LOGO, 5, pad=10, background=BACKGROUND)
    print("wrote favicon.svg, favicon-32.png, logo.svg and apple-touch-icon.png into", OUT)


if __name__ == "__main__":
    main()
