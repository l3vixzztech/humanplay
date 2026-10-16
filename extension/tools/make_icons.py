#!/usr/bin/env python3
"""Generate the humanplay extension icons (pure stdlib, no deps, reproducible).

Design: dark rounded square with a 2x2 chessboard (lichess browns) in the middle.
Rendered with 8x8 supersampling and box-downfiltered to each icon size.

Run:
    python3 extension/tools/make_icons.py            # writes extension/icons/icon{16,32,48,128}.png
    python3 extension/tools/make_icons.py --out DIR   # custom output directory
"""

from __future__ import annotations

import argparse
import struct
import zlib
from pathlib import Path

SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 8

BACKGROUND = (27, 31, 39, 255)  # #1b1f27
BOARD_LIGHT = (240, 217, 181, 255)  # #f0d9b5 (lichess light square)
BOARD_DARK = (181, 136, 99, 255)  # #b58863 (lichess dark square)

CORNER_RADIUS = 0.18
BOARD_MARGIN = 0.17


def sample(u: float, v: float) -> tuple[int, int, int, int]:
    """Color at normalized position (u, v) in [0, 1] x [0, 1]."""
    # Rounded-square mask.
    r = CORNER_RADIUS
    if not (0.0 <= u <= 1.0 and 0.0 <= v <= 1.0):
        return (0, 0, 0, 0)
    cx = min(max(u, r), 1.0 - r)
    cy = min(max(v, r), 1.0 - r)
    if (u - cx) ** 2 + (v - cy) ** 2 > r * r:
        return (0, 0, 0, 0)

    # 2x2 chessboard.
    m = BOARD_MARGIN
    if m <= u <= 1.0 - m and m <= v <= 1.0 - m:
        col = int((u - m) >= (1.0 - 2.0 * m) / 2.0)
        row = int((v - m) >= (1.0 - 2.0 * m) / 2.0)
        return BOARD_LIGHT if (col + row) % 2 == 0 else BOARD_DARK

    return BACKGROUND


def render(size: int) -> bytes:
    """RGBA bytes of the icon at `size` x `size`."""
    hi = size * SUPERSAMPLE
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = a = 0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    u = (x * SUPERSAMPLE + sx + 0.5) / hi
                    v = (y * SUPERSAMPLE + sy + 0.5) / hi
                    sr, sg, sb, sa = sample(u, v)
                    # premultiplied accumulation (correct for transparency)
                    r += sr * sa
                    g += sg * sa
                    b += sb * sa
                    a += sa
            n = SUPERSAMPLE * SUPERSAMPLE
            if a == 0:
                row += bytes((0, 0, 0, 0))
            else:
                row += bytes((round(r / a), round(g / a), round(b / a), round(a / n)))
        rows.append(bytes(row))
    return b"".join(rows)


def write_png(path: Path, size: int, rgba: bytes) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = b"".join(
        b"\x00" + rgba[y * size * 4 : (y + 1) * size * 4] for y in range(size)
    )
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    default_out = Path(__file__).resolve().parent.parent / "icons"
    parser.add_argument("--out", type=Path, default=default_out)
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        target = args.out / f"icon{size}.png"
        write_png(target, size, render(size))
        print(f"wrote {target} ({target.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
