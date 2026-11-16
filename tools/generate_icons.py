#!/usr/bin/env python3
"""Generates the ParaBene icons (16/48/128 px) without external libraries.

Motif: a white umbrella (protection) on a warm amber-to-coral background.
Usage:  python3 tools/generate_icons.py
"""
import math
import os
import struct
import zlib

SIZES = (16, 48, 128)
SUPERSAMPLE = 4
TOP_LEFT = (0xFF, 0xB5, 0x47)
BOTTOM_RIGHT = (0xF2, 0x70, 0x4E)
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")


def inside_rounded_square(x, y, radius):
    cx = min(max(x, radius), 1 - radius)
    cy = min(max(y, radius), 1 - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def inside_umbrella(x, y, size):
    stroke = max(0.03, 0.75 / size)
    cx, cy, r = 0.5, 0.52, 0.31

    # Canopy: upper half of a circle with a scalloped bottom edge.
    if y <= cy and (x - cx) ** 2 + (y - cy) ** 2 <= r ** 2:
        scallop_r = r / 3
        scallops = (cx - 2 * scallop_r, cx, cx + 2 * scallop_r)
        if not any((x - sx) ** 2 + (y - cy) ** 2 < scallop_r ** 2 for sx in scallops):
            return True

    # Tip on top.
    if abs(x - cx) <= stroke * 0.8 and cy - r - 0.045 <= y <= cy - r + 0.01:
        return True

    # Shaft.
    shaft_top, shaft_bottom = cy - 0.12, 0.75
    if abs(x - cx) <= stroke and shaft_top <= y <= shaft_bottom:
        return True

    # Handle: lower semicircle.
    hook_r = 0.075
    hx, hy = cx - hook_r, shaft_bottom
    if y >= hy:
        d = math.hypot(x - hx, y - hy)
        if abs(d - hook_r) <= stroke:
            return True
    return False


def render(size):
    rows = []
    corner = 0.22
    n = SUPERSAMPLE
    for py in range(size):
        row = bytearray([0])  # PNG filter: None
        for px in range(size):
            bg_hits = 0
            fg_hits = 0
            for sy in range(n):
                for sx in range(n):
                    x = (px + (sx + 0.5) / n) / size
                    y = (py + (sy + 0.5) / n) / size
                    if inside_rounded_square(x, y, corner):
                        bg_hits += 1
                        if inside_umbrella(x, y, size):
                            fg_hits += 1
            total = n * n
            alpha = bg_hits / total
            if alpha == 0:
                row += bytes((0, 0, 0, 0))
                continue
            t = ((px + 0.5) / size + (py + 0.5) / size) / 2
            base = [TOP_LEFT[i] + (BOTTOM_RIGHT[i] - TOP_LEFT[i]) * t for i in range(3)]
            white = fg_hits / bg_hits
            color = [round(c + (255 - c) * white) for c in base]
            row += bytes((*color, round(alpha * 255)))
        rows.append(bytes(row))
    return b"".join(rows)


def png_chunk(kind, data):
    chunk = kind + data
    return struct.pack(">I", len(data)) + chunk + struct.pack(">I", zlib.crc32(chunk) & 0xFFFFFFFF)


def write_png(path, size, pixels):
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    data = b"\x89PNG\r\n\x1a\n"
    data += png_chunk(b"IHDR", header)
    data += png_chunk(b"IDAT", zlib.compress(pixels, 9))
    data += png_chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(data)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.normpath(os.path.join(OUT_DIR, f"icon{size}.png"))
        write_png(path, size, render(size))
        print(f"saved {path}")


if __name__ == "__main__":
    main()
