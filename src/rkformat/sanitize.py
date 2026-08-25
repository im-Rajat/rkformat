"""HTML sanitiser for author-supplied markup inside a document body.

Markdown allows raw HTML, and people use it - most often to size an image:

    <img src="assets/diagram.png" alt="drawing" width="200"/>

A `.rkf` arrives from someone else, so that HTML cannot be passed through untouched: the
browser viewer would happily run any script it contained. Everything here is rebuilt from
parsed tokens against an allowlist, so anything unrecognised cannot survive - the output is
constructed, never echoed.

The same algorithm exists in `docs/assets/sanitize.js` for the browser viewer, which cannot
call this code on static hosting. `tests/test_site_parity.js` diffs the two over a battery
of hostile inputs.

Deliberate choices:

* Attributes are emitted in sorted order, so both implementations agree byte for byte.
* Elements that carry executable or fetchable content (`script`, `iframe`, `object`, ...)
  are dropped *along with their contents*, not just unwrapped.
* Tags are rebuilt from a stack, so unbalanced author markup cannot break out of the
  surrounding document structure.
"""

from __future__ import annotations

import re
from html import escape
from html.parser import HTMLParser
from typing import Callable

__all__ = ["sanitize", "ALLOWED_TAGS", "ALLOWED_ATTRIBUTES"]

# Structural and text-level markup only. Nothing that loads, scripts, or submits.
ALLOWED_TAGS = frozenset(
    {
        "a", "abbr", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code",
        "col", "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt", "em",
        "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img",
        "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "rp", "rt", "ruby", "s",
        "samp", "section", "small", "span", "strong", "sub", "summary", "sup", "table",
        "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr",
    }
)

VOID_TAGS = frozenset({"br", "col", "hr", "img", "wbr"})

# Every void element in HTML. A discarded void element has no closing tag, so it must be
# dropped outright rather than opening a "skip until closed" region - otherwise <base>,
# <meta> or <input> would swallow the remainder of the document.
HTML_VOID = frozenset(
    {
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
        "source", "track", "wbr",
    }
)

# Dropped together with everything inside them.
DISCARD_WITH_CONTENT = frozenset(
    {
        "script", "style", "iframe", "object", "embed", "applet", "noscript", "template",
        "form", "input", "button", "select", "option", "textarea", "link", "meta",
        "base", "title", "head", "svg", "math", "frame", "frameset", "audio", "video",
        "source", "track", "canvas", "map", "area", "portal", "slot",
    }
)

_GLOBAL_ATTRIBUTES = frozenset({"class", "dir", "id", "lang", "title", "translate"})

_ALIGN_TAGS = frozenset(
    {"col", "colgroup", "div", "h1", "h2", "h3", "h4", "h5", "h6", "img", "p", "table",
     "tbody", "td", "tfoot", "th", "thead", "tr"}
)

ALLOWED_ATTRIBUTES: dict[str, frozenset[str]] = {
    "a": frozenset({"href", "rel", "target"}),
    "col": frozenset({"span"}),
    "colgroup": frozenset({"span"}),
    "del": frozenset({"cite", "datetime"}),
    "details": frozenset({"open"}),
    "img": frozenset(
        {"alt", "data-rkf-dangling", "data-rkf-md", "data-rkf-src", "height", "loading",
         "src", "width"}
    ),
    "ins": frozenset({"cite", "datetime"}),
    "li": frozenset({"value"}),
    "ol": frozenset({"reversed", "start", "type"}),
    "q": frozenset({"cite"}),
    "td": frozenset({"colspan", "headers", "rowspan"}),
    "th": frozenset({"abbr", "colspan", "headers", "rowspan", "scope"}),
    "time": frozenset({"datetime"}),
}

# `style` is permitted, but only these properties and only simple values. This is what makes
# <div style="text-align:center"> work without opening the door to url() fetches.
_ALLOWED_STYLE_PROPERTIES = frozenset(
    {
        "background-color", "border", "border-bottom", "border-collapse", "border-color",
        "border-left", "border-radius", "border-right", "border-style", "border-top",
        "border-width", "color", "float", "font-family", "font-size", "font-style",
        "font-variant", "font-weight", "height", "letter-spacing", "line-height",
        "list-style-type", "margin", "margin-bottom", "margin-left", "margin-right",
        "margin-top", "max-height", "max-width", "min-height", "min-width", "opacity",
        "padding", "padding-bottom", "padding-left", "padding-right", "padding-top",
        "text-align", "text-decoration", "text-indent", "text-transform",
        "vertical-align", "white-space", "width", "word-break",
    }
)

_SAFE_STYLE_VALUE = re.compile(r"^[A-Za-z0-9 ,.%#()/_-]*$")
_STYLE_FORBIDDEN = re.compile(r"url\s*\(|expression|javascript:|@import|/\*|\\", re.I)

_NUMERIC_ATTRIBUTES = frozenset(
    {"colspan", "height", "rowspan", "span", "start", "value", "width"}
)
_BOOLEAN_ATTRIBUTES = frozenset({"open", "reversed"})

# Mirrors markdown.js safeUrl(): anything else is refused rather than neutered.
_SAFE_URL = re.compile(r"^(?:https?:|mailto:|tel:|blob:|#|/|\./|\.\./)", re.I)
_SAFE_DATA_URL = re.compile(r"^data:image/(?:png|jpeg|gif|webp|bmp|svg\+xml|avif|heic);", re.I)
_HAS_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")

ResolveImage = Callable[[str], "dict[str, object] | None"]


def _safe_url(value: str) -> str | None:
    """Return the URL if it is safe to put in an href/src, else None."""
    candidate = value.strip().replace("\x00", "")
    if not candidate:
        return None
    # A scheme split across whitespace ("java\nscript:") still parses in some browsers.
    collapsed = re.sub(r"[\s\x00-\x1f]", "", candidate).lower()
    if collapsed.startswith(("javascript:", "vbscript:", "livescript:", "mocha:")):
        return None
    if _SAFE_URL.match(candidate) or _SAFE_DATA_URL.match(candidate):
        return candidate
    if _HAS_SCHEME.match(candidate):
        return None  # some other scheme - refuse it
    return candidate  # relative path


def _clean_style(value: str) -> str | None:
    if _STYLE_FORBIDDEN.search(value):
        return None
    kept = []
    for declaration in value.split(";"):
        if ":" not in declaration:
            continue
        name, _, raw = declaration.partition(":")
        prop = name.strip().lower()
        setting = raw.strip()
        if prop not in _ALLOWED_STYLE_PROPERTIES:
            continue
        if not setting or not _SAFE_STYLE_VALUE.match(setting):
            continue
        kept.append(f"{prop}:{setting}")
    return ";".join(kept) or None


def _clean_attributes(tag: str, attrs: list[tuple[str, str | None]]) -> dict[str, str | None]:
    allowed = _GLOBAL_ATTRIBUTES | ALLOWED_ATTRIBUTES.get(tag, frozenset()) | {"style"}
    if tag in _ALIGN_TAGS:
        allowed = allowed | {"align", "valign"}
    out: dict[str, str | None] = {}
    for raw_name, raw_value in attrs:
        name = raw_name.lower().strip()
        if name.startswith("on"):
            continue  # belt and braces: the allowlist below excludes these anyway
        if name not in allowed:
            continue
        if name in _BOOLEAN_ATTRIBUTES:
            out[name] = None
            continue
        value = "" if raw_value is None else raw_value
        if name in ("href", "src"):
            safe = _safe_url(value)
            if safe is None:
                continue
            value = safe
        elif name == "style":
            cleaned = _clean_style(value)
            if cleaned is None:
                continue
            value = cleaned
        elif name in _NUMERIC_ATTRIBUTES:
            digits = value.strip()
            if not re.fullmatch(r"\d{1,6}", digits):
                continue
            value = digits
        elif name in ("align", "valign"):
            keyword = value.strip().lower()
            if keyword not in ("left", "right", "center", "justify", "top", "middle", "bottom"):
                continue
            value = keyword
        elif name == "target":
            if value.strip().lower() != "_blank":
                continue
            value = "_blank"
        elif name == "loading":
            if value.strip().lower() not in ("lazy", "eager"):
                continue
            value = value.strip().lower()
        out[name] = value
    if tag == "a" and out.get("target") == "_blank":
        # Deny the opened page access back to this one.
        out["rel"] = "noopener noreferrer"
    return out


def _render_tag(tag: str, attributes: dict[str, str | None], self_closing: bool) -> str:
    parts = [tag]
    for name in sorted(attributes):  # sorted so both implementations agree exactly
        value = attributes[name]
        if value is None:
            parts.append(name)
        else:
            parts.append(f'{name}="{escape(value, quote=True)}"')
    inner = " ".join(parts)
    return f"<{inner} />" if self_closing else f"<{inner}>"


class _Sanitizer(HTMLParser):
    def __init__(self, resolve_image: ResolveImage | None = None) -> None:
        super().__init__(convert_charrefs=False)
        self.out: list[str] = []
        self.stack: list[str] = []
        self.discarding: list[str] = []
        self.resolve_image = resolve_image

    # -- helpers ----------------------------------------------------------------

    def _emit(self, text: str) -> None:
        if not self.discarding:
            self.out.append(text)

    def _image(self, attributes: dict[str, str | None]) -> dict[str, str | None]:
        """Point an <img> at an embedded asset, matching Markdown image rendering."""
        if self.resolve_image is None:
            return attributes
        src = attributes.get("src")
        if not src:
            return attributes
        resolved = self.resolve_image(src)
        classes = (attributes.get("class") or "").split()
        if resolved is None:
            if not re.match(r"^(https?:|data:|blob:)", src, re.I):
                attributes["data-rkf-dangling"] = src
                if "rkf-missing" not in classes:
                    classes += ["rkf-image", "rkf-missing"]
        else:
            attributes["data-rkf-src"] = src
            attributes["src"] = str(resolved["url"])
            if "rkf-image" not in classes:
                classes.append("rkf-image")
            if not attributes.get("width") and not attributes.get("height"):
                width, height = resolved.get("width"), resolved.get("height")
                if width and height:
                    attributes["width"] = str(width)
                    attributes["height"] = str(height)
        if classes:
            attributes["class"] = " ".join(dict.fromkeys(classes))
        return attributes

    # -- HTMLParser hooks -------------------------------------------------------

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001
        tag = tag.lower()
        if tag in DISCARD_WITH_CONTENT:
            if tag not in HTML_VOID:
                self.discarding.append(tag)
            return
        if self.discarding or tag not in ALLOWED_TAGS:
            return
        attributes = _clean_attributes(tag, attrs)
        if tag == "img":
            attributes = self._image(attributes)
        if tag in VOID_TAGS:
            self._emit(_render_tag(tag, attributes, self_closing=True))
            return
        self.stack.append(tag)
        self._emit(_render_tag(tag, attributes, self_closing=False))

    def handle_startendtag(self, tag: str, attrs) -> None:  # noqa: ANN001
        tag = tag.lower()
        if tag in DISCARD_WITH_CONTENT or self.discarding or tag not in ALLOWED_TAGS:
            return
        attributes = _clean_attributes(tag, attrs)
        if tag == "img":
            attributes = self._image(attributes)
        if tag in VOID_TAGS:
            self._emit(_render_tag(tag, attributes, self_closing=True))
        else:
            self._emit(_render_tag(tag, attributes, self_closing=False))
            self._emit(f"</{tag}>")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.discarding:
            if tag in self.discarding:
                while self.discarding and self.discarding.pop() != tag:
                    pass
            return
        if tag not in ALLOWED_TAGS or tag in VOID_TAGS:
            return
        if tag not in self.stack:
            return  # stray close tag: ignore rather than letting it unbalance the output
        while self.stack:
            open_tag = self.stack.pop()
            self._emit(f"</{open_tag}>")
            if open_tag == tag:
                break

    def handle_data(self, data: str) -> None:
        self._emit(escape(data, quote=False))

    def handle_entityref(self, name: str) -> None:
        self._emit(f"&{name};" if re.fullmatch(r"[A-Za-z][A-Za-z0-9]{1,31}", name) else "")

    def handle_charref(self, name: str) -> None:
        if re.fullmatch(r"[0-9]{1,7}", name) or re.fullmatch(r"[xX][0-9A-Fa-f]{1,6}", name):
            self._emit(f"&#{name};")

    def handle_comment(self, data: str) -> None:
        pass  # comments carry conditional-comment tricks; drop them

    def handle_decl(self, decl: str) -> None:
        pass

    def handle_pi(self, data: str) -> None:
        pass

    def unknown_decl(self, data: str) -> None:
        pass

    def result(self) -> str:
        while self.stack:
            self.out.append(f"</{self.stack.pop()}>")
        return "".join(self.out)


def sanitize(html: str, resolve_image: ResolveImage | None = None) -> str:
    """Rebuild `html` from allowlisted tags and attributes.

    `resolve_image(src)` may return `{"url", "width", "height"}` to repoint an `<img>` at an
    embedded asset, exactly as Markdown image syntax is handled.
    """
    parser = _Sanitizer(resolve_image)
    parser.feed(html)
    parser.close()
    return parser.result()
