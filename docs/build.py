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


def main() -> int:
    docs = Path(__file__).parent
    target = docs / "assets" / "document.css"
    target.write_text(HEADER + PAGE_CSS, encoding="utf-8")
    print(f"wrote {target.relative_to(ROOT)} ({target.stat().st_size} bytes)")

    # The WYSIWYG serialiser is shared between the browser viewer and the VS Code webview.
    # One canonical copy lives here; the extension gets a generated duplicate, because a
    # packaged extension cannot read files from outside its own directory.
    serialiser = docs / "assets" / "tomarkdown.js"
    extension_copy = ROOT / "vscode-extension" / "media" / "tomarkdown.js"
    if extension_copy.parent.is_dir():
        banner = (
            "/* GENERATED COPY - do not edit.\n"
            " *\n"
            " * Source of truth: docs/assets/tomarkdown.js. Re-run docs/build.py after\n"
            " * changing it, or the extension and the web viewer will disagree.\n"
            " */\n"
        )
        extension_copy.write_text(banner + serialiser.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"copied {extension_copy.relative_to(ROOT)} ({extension_copy.stat().st_size} bytes)")

    demo_source = ROOT / "examples" / "welcome.rkf"
    if not demo_source.is_file():
        print("examples/welcome.rkf is missing - run examples/make_welcome.py first")
        return 1
    demo_target = docs / "welcome.rkf"
    shutil.copyfile(demo_source, demo_target)
    print(f"copied {demo_target.relative_to(ROOT)} ({demo_target.stat().st_size} bytes)")

    # Pages runs Jekyll by default, which would skip files it does not recognise.
    (docs / ".nojekyll").write_text("", encoding="utf-8")
    print("wrote docs/.nojekyll")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
