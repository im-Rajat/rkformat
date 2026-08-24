"""`manifest.json` model: parse, validate, serialise.

Kept separate from the container so the schema can be reasoned about (and unit-tested)
without touching ZIP machinery.
"""

from __future__ import annotations

import datetime as _dt
import posixpath
import re
from dataclasses import dataclass, field
from typing import Any

from .errors import RkfFormatError, RkfValidationError, RkfVersionError

__all__ = [
    "Asset",
    "Manifest",
    "SPEC_VERSION",
    "ASSET_DIR",
    "MIMETYPE",
    "utc_now",
    "safe_member_name",
]

SPEC_VERSION = "1.0"
MIMETYPE = "application/vnd.rkformat+zip"
ASSET_DIR = "assets"
DEFAULT_CONTENT = "content.md"

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def utc_now() -> str:
    """RFC 3339 timestamp in UTC, second precision."""
    return (
        _dt.datetime.now(_dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def safe_member_name(name: str) -> str:
    """Validate an archive member name against the zip-slip rules in SPEC.md section 4.

    Raises RkfValidationError rather than sanitising: silently rewriting a hostile path
    hides the attack and produces a document that no longer round-trips.
    """
    if not name or name != name.strip():
        raise RkfValidationError(f"empty or padded archive member name: {name!r}")
    if "\\" in name:
        raise RkfValidationError(f"backslash in archive member name: {name!r}")
    if name.startswith("/") or (len(name) > 1 and name[1] == ":"):
        raise RkfValidationError(f"absolute archive member name: {name!r}")
    parts = name.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise RkfValidationError(f"non-normalised archive member name: {name!r}")
    if posixpath.normpath(name) != name:
        raise RkfValidationError(f"non-normalised archive member name: {name!r}")
    return name


@dataclass(slots=True)
class Asset:
    """One binary payload stored inside the container."""

    id: str
    path: str
    media_type: str
    bytes: int
    sha256: str
    width: int | None = None
    height: int | None = None
    alt: str | None = None

    def __post_init__(self) -> None:
        if not _ID_RE.match(self.id):
            raise RkfValidationError(f"invalid asset id: {self.id!r}")
        safe_member_name(self.path)
        if posixpath.dirname(self.path) != ASSET_DIR:
            raise RkfValidationError(
                f"asset path must live directly under {ASSET_DIR}/: {self.path!r}"
            )

    @property
    def name(self) -> str:
        """Filename portion, i.e. the path as written in Markdown minus the directory."""
        return posixpath.basename(self.path)

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "path": self.path,
            "media_type": self.media_type,
            "bytes": self.bytes,
            "sha256": self.sha256,
        }
        for key in ("width", "height", "alt"):
            value = getattr(self, key)
            if value is not None:
                out[key] = value
        return out

    @classmethod
    def from_json(cls, raw: Any) -> Asset:
        if not isinstance(raw, dict):
            raise RkfFormatError(f"asset record must be an object, got {type(raw).__name__}")
        missing = {"id", "path", "media_type", "bytes", "sha256"} - raw.keys()
        if missing:
            raise RkfFormatError(f"asset record missing keys: {sorted(missing)}")
        try:
            return cls(
                id=str(raw["id"]),
                path=str(raw["path"]),
                media_type=str(raw["media_type"]),
                bytes=int(raw["bytes"]),
                sha256=str(raw["sha256"]),
                width=_opt_int(raw.get("width")),
                height=_opt_int(raw.get("height")),
                alt=None if raw.get("alt") is None else str(raw["alt"]),
            )
        except (TypeError, ValueError) as exc:
            raise RkfFormatError(f"malformed asset record: {exc}") from exc


def _opt_int(value: Any) -> int | None:
    return None if value is None else int(value)


def _opt_str(value: Any) -> str | None:
    return None if value is None else str(value)


@dataclass(slots=True)
class Manifest:
    """Document-level metadata and the authoritative asset table."""

    rkf_version: str = SPEC_VERSION
    generator: str | None = None
    title: str | None = None
    authors: list[str] = field(default_factory=list)
    created: str | None = None
    modified: str | None = None
    content: str = DEFAULT_CONTENT
    assets: list[Asset] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"rkf_version": self.rkf_version}
        if self.generator:
            out["generator"] = self.generator
        if self.title is not None:
            out["title"] = self.title
        if self.authors:
            out["authors"] = list(self.authors)
        if self.created:
            out["created"] = self.created
        if self.modified:
            out["modified"] = self.modified
        out["content"] = self.content
        out["assets"] = [a.to_json() for a in self.assets]
        if self.extra:
            out["extra"] = self.extra
        return out

    @classmethod
    def from_json(cls, raw: Any) -> Manifest:
        if not isinstance(raw, dict):
            raise RkfFormatError("manifest.json must contain a JSON object")
        version = str(raw.get("rkf_version", ""))
        if not version:
            raise RkfFormatError("manifest.json is missing rkf_version")
        major = version.split(".", 1)[0]
        if major != SPEC_VERSION.split(".", 1)[0]:
            raise RkfVersionError(
                f"unsupported .rkf major version {version!r}; "
                f"this reader implements {SPEC_VERSION}"
            )
        assets_raw = raw.get("assets", [])
        if not isinstance(assets_raw, list):
            raise RkfFormatError("manifest.assets must be an array")
        authors_raw = raw.get("authors") or []
        if not isinstance(authors_raw, list):
            raise RkfFormatError("manifest.authors must be an array")
        content = str(raw.get("content") or DEFAULT_CONTENT)
        safe_member_name(content)
        return cls(
            rkf_version=version,
            generator=_opt_str(raw.get("generator")),
            title=_opt_str(raw.get("title")),
            authors=[str(a) for a in authors_raw],
            created=_opt_str(raw.get("created")),
            modified=_opt_str(raw.get("modified")),
            content=content,
            assets=[Asset.from_json(a) for a in assets_raw],
            extra=dict(raw.get("extra") or {}),
        )

    def by_id(self, asset_id: str) -> Asset | None:
        return next((a for a in self.assets if a.id == asset_id), None)

    def by_path(self, path: str) -> Asset | None:
        return next((a for a in self.assets if a.path == path), None)

    def next_id(self) -> str:
        """Lowest unused `aN` identifier."""
        used = {a.id for a in self.assets}
        n = 1
        while f"a{n}" in used:
            n += 1
        return f"a{n}"

    def unique_path(self, filename: str) -> str:
        """An `assets/<filename>` path that collides with nothing, case-insensitively."""
        stem, dot, ext = filename.rpartition(".")
        if not dot:
            stem, ext = filename, ""
        stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-.") or "image"
        ext = re.sub(r"[^A-Za-z0-9]+", "", ext).lower()
        taken = {a.path.lower() for a in self.assets}
        n = 0
        while True:
            suffix = "" if n == 0 else f"-{n}"
            candidate = f"{ASSET_DIR}/{stem}{suffix}" + (f".{ext}" if ext else "")
            if candidate.lower() not in taken:
                return candidate
            n += 1
