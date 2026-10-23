#!/usr/bin/env python3
"""Generate the InkPane 1-bit bitmap font blob from Noto Sans SC.

The firmware embeds a single binary (``inkpane_fonts.bin``) that contains three
bitmap sizes: 16 px (body), 24 px (list titles) and 32 px (clock / headline).
Glyph coverage is GB2312 (6763 hanzi), printable ASCII and the punctuation that
shows up in Chinese calendar / weather / course text.

Blob layout (little endian)::

    char  magic[4]            "IPFN"
    u16   version             1
    u16   size_count          3
    struct size_desc[3]:
        u16 px
        u16 line_height
        u16 ascent            distance from line top to baseline (px)
        u16 glyph_count
        u32 index_offset      absolute offset of the 12-byte index entries
        u32 bitmap_offset     absolute offset of the first glyph bitmap
        u32 bitmap_size
        u16 digit_advance     fixed advance for tabular digits
        u16 flags             reserved (0)

    each index entry (sorted by codepoint, 16 bytes):
        u32 codepoint
        u32 glyph_offset      absolute offset of the packed bitmap
        i8  dx                left bearing relative to the pen (baseline origin)
        i8  dy                top bearing relative to the baseline (negative = above)
        u8  w
        u8  h
        u8  advance
        u8  reserved[3]

Glyph bitmaps are packed MSB-first, ``stride = (w + 7) // 8`` bytes per row,
bit 1 = ink (black).

Usage::

    python hardware/tools/genfont.py \
        --font C:/Windows/Fonts/NotoSansSC-VF.ttf \
        --out hardware/main/components/inkpane_ui/fonts/inkpane_fonts.bin

The generated blob is committed so a normal firmware build does not depend on
Python/Pillow.  Re-run this script only when changing sizes, weights or charset.
"""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

MAGIC = b"IPFN"
VERSION = 1
DESC_SIZE = 24
INDEX_ENTRY = 16

# (px, weight, threshold, line_height)
SIZES = (
    (16, 600, 110, 22),
    (24, 400, 128, 32),
    (32, 400, 128, 42),
)

ASCII = [chr(c) for c in range(0x20, 0x7F)]

# Extra symbols that are not guaranteed to be in GB2312 but occur in titles.
EXTRA = "…—·℃“”‘’《》【】（）！？：；，。、￥×÷°～·"


def gb2312_codepoints() -> list[str]:
    out: list[str] = []
    for hi in range(0xA1, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                ch = bytes((hi, lo)).decode("gb2312")
            except UnicodeDecodeError:
                continue
            if ch.strip():
                out.append(ch)
    return out


def charset() -> list[str]:
    seen: set[int] = set()
    chars: list[str] = []
    for ch in ASCII + gb2312_codepoints() + list(EXTRA):
        cp = ord(ch)
        if cp in seen:
            continue
        seen.add(cp)
        chars.append(ch)
    chars.sort(key=ord)
    return chars


def weight_axis(font: ImageFont.FreeTypeFont) -> int | None:
    """Return the index of the weight axis of a variable font, if any."""
    try:
        axes = font.get_variation_axes()
    except Exception:
        return None
    for index, axis in enumerate(axes):
        name = axis.get("name", b"")
        if isinstance(name, bytes):
            name = name.decode("ascii", "ignore")
        if str(name).lower() in ("weight", "wght"):
            return index
    return None


def render_glyph(font: ImageFont.FreeTypeFont, ch: str, ascent: int, threshold: int):
    """Render one glyph. Returns (bitmap, stride, w, h, dx, dy, advance) or None."""
    try:
        bbox = font.getbbox(ch, anchor="ls")
    except Exception:
        return None
    x0, y0, x1, y1 = bbox
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return None
    if w > 255 or h > 255:
        return None
    img = Image.new("L", (w + 2, h + 2), 255)
    draw = ImageDraw.Draw(img)
    # anchor "ls" = left baseline; placing the baseline at (1-x0, 1-y0) moves
    # the glyph bbox to (1, 1) .. (1+w, 1+h).
    draw.text((1 - x0, 1 - y0), ch, font=font, fill=0, anchor="ls")
    img = img.crop((1, 1, 1 + w, 1 + h))
    img = img.point(lambda p: 0 if p < threshold else 255)

    stride = (w + 7) // 8
    bitmap = bytearray(stride * h)
    px = img.load()
    for y in range(h):
        for x in range(w):
            if px[x, y] == 0:
                bitmap[y * stride + (x >> 3)] |= 0x80 >> (x & 7)

    advance = int(round(font.getlength(ch)))
    if advance <= 0:
        advance = w
    if advance > 255:
        return None
    return bytes(bitmap), stride, w, h, x0, y0, advance


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--font",
        default="C:/Windows/Fonts/NotoSansSC-VF.ttf",
        help="path to a Noto Sans SC (or compatible) TrueType/OpenType font",
    )
    parser.add_argument(
        "--out",
        default="hardware/main/components/inkpane_ui/fonts/inkpane_fonts.bin",
        help="output blob path",
    )
    args = parser.parse_args()

    font_path = Path(args.font)
    if not font_path.is_file():
        print(f"font not found: {font_path}", file=sys.stderr)
        return 1

    chars = charset()
    print(f"charset: {len(chars)} codepoints")

    sections: list[tuple[int, int, int, int, bytes, bytes]] = []
    # sections: (px, line_height, ascent, digit_advance, index_bytes, bitmap_bytes)
    for px, weight, threshold, line_height in SIZES:
        font = ImageFont.truetype(str(font_path), px)
        axis = weight_axis(font)
        if axis is not None:
            try:
                font.set_variation_by_axes([weight])
            except Exception as exc:  # pragma: no cover - depends on Pillow/font
                print(f"warning: cannot set weight {weight}: {exc}", file=sys.stderr)

        ascent = px
        entries: list[tuple[int, int, int, int, int, int, int]] = []
        bitmaps = bytearray()
        digit_advance = 0

        for ch in chars:
            rendered = render_glyph(font, ch, ascent, threshold)
            if rendered is None:
                continue
            bitmap, _stride, w, h, dx, dy, advance = rendered
            offset = len(bitmaps)
            bitmaps += bitmap
            entries.append((ord(ch), offset, dx, dy, w, h, advance))
            if "0" <= ch <= "9":
                digit_advance = max(digit_advance, advance)

        entries.sort(key=lambda item: item[0])
        if digit_advance == 0:
            digit_advance = px // 2

        index = bytearray()
        for cp, offset, dx, dy, w, h, advance in entries:
            index += struct.pack("<IIbbBBB3x", cp, offset, dx, dy, w, h, advance)

        sections.append((px, line_height, ascent, digit_advance, bytes(index), bytes(bitmaps)))
        print(f"{px}px weight={weight}: {len(entries)} glyphs, {len(index) + len(bitmaps)} bytes")

    header_size = 8 + len(sections) * DESC_SIZE
    offset = header_size
    header = bytearray(MAGIC)
    header += struct.pack("<HH", VERSION, len(sections))

    blobs: list[bytes] = []
    for px, line_height, ascent, digit_advance, index, bitmaps in sections:
        index_offset = offset
        bitmap_offset = index_offset + len(index)
        header += struct.pack(
            "<HHHHIIIHH",
            px,
            line_height,
            ascent,
            len(index) // INDEX_ENTRY,
            index_offset,
            bitmap_offset,
            len(bitmaps),
            digit_advance,
            0,
        )
        blobs.append(index)
        blobs.append(bitmaps)
        offset = bitmap_offset + len(bitmaps)

    out = bytes(header) + b"".join(blobs)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(out)
    print(f"wrote {out_path} ({len(out)} bytes, {len(out) / 1024 / 1024:.2f} MiB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
