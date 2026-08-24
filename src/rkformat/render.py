"""Render an `.rkf` document to HTML.

One renderer serves everything — `rk render`, `rk view`, and the VS Code custom editor —
so the document looks identical wherever it is opened. The only thing that varies is how
an asset turns into a URL, which callers supply via `asset_url`.
"""

from __future__ import annotations

import base64
import html
import re
from typing import Callable

from .container import RkDocument
from .errors import RkfError
from .manifest import Asset

__all__ = ["to_html", "render_body", "PAGE_CSS"]

AssetUrl = Callable[[Asset], str]

_PARA_IMG_RE = re.compile(
    r"<p>\s*(<img\b[^>]*>)\s*</p>",
    re.I,
)
_ALT_RE = re.compile(r"""\balt\s*=\s*"([^"]*)\"""", re.I)


def data_uri(doc: RkDocument) -> AssetUrl:
    """Asset URL strategy that inlines bytes, for a fully standalone HTML file."""

    def resolve(asset: Asset) -> str:
        payload = base64.b64encode(doc.asset_bytes(asset)).decode("ascii")
        return f"data:{asset.media_type};base64,{payload}"

    return resolve


def render_body(
    doc: RkDocument,
    *,
    asset_url: AssetUrl | None = None,
    allow_html: bool = False,
) -> str:
    """Render just the Markdown body to an HTML fragment.

    Embedded raw HTML is disabled by default (SPEC.md section 4): a `.rkf` arrives from
    someone else, and a document format should not be a script delivery mechanism.
    """
    try:
        from markdown_it import MarkdownIt
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise RkfError(
            "rendering needs markdown-it-py. Install it with: pip install markdown-it-py"
        ) from exc

    resolve = asset_url or data_uri(doc)
    md = MarkdownIt("commonmark", {"html": allow_html, "linkify": True, "typographer": True})
    md.enable(["table", "strikethrough"])

    def image_rule(self, tokens, idx, options, env):  # noqa: ANN001 - markdown-it hook
        token = tokens[idx]
        src = token.attrGet("src") or ""
        asset = doc.resolve(src)
        alt = token.content or ""
        attrs = [f'alt="{html.escape(alt, quote=True)}"']
        if asset is not None:
            attrs.insert(0, f'src="{html.escape(resolve(asset), quote=True)}"')
            if asset.width and asset.height:
                # Reserve layout space so text does not reflow as images decode.
                attrs.append(f'width="{asset.width}" height="{asset.height}"')
            attrs.append('class="rkf-image"')
        else:
            attrs.insert(0, f'src="{html.escape(src, quote=True)}"')
            attrs.append('class="rkf-image rkf-missing"')
            if not src.lower().startswith(("http://", "https://", "data:")):
                attrs.append(f'data-rkf-dangling="{html.escape(src, quote=True)}"')
        title = token.attrGet("title")
        if title:
            attrs.append(f'title="{html.escape(title, quote=True)}"')
        return f"<img {' '.join(attrs)} loading=\"lazy\">"

    md.add_render_rule("image", image_rule)
    body = md.render(doc.markdown)
    return _figurize(body)


def _figurize(body: str) -> str:
    """Promote a lone image in a paragraph to a captioned figure, Word-style."""

    def replace(match: re.Match[str]) -> str:
        tag = match.group(1)
        alt_match = _ALT_RE.search(tag)
        alt = alt_match.group(1) if alt_match else ""
        caption = f"<figcaption>{alt}</figcaption>" if alt.strip() else ""
        return f"<figure>{tag}{caption}</figure>"

    return _PARA_IMG_RE.sub(replace, body)


PAGE_CSS = """
:root {
  --rkf-ink: #1a1a1a;
  --rkf-muted: #6b6b6b;
  --rkf-rule: #e3e3e3;
  --rkf-page: #ffffff;
  --rkf-desk: #f0f0f2;
  --rkf-accent: #2c5aa0;
  --rkf-code-bg: #f6f7f9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --rkf-ink: #e8e8e8;
    --rkf-muted: #9a9a9a;
    --rkf-rule: #3a3a3a;
    --rkf-page: #1f1f22;
    --rkf-desk: #141416;
    --rkf-accent: #7aa7e6;
    --rkf-code-bg: #26262a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--rkf-desk);
  color: var(--rkf-ink);
  font: 16px/1.7 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.rkf-page {
  max-width: 46rem;
  margin: 2.5rem auto;
  padding: 4rem 4.5rem 5rem;
  background: var(--rkf-page);
  border: 1px solid var(--rkf-rule);
  border-radius: 3px;
  box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 8px 24px rgba(0,0,0,.06);
}
@media (max-width: 40rem) {
  .rkf-page { margin: 0; padding: 1.5rem 1.25rem 3rem; border: 0; border-radius: 0; box-shadow: none; }
}
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 2em 0 .6em; font-weight: 650; }
h1 { font-size: 2rem; margin-top: 0; letter-spacing: -.015em; }
h2 { font-size: 1.5rem; padding-bottom: .3em; border-bottom: 1px solid var(--rkf-rule); }
h3 { font-size: 1.2rem; }
p, ul, ol, blockquote, table, pre, figure { margin: 0 0 1.1em; }
a { color: var(--rkf-accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
blockquote {
  padding: .1em 0 .1em 1.1em;
  border-left: 3px solid var(--rkf-rule);
  color: var(--rkf-muted);
}
code, kbd, pre {
  font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
  font-size: .875em;
}
code { background: var(--rkf-code-bg); padding: .15em .4em; border-radius: 3px; }
pre { background: var(--rkf-code-bg); padding: 1em 1.1em; border-radius: 5px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; font-size: .95em; }
th, td { border: 1px solid var(--rkf-rule); padding: .5em .7em; text-align: left; }
th { background: var(--rkf-code-bg); font-weight: 600; }
hr { border: 0; border-top: 1px solid var(--rkf-rule); margin: 2.5em 0; }
figure { margin: 1.8em 0; text-align: center; }
figcaption { margin-top: .6em; font-size: .85rem; color: var(--rkf-muted); font-style: italic; }
.rkf-image {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  background: var(--rkf-code-bg);
}
.rkf-missing {
  display: inline-block;
  min-width: 12rem;
  min-height: 3rem;
  padding: .8em 1em;
  border: 1px dashed #c94a4a;
  color: #c94a4a;
  font-size: .85rem;
}
.rkf-meta {
  max-width: 46rem;
  margin: 0 auto 1rem;
  padding: 0 .5rem;
  font-size: .78rem;
  color: var(--rkf-muted);
  display: flex;
  gap: 1.2rem;
  flex-wrap: wrap;
}
.rkf-meta strong { font-weight: 600; color: var(--rkf-ink); }
"""


def to_html(
    doc: RkDocument,
    *,
    standalone: bool = True,
    asset_url: AssetUrl | None = None,
    allow_html: bool = False,
    show_meta: bool = True,
    extra_head: str = "",
) -> str:
    """Render a full HTML document. Self-contained by default (images as data URIs)."""
    body = render_body(doc, asset_url=asset_url, allow_html=allow_html)
    if not standalone:
        return body

    title = html.escape(doc.title)
    meta = ""
    if show_meta:
        bits = [f"<span><strong>{title}</strong></span>"]
        if doc.manifest.authors:
            bits.append("<span>" + html.escape(", ".join(doc.manifest.authors)) + "</span>")
        if doc.manifest.modified:
            bits.append(f"<span>modified {html.escape(doc.manifest.modified)}</span>")
        bits.append(
            f"<span>{len(doc.manifest.assets)} embedded "
            f"image{'s' if len(doc.manifest.assets) != 1 else ''} "
            f"({_human(doc.asset_bytes_total)})</span>"
        )
        meta = f'<div class="rkf-meta">{"".join(bits)}</div>'

    return (
        "<!doctype html>\n"
        '<html lang="en">\n<head>\n'
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{title}</title>\n"
        f"<style>{PAGE_CSS}</style>\n"
        f"{extra_head}"
        "</head>\n<body>\n"
        f"{meta}"
        f'<main class="rkf-page">\n{body}\n</main>\n'
        "</body>\n</html>\n"
    )


def _human(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"
