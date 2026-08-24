#!/usr/bin/env python3
"""Build examples/welcome.rkf — a demo document, images and all.

Images are generated here rather than committed, so the repo carries no opaque binaries
and the example can be rebuilt from source at any time.
"""

from __future__ import annotations

import math
import struct
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from rkformat import RkDocument  # noqa: E402


def png(width: int, height: int, shade) -> bytes:
    """Encode an RGB PNG from a `shade(x, y) -> (r, g, b)` callback."""
    rows = []
    for y in range(height):
        row = bytearray(b"\x00")
        for x in range(width):
            row += bytes(shade(x / width, y / height))
        rows.append(bytes(row))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
        + chunk(b"IEND", b"")
    )


def gradient(u: float, v: float) -> tuple[int, int, int]:
    return (int(30 + 60 * u), int(70 + 110 * v), int(150 + 90 * (1 - u)))


def rings(u: float, v: float) -> tuple[int, int, int]:
    d = math.hypot(u - 0.5, v - 0.5) * 8
    t = (math.sin(d * 3) + 1) / 2
    return (int(240 * t + 15), int(120 * t + 30), int(60 * t + 40))


def bars(u: float, v: float) -> tuple[int, int, int]:
    height = [0.35, 0.62, 0.48, 0.81, 0.95][min(int(u * 5), 4)]
    return (245, 246, 249) if (1 - v) > height else (44, 90, 160)


def main() -> int:
    out = Path(__file__).parent
    doc = RkDocument.new(title="Welcome to .rkf", authors=["rkformat"])
    doc.markdown = WELCOME
    for name, shade, size in (
        ("gradient.png", gradient, (640, 200)),
        ("chart.png", bars, (560, 300)),
        ("rings.png", rings, (400, 400)),
    ):
        doc.add_image_bytes(png(size[0], size[1], shade), name)

    # Pin the timestamps so rebuilding produces a byte-identical file. Combined with the
    # format's fixed ZIP timestamps, that keeps the committed example out of git's way.
    doc.manifest.created = doc.manifest.modified = "2026-08-24T00:00:00Z"

    target = out / "welcome.rkf"
    doc.save(target, touch=False)
    doc.check()
    print(f"wrote {target} ({target.stat().st_size} bytes, {len(doc.assets)} images)")
    for problem in doc.validate():
        print(f"  {problem}")
    return 0


WELCOME = """# Welcome to `.rkf`

This whole document — the words you are reading **and** every image below — is a single
file. Send it to someone and the pictures go with it. No `images/` folder, no broken links.

![A gradient, embedded in this very file](assets/gradient.png)

## Try these

- **Paste an image.** Copy any picture to your clipboard and press Ctrl+V right here. It
  gets embedded in this file immediately.
- **Drag a file in.** Drop a PNG or JPEG onto the editor.
- **Click "Images"** in the toolbar to see everything embedded here, with sizes.
- **Toggle Source / Split / Preview** to switch layouts.

## It is still just Markdown

Ordinary formatting works: *italic*, **bold**, `code`, [links](https://example.com), and:

| Feature | .rkf | Markdown + folder | base64 inline |
|---|---|---|---|
| One file to share | yes | no | yes |
| Size overhead | ~0.1% | none | +33% |
| Random access to one image | yes | yes | no |
| Opens in any Markdown editor | after unpack | yes | no |

> Rename this file to `.zip` and extract it. You get `content.md` and an `assets/` folder,
> and the Markdown's relative links still work. The format is a convenience, not a trap.

## Charts and pictures stay pictures

Images are stored as raw bytes and never converted to text:

![Bar chart](assets/chart.png)

![Concentric rings](assets/rings.png)

## From the command line

```bash
rk info welcome.rkf     # metadata and a size breakdown
rk ls welcome.rkf       # every embedded image
rk check welcome.rkf    # verify each asset's checksum
rk render welcome.rkf   # one self-contained .html
rk unpack welcome.rkf   # explode to a plain Markdown folder
```
"""


if __name__ == "__main__":
    raise SystemExit(main())
