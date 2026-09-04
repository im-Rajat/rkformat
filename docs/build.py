#!/usr/bin/env python3
"""Generate the site's derived files.

Two things are copied rather than duplicated by hand:

* `assets/document.css` comes from `rkformat.render.PAGE_CSS`, so the page rendered in the
  browser is styled identically to `rk render` output. This is the one thing that keeps the
  viewer from drifting visually away from the canonical renderer.
* `welcome.rkf` is the demo document, served same-origin so the "open the demo" button
  needs no cross-origin permission.

Run this after changing PAGE_CSS or the example: python3 docs/build.py
"""

from __future__ import annotations

import hashlib
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from rkformat.render import PAGE_CSS  # noqa: E402

HEADER = """/* GENERATED FILE - do not edit.
 *
 * Produced by docs/build.py from rkformat.render.PAGE_CSS. Edit the Python source and
 * re-run the script, so the browser viewer and `rk render` cannot drift apart.
 */
"""


def _png(width: int, height: int, shade) -> bytes:
    """Encode an RGBA PNG from a `shade(x, y) -> (r, g, b, a)` callback."""
    import struct
    import zlib

    rows = []
    for y in range(height):
        row = bytearray(b"\x00")
        for x in range(width):
            row += bytes(shade(x, y))
        rows.append(bytes(row))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data))
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
        + chunk(b"IEND", b"")
    )


def _app_icon(size: int, *, maskable: bool) -> bytes:
    """The installable app's icon: a page with an image embedded in it.

    Drawn procedurally so the repository carries no opaque binaries and the icons can be
    regenerated at any size. A maskable variant keeps the artwork inside the safe circle that
    platforms may crop to.
    """
    inset = 0.0 if maskable else 0.08
    scale = 0.62 if maskable else 0.78  # artwork size within the tile
    ink = (255, 255, 255, 255)
    background = (44, 90, 160, 255)

    def shade(x: int, y: int):
        u, v = (x + 0.5) / size, (y + 0.5) / size
        # Rounded tile, or a full bleed for the maskable variant.
        if not maskable:
            radius = 0.22
            cx = min(max(u, inset + radius), 1 - inset - radius)
            cy = min(max(v, inset + radius), 1 - inset - radius)
            if (u < inset or u > 1 - inset or v < inset or v > 1 - inset) or (
                (u - cx) ** 2 + (v - cy) ** 2 > radius**2
            ):
                return (0, 0, 0, 0)

        # The page.
        half = scale / 2
        left, right = 0.5 - half * 0.78, 0.5 + half * 0.78
        top, bottom = 0.5 - half, 0.5 + half
        if not (left <= u <= right and top <= v <= bottom):
            return background
        # A folded corner.
        fold = 0.24 * scale
        if u > right - fold and v < top + fold and (right - u) + (top - v) * -1 < 0:
            pass
        if (right - u) < fold and (v - top) < fold and (right - u) + (v - top) < fold:
            return background

        # The embedded picture: a band across the lower half of the page.
        band_top, band_bottom = top + scale * 0.46, top + scale * 0.78
        pad = (right - left) * 0.14
        if band_top <= v <= band_bottom and left + pad <= u <= right - pad:
            t = (u - left - pad) / max(right - left - 2 * pad, 1e-6)
            return (
                int(56 + 40 * t),
                int(120 + 80 * t),
                int(210 - 60 * t),
                255,
            )

        # Text lines above the picture.
        for index in range(2):
            line_top = top + scale * (0.16 + index * 0.13)
            line_bottom = line_top + scale * 0.055
            width_factor = 1.0 if index == 0 else 0.68
            if line_top <= v <= line_bottom and left + pad <= u <= left + pad + (
                right - left - 2 * pad
            ) * width_factor:
                return (150, 170, 200, 255)
        return ink

    return _png(size, size, shade)


def _write_icons(docs: Path) -> None:
    icons = docs / "assets" / "icons"
    icons.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        target = icons / f"rkf-{size}.png"
        target.write_bytes(_app_icon(size, maskable=False))
        print(f"wrote {target.relative_to(ROOT)} ({target.stat().st_size} bytes)")
    target = icons / "rkf-maskable-512.png"
    target.write_bytes(_app_icon(512, maskable=True))
    print(f"wrote {target.relative_to(ROOT)} ({target.stat().st_size} bytes)")


def _stamp_service_worker(docs: Path) -> None:
    """Rewrite the cache name in sw.js to a digest of the files it caches.

    The worker is cache-first, so a stale cache means a visitor keeps running old code after a
    deploy. Naming the cache after the shell's contents makes the bump automatic: change any
    cached file and the name changes, which invalidates the old cache on activate. Leaving the
    constant to be maintained by hand is exactly the kind of step that gets forgotten.
    """
    worker = docs / "sw.js"
    if not worker.is_file():
        return
    source = worker.read_text(encoding="utf-8")

    block = re.search(r"const SHELL = \[(.*?)\];", source, re.DOTALL)
    if block is None:
        print("sw.js has no SHELL list - cache name left alone")
        return
    shell = re.findall(r'"([^"]+)"', block.group(1))
    digest = hashlib.sha256()
    for name in shell:
        path = docs / name
        # "./" is index.html under another name, and a missing optional file just contributes
        # its absence - the install step tolerates both.
        if path.is_dir() or not path.is_file():
            continue
        digest.update(name.encode("utf-8"))
        digest.update(path.read_bytes())

    stamped = re.sub(
        r'const CACHE = "rkf-shell-[^"]*"',
        f'const CACHE = "rkf-shell-{digest.hexdigest()[:12]}"',
        source,
        count=1,
    )
    if stamped == source:
        print("sw.js cache name unchanged")
        return
    worker.write_text(stamped, encoding="utf-8")
    print(f"stamped docs/sw.js cache name ({digest.hexdigest()[:12]})")


def main() -> int:
    docs = Path(__file__).parent
    target = docs / "assets" / "document.css"
    target.write_text(HEADER + PAGE_CSS, encoding="utf-8")
    print(f"wrote {target.relative_to(ROOT)} ({target.stat().st_size} bytes)")

    # The WYSIWYG serialiser is shared between the browser viewer and the VS Code webview.
    # One canonical copy lives here; the extension gets a generated duplicate, because a
    # packaged extension cannot read files from outside its own directory.
    media = ROOT / "vscode-extension" / "media"
    for name in ("tomarkdown.js", "toolbar.js", "highlight.js", "highlight.css"):
        source = docs / "assets" / name
        target = media / name
        if not media.is_dir():
            break
        banner = (
            "/* GENERATED COPY - do not edit.\n"
            " *\n"
            f" * Source of truth: docs/assets/{name}. Re-run docs/build.py after changing\n"
            " * it, or the extension and the web editor will disagree.\n"
            " */\n"
        )  # a CSS comment is also a valid JS comment, so one banner serves both
        target.write_text(banner + source.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"copied {target.relative_to(ROOT)} ({target.stat().st_size} bytes)")

    # `rk share` inlines these into a self-viewing HTML, and an installed package cannot
    # reach docs/, so they are copied in as package data.
    package_web = ROOT / "src" / "rkformat" / "web"
    package_web.mkdir(parents=True, exist_ok=True)
    for name in ("rkf.js", "sanitize.js", "markdown.js", "share-template.html"):
        source = docs / "assets" / name
        target = package_web / name
        # An HTML template cannot carry a /* */ banner, and its own comment already says
        # where it comes from, so only the JS modules get one.
        banner = (
            "/* GENERATED COPY - do not edit.\n"
            " *\n"
            f" * Source of truth: docs/assets/{name}. Re-run docs/build.py after changing it.\n"
            " * Inlined into the output of `rk share`.\n"
            " */\n"
        ) if name.endswith(".js") else ""
        target.write_text(banner + source.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"copied {target.relative_to(ROOT)} ({target.stat().st_size} bytes)")

    demo_source = ROOT / "examples" / "welcome.rkf"
    if not demo_source.is_file():
        print("examples/welcome.rkf is missing - run examples/make_welcome.py first")
        return 1
    demo_target = docs / "welcome.rkf"
    shutil.copyfile(demo_source, demo_target)
    print(f"copied {demo_target.relative_to(ROOT)} ({demo_target.stat().st_size} bytes)")

    _write_icons(docs)
    # After the icons, so their bytes are part of the digest.
    _stamp_service_worker(docs)

    # Pages runs Jekyll by default, which would skip files it does not recognise.
    (docs / ".nojekyll").write_text("", encoding="utf-8")
    print("wrote docs/.nojekyll")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
