"""Build a self-viewing HTML file that carries a `.rkf` inside it.

The problem this solves: you send someone a `.rkf` and they have nothing that opens it. The
body is legible in a text editor - it is stored uncompressed and first, on purpose - but they
see ZIP header bytes, then Markdown source, then binary image data, and the pictures are only
`![...]` references. Not a document.

`rk share` produces one `.html` they can double-click. It renders the document properly,
offline, with the images, and the original `.rkf` is inside it: a Download button hands back
the exact bytes, so the shared file is both a viewer and a carrier.

Why the document is embedded as a `.rkf` rather than as rendered HTML with data-URI images:
size. Base64 costs 33%, so carrying the archive once (1.33x) beats rendering the images inline
*and* attaching the archive (2.7x). The page unzips itself in the browser with the same reader
the web viewer uses, which is why those modules are shipped as package data.

A `<noscript>` block holds the Markdown, so the file still reads as text with scripting off.
"""

from __future__ import annotations

import base64
import re
from html import escape
from pathlib import Path

from .container import RkDocument
from .errors import RkfError
from .render import PAGE_CSS, _human

__all__ = ["build_share_page", "fill_template", "WEB_MODULES", "TEMPLATE"]

# Inlined in this order; markdown.js needs sanitize.js to have registered itself.
WEB_MODULES = ("rkf.js", "sanitize.js", "markdown.js")

# The page itself, shared with the web editor so both produce the same artifact.
TEMPLATE = "share-template.html"

def _module_source(name: str) -> str:
    """Read a browser module shipped as package data."""
    path = Path(__file__).with_name("web") / name
    if not path.is_file():
        raise RkfError(
            f"{name} is missing from the installed package. "
            "Run python3 docs/build.py to regenerate src/rkformat/web/."
        )
    return path.read_text(encoding="utf-8")


def build_share_page(
    doc: RkDocument,
    payload: bytes,
    *,
    filename: str = "document.rkf",
    editor_url: str = "https://im-rajat.github.io/rkformat/",
) -> str:
    """Render a single HTML file that displays `doc` and carries `payload` inside it.

    `payload` is the document's own `.rkf` bytes; keeping them verbatim is what lets the page
    hand back a byte-identical original rather than something re-serialised.
    """
    count = len(doc.assets)
    encoded = base64.b64encode(payload).decode("ascii")
    # Wrapped because a single multi-megabyte line makes some editors and viewers crawl.
    wrapped = "\n".join(encoded[i : i + 120] for i in range(0, len(encoded), 120))
    modules = "\n".join(
        f"<script>\n{_module_source(name)}\n</script>" for name in WEB_MODULES
    )

    return fill_template(
        _module_source(TEMPLATE),
        {
            "TITLE": escape(doc.title),
            "FILENAME": escape(filename),
            "SUMMARY": escape(
                f"{count} embedded image{'' if count == 1 else 's'} · {_human(len(payload))}"
            ),
            "EDITOR_URL": escape(editor_url),
            "DOCUMENT_CSS": PAGE_CSS,
            "FALLBACK": escape(doc.markdown),
            "MODULES": modules,
            "PAYLOAD": wrapped,
        },
    )


def fill_template(template: str, values: dict[str, str]) -> str:
    """Substitute `{{NAME}}` placeholders, including the `<!--{{NAME}}-->` block form.

    Done with plain replacement rather than str.format so the template can contain the braces
    that CSS and JavaScript are full of.
    """
    out = template
    for name, value in values.items():
        out = out.replace(f"<!--{{{{{name}}}}}-->", value).replace(f"{{{{{name}}}}}", value)
    leftover = re.findall(r"\{\{([A-Z_]+)\}\}", out)
    if leftover:
        raise RkfError(f"share template has unfilled placeholders: {sorted(set(leftover))}")
    return out
