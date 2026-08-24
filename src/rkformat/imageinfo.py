"""Stdlib-only image sniffing: media type and pixel dimensions.

Deliberately dependency-free. SPEC.md section 4 requires readers to sniff magic bytes
rather than trust the file extension, so this module is the single place that decides what
an asset actually *is*. Pillow would do more, but pulling a C extension into a format
library for two integers is a bad trade.
"""

from __future__ import annotations

import re
import struct
from typing import NamedTuple

__all__ = ["ImageInfo", "sniff", "SUPPORTED_MEDIA_TYPES"]

SUPPORTED_MEDIA_TYPES = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/bmp",
        "image/tiff",
        "image/svg+xml",
        "image/avif",
        "image/heic",
    }
)

# JPEG start-of-frame markers that carry the frame dimensions. Excludes DHT/DAC/RST/etc.
_JPEG_SOF = frozenset(
    {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
)

_SVG_LEN = re.compile(rb"""(width|height)\s*=\s*["']\s*([0-9.]+)""", re.I)
_SVG_VIEWBOX = re.compile(
    rb"""viewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)""",
    re.I,
)


class ImageInfo(NamedTuple):
    media_type: str
    width: int | None
    height: int | None


def sniff(data: bytes) -> ImageInfo | None:
    """Identify raw image bytes, or return None if unrecognised."""
    for probe in (_png, _jpeg, _gif, _webp, _bmp, _tiff, _isobmff, _svg):
        info = probe(data)
        if info is not None:
            return info
    return None


def _png(data: bytes) -> ImageInfo | None:
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return None
    # IHDR is mandated to be the first chunk: 8 sig + 4 len + 4 type, then w/h.
    if len(data) >= 24 and data[12:16] == b"IHDR":
        width, height = struct.unpack(">II", data[16:24])
        return ImageInfo("image/png", width, height)
    return ImageInfo("image/png", None, None)


def _jpeg(data: bytes) -> ImageInfo | None:
    if not data.startswith(b"\xff\xd8"):
        return None
    pos, end = 2, len(data)
    while pos + 3 < end:
        if data[pos] != 0xFF:
            pos += 1  # resync past padding / entropy-coded garbage
            continue
        marker = data[pos + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            pos += 2
            continue
        if marker == 0xD9 or marker == 0xDA:  # EOI / start of scan — no SOF found
            break
        seg_len = struct.unpack(">H", data[pos + 2 : pos + 4])[0]
        if marker in _JPEG_SOF and pos + 9 <= end:
            height, width = struct.unpack(">HH", data[pos + 5 : pos + 9])
            return ImageInfo("image/jpeg", width, height)
        if seg_len < 2:
            break
        pos += 2 + seg_len
    return ImageInfo("image/jpeg", None, None)


def _gif(data: bytes) -> ImageInfo | None:
    if not (data.startswith(b"GIF87a") or data.startswith(b"GIF89a")):
        return None
    if len(data) >= 10:
        width, height = struct.unpack("<HH", data[6:10])
        return ImageInfo("image/gif", width, height)
    return ImageInfo("image/gif", None, None)


def _webp(data: bytes) -> ImageInfo | None:
    if not (data.startswith(b"RIFF") and data[8:12] == b"WEBP"):
        return None
    chunk = data[12:16]
    try:
        if chunk == b"VP8 " and len(data) >= 30:
            width, height = struct.unpack("<HH", data[26:30])
            return ImageInfo("image/webp", width & 0x3FFF, height & 0x3FFF)
        if chunk == b"VP8L" and len(data) >= 25:
            bits = struct.unpack("<I", data[21:25])[0]
            return ImageInfo(
                "image/webp", (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
            )
        if chunk == b"VP8X" and len(data) >= 30:
            width = int.from_bytes(data[24:27], "little") + 1
            height = int.from_bytes(data[27:30], "little") + 1
            return ImageInfo("image/webp", width, height)
    except struct.error:
        pass
    return ImageInfo("image/webp", None, None)


def _bmp(data: bytes) -> ImageInfo | None:
    if not data.startswith(b"BM"):
        return None
    if len(data) >= 26:
        width, height = struct.unpack("<ii", data[18:26])
        return ImageInfo("image/bmp", abs(width), abs(height))
    return ImageInfo("image/bmp", None, None)


def _tiff(data: bytes) -> ImageInfo | None:
    if data.startswith(b"II*\x00") or data.startswith(b"MM\x00*"):
        return ImageInfo("image/tiff", None, None)
    return None


def _isobmff(data: bytes) -> ImageInfo | None:
    """AVIF / HEIC share an ISO base media file format 'ftyp' box."""
    if len(data) < 12 or data[4:8] != b"ftyp":
        return None
    brand = data[8:12]
    if brand in (b"avif", b"avis"):
        return ImageInfo("image/avif", None, None)
    if brand in (b"heic", b"heix", b"heim", b"heis", b"hevc", b"mif1", b"msf1"):
        return ImageInfo("image/heic", None, None)
    return None


def _svg(data: bytes) -> ImageInfo | None:
    head = data[:4096].lstrip()
    if not (head.startswith(b"<?xml") or head.startswith(b"<svg") or b"<svg" in head):
        return None
    dims: dict[bytes, float] = {}
    for name, value in _SVG_LEN.findall(data[:4096]):
        dims.setdefault(name.lower(), float(value))
    if b"width" in dims and b"height" in dims:
        return ImageInfo("image/svg+xml", int(dims[b"width"]), int(dims[b"height"]))
    box = _SVG_VIEWBOX.search(data[:4096])
    if box:
        return ImageInfo(
            "image/svg+xml", int(float(box.group(1))), int(float(box.group(2)))
        )
    return ImageInfo("image/svg+xml", None, None)
