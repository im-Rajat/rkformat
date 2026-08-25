"""The `.rkf` container: read, write, mutate.

A document is held fully in memory. Compound documents are shared as units, so partial
lazy access buys little, and an in-memory model makes the round-trip guarantee (unknown
archive members survive a save) straightforward to honour.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import posixpath
import re
import zlib
import urllib.parse
import zipfile
from pathlib import Path
from typing import Iterable, Iterator

from .errors import (
    RkfAssetError,
    RkfFormatError,
    RkfSecurityError,
    RkfValidationError,
)
from .imageinfo import SUPPORTED_MEDIA_TYPES, sniff
from .manifest import (
    ASSET_DIR,
    MIMETYPE,
    SPEC_VERSION,
    Asset,
    Manifest,
    safe_member_name,
    utc_now,
)

__all__ = ["RkDocument", "is_rkf", "Reference"]

MIMETYPE_MEMBER = "mimetype"
MANIFEST_MEMBER = "manifest.json"
RKF_SUFFIXES = (".rkf", ".rk")

# SPEC.md section 4 hardening ceilings.
MAX_TOTAL_UNCOMPRESSED = 512 * 1024 * 1024
MAX_COMPRESSION_RATIO = 100
_RATIO_FLOOR = 64 * 1024  # ignore ratios on tiny members; deflate headers skew them

_INLINE_IMG_RE = re.compile(r"!\[(?P<alt>(?:[^\]\\]|\\.)*)\]\(\s*(?P<target>[^)\s]+)")
_REF_DEF_RE = re.compile(r"(?m)^[ \t]{0,3}\[(?P<label>[^\]]+)\]:\s*(?P<target>\S+)")
_HTML_IMG_RE = re.compile(r"""<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']""", re.I)


class Reference:
    """An image reference found in the Markdown body."""

    __slots__ = ("target", "asset", "kind", "span")

    def __init__(self, target: str, asset: Asset | None, kind: str, span: tuple[int, int]):
        self.target = target
        self.asset = asset
        self.kind = kind  # "inline" | "refdef" | "html"
        self.span = span

    @property
    def dangling(self) -> bool:
        return self.asset is None and not _is_external(self.target)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        state = "external" if _is_external(self.target) else (self.asset.id if self.asset else "DANGLING")
        return f"<Reference {self.kind} {self.target!r} -> {state}>"


def _is_external(target: str) -> bool:
    lowered = target.lower()
    return lowered.startswith(("http://", "https://", "data:", "mailto:", "//"))


def is_rkf(source: str | os.PathLike[str] | bytes) -> bool:
    """Magic-byte detection per SPEC.md section 2.1, without unzipping."""
    probe_len = 38 + len(MIMETYPE)
    if isinstance(source, bytes):
        head = source[:probe_len]
    else:
        try:
            with open(source, "rb") as fh:
                head = fh.read(probe_len)
        except OSError:
            return False
    return (
        head.startswith(b"PK\x03\x04")
        and head[30:38] == MIMETYPE_MEMBER.encode()
        and head[38:].startswith(MIMETYPE.encode())
    )


class RkDocument:
    """An in-memory `.rkf` document."""

    def __init__(
        self,
        manifest: Manifest | None = None,
        markdown: str = "",
        blobs: dict[str, bytes] | None = None,
        extras: dict[str, bytes] | None = None,
    ) -> None:
        self.manifest = manifest if manifest is not None else Manifest()
        self.markdown = markdown
        self._blobs: dict[str, bytes] = dict(blobs or {})
        self._extras: dict[str, bytes] = dict(extras or {})
        self.source_path: Path | None = None
        # Compressed size of each member as it was read, keyed by archive path. Empty for
        # documents built in memory, since nothing has been serialised yet.
        self.stored_sizes: dict[str, int] = {}
        # Members whose bytes could not be decompressed, reported by validate().
        self.corrupt_members: list[str] = []

    # ------------------------------------------------------------------ create

    @classmethod
    def new(
        cls,
        title: str | None = None,
        markdown: str = "",
        authors: Iterable[str] = (),
    ) -> RkDocument:
        now = utc_now()
        manifest = Manifest(
            rkf_version=SPEC_VERSION,
            generator=_generator(),
            title=title,
            authors=list(authors),
            created=now,
            modified=now,
        )
        return cls(manifest, markdown)

    # -------------------------------------------------------------------- read

    @classmethod
    def open(cls, path: str | os.PathLike[str], *, strict: bool = True) -> RkDocument:
        """Load a `.rkf` file from disk."""
        path = Path(path)
        try:
            data = path.read_bytes()
        except OSError as exc:
            raise RkfFormatError(f"cannot read {path}: {exc}") from exc
        doc = cls.from_bytes(data, strict=strict, origin=str(path))
        doc.source_path = path
        return doc

    @classmethod
    def from_bytes(
        cls, data: bytes, *, strict: bool = True, origin: str = "<bytes>"
    ) -> RkDocument:
        if not zipfile.is_zipfile(io.BytesIO(data)):
            raise RkfFormatError(f"{origin} is not a ZIP container (not a .rkf file)")
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            _enforce_limits(zf, origin)
            names = zf.namelist()
            stored = {info.filename: info.compress_size for info in zf.infolist()}

            declared = None
            if MIMETYPE_MEMBER in names:
                declared = (
                    _read_member(zf, MIMETYPE_MEMBER, origin).decode("utf-8", "replace").strip()
                )
            if declared != MIMETYPE:
                message = (
                    f"{origin}: missing or wrong mimetype member "
                    f"(expected {MIMETYPE!r}, found {declared!r})"
                )
                if strict:
                    raise RkfFormatError(message)

            if MANIFEST_MEMBER not in names:
                raise RkfFormatError(f"{origin}: no {MANIFEST_MEMBER}")
            try:
                manifest = Manifest.from_json(
                    json.loads(_read_member(zf, MANIFEST_MEMBER, origin))
                )
            except json.JSONDecodeError as exc:
                raise RkfFormatError(f"{origin}: {MANIFEST_MEMBER} is not valid JSON: {exc}") from exc

            if manifest.content not in names:
                raise RkfFormatError(
                    f"{origin}: manifest points at content {manifest.content!r}, "
                    "which is not in the archive"
                )
            markdown = _read_member(zf, manifest.content, origin).decode("utf-8")

            known = {MIMETYPE_MEMBER, MANIFEST_MEMBER, manifest.content}
            blobs: dict[str, bytes] = {}
            extras: dict[str, bytes] = {}
            corrupt: list[str] = []
            for name in names:
                if name in known or name.endswith("/"):
                    continue
                safe_member_name(name)
                try:
                    payload = zf.read(name)
                except (zipfile.BadZipFile, zlib.error, EOFError, OSError) as exc:
                    # One damaged asset should not stop the document from opening: the whole
                    # point of `rk check` is to say what is wrong with a file.
                    corrupt.append(f"{name} cannot be read: {exc}")
                    continue
                if posixpath.dirname(name) == ASSET_DIR:
                    blobs[name] = payload
                else:
                    extras[name] = payload

        doc = cls(manifest, markdown, blobs, extras)
        doc.stored_sizes = stored
        doc.corrupt_members = corrupt
        if strict:
            problems = [p for p in doc.validate() if p.severity == "error"]
            if problems:
                raise RkfValidationError(
                    f"{origin} failed validation:\n  "
                    + "\n  ".join(p.message for p in problems)
                )
        return doc

    # ------------------------------------------------------------------- write

    def to_bytes(self, *, touch: bool = True) -> bytes:
        """Serialise to a deterministic ZIP archive (SPEC.md section 5)."""
        if touch:
            self.manifest.modified = utc_now()
            self.manifest.generator = _generator()
        if not self.manifest.created:
            self.manifest.created = self.manifest.modified or utc_now()

        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as zf:
            _write(zf, MIMETYPE_MEMBER, MIMETYPE.encode(), compress=False)
            # The body goes second and uncompressed on purpose: it puts the prose in the
            # clear near the start of the file, so `cat`, `less`, Notepad or a mail client
            # preview shows readable text to someone with no .rkf tooling at all. Text is
            # negligible next to the images, so the lost compression costs nothing.
            _write(zf, self.manifest.content, self.markdown.encode("utf-8"), compress=False)
            manifest_json = json.dumps(
                self.manifest.to_json(), indent=2, sort_keys=True, ensure_ascii=False
            ).encode("utf-8")
            _write(zf, MANIFEST_MEMBER, manifest_json)
            for asset in sorted(self.manifest.assets, key=lambda a: a.path):
                _write(zf, asset.path, self._blobs[asset.path], media_type=asset.media_type)
            for name in sorted(self._extras):
                _write(zf, name, self._extras[name])
        return buffer.getvalue()

    def save(self, path: str | os.PathLike[str] | None = None, *, touch: bool = True) -> Path:
        """Write to `path`, or back to where this document was opened from."""
        target = Path(path) if path is not None else self.source_path
        if target is None:
            raise RkfFormatError("no path given and this document has no source path")
        payload = self.to_bytes(touch=touch)
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_bytes(payload)
        os.replace(tmp, target)  # atomic: never leave a half-written document
        self.source_path = target
        return target

    # ------------------------------------------------------------------ assets

    def add_image(
        self,
        source: str | os.PathLike[str],
        *,
        alt: str | None = None,
        name: str | None = None,
    ) -> Asset:
        """Embed an image file from disk."""
        source = Path(source)
        try:
            data = source.read_bytes()
        except OSError as exc:
            raise RkfAssetError(f"cannot read image {source}: {exc}") from exc
        return self.add_image_bytes(data, name or source.name, alt=alt)

    def add_image_bytes(
        self, data: bytes, filename: str, *, alt: str | None = None
    ) -> Asset:
        """Embed raw image bytes under `assets/`, sniffing the real media type."""
        if not data:
            raise RkfAssetError(f"{filename}: empty image payload")
        info = sniff(data)
        if info is None:
            raise RkfAssetError(
                f"{filename}: unrecognised image data. Supported: "
                + ", ".join(sorted(SUPPORTED_MEDIA_TYPES))
            )
        digest = hashlib.sha256(data).hexdigest()
        existing = next((a for a in self.manifest.assets if a.sha256 == digest), None)
        if existing is not None:
            return existing  # identical bytes already embedded — dedupe

        asset = Asset(
            id=self.manifest.next_id(),
            path=self.manifest.unique_path(filename),
            media_type=info.media_type,
            bytes=len(data),
            sha256=digest,
            width=info.width,
            height=info.height,
            alt=alt,
        )
        self._blobs[asset.path] = data
        self.manifest.assets.append(asset)
        return asset

    def append_image(
        self,
        source: str | os.PathLike[str],
        *,
        alt: str | None = None,
        name: str | None = None,
    ) -> Asset:
        """Embed an image *and* append a Markdown reference to the body."""
        asset = self.add_image(source, alt=alt, name=name)
        if not self.markdown.endswith("\n") and self.markdown:
            self.markdown += "\n"
        self.markdown += f"\n{markdown_ref(asset)}\n"
        return asset

    def remove_asset(self, ref: str, *, prune_refs: bool = False) -> Asset:
        """Drop an asset by id, archive path, or filename."""
        asset = self.find_asset(ref)
        if asset is None:
            raise RkfAssetError(f"no such asset: {ref!r}")
        self.manifest.assets.remove(asset)
        self._blobs.pop(asset.path, None)
        if prune_refs:
            pattern = re.compile(
                r"[ \t]*!\[(?:[^\]\\]|\\.)*\]\(\s*(?:"
                + "|".join(re.escape(t) for t in (asset.path, asset.name, f"rkf:{asset.id}"))
                + r")[^)]*\)[ \t]*\n?"
            )
            self.markdown = pattern.sub("", self.markdown)
        return asset

    def find_asset(self, ref: str) -> Asset | None:
        """Resolve an asset by id, exact archive path, or bare filename."""
        return (
            self.manifest.by_id(ref)
            or self.manifest.by_path(ref)
            or self.manifest.by_path(f"{ASSET_DIR}/{ref}")
            or next((a for a in self.manifest.assets if a.name == ref), None)
        )

    def asset_bytes(self, asset: Asset | str) -> bytes:
        record = asset if isinstance(asset, Asset) else self.find_asset(asset)
        if record is None:
            raise RkfAssetError(f"no such asset: {asset!r}")
        try:
            return self._blobs[record.path]
        except KeyError:
            raise RkfAssetError(f"asset {record.id} has no payload in the archive") from None

    @property
    def assets(self) -> list[Asset]:
        return list(self.manifest.assets)

    # -------------------------------------------------------------- references

    def references(self) -> list[Reference]:
        """Every image reference in the body, in document order, with resolutions.

        Fenced and indented code blocks are masked out first so an example in a snippet is
        not mistaken for a live reference.
        """
        text = _mask_code(self.markdown)
        found: list[Reference] = []
        for match in _INLINE_IMG_RE.finditer(text):
            target = match.group("target")
            found.append(Reference(target, self.resolve(target), "inline", match.span("target")))
        for match in _REF_DEF_RE.finditer(text):
            target = match.group("target")
            asset = self.resolve(target)
            if asset is not None or not _is_external(target):
                found.append(Reference(target, asset, "refdef", match.span("target")))
        for match in _HTML_IMG_RE.finditer(text):
            target = match.group(1)
            found.append(Reference(target, self.resolve(target), "html", match.span(1)))
        found.sort(key=lambda r: r.span[0])
        return found

    def resolve(self, target: str) -> Asset | None:
        """Map a Markdown link target onto an embedded asset, or None."""
        target = target.strip().strip("<>")
        if _is_external(target):
            return None
        target = target.split("#", 1)[0].split("?", 1)[0]
        if target.lower().startswith("rkf:"):
            return self.manifest.by_id(target[4:])
        for candidate in (target, urllib.parse.unquote(target)):
            candidate = candidate.lstrip("./")
            asset = self.manifest.by_path(candidate)
            if asset is not None:
                return asset
            if "/" not in candidate:
                asset = self.manifest.by_path(f"{ASSET_DIR}/{candidate}")
                if asset is not None:
                    return asset
        return None

    def orphan_assets(self) -> list[Asset]:
        """Embedded assets that the body never references."""
        used = {r.asset.id for r in self.references() if r.asset}
        return [a for a in self.manifest.assets if a.id not in used]

    # -------------------------------------------------------------- validation

    def validate(self) -> list[Problem]:
        """Check every integrity rule in SPEC.md section 3."""
        problems: list[Problem] = [
            Problem("error", message) for message in self.corrupt_members
        ]
        seen_ids: set[str] = set()
        seen_paths: set[str] = set()

        for asset in self.manifest.assets:
            if asset.id in seen_ids:
                problems.append(Problem("error", f"duplicate asset id {asset.id!r}"))
            seen_ids.add(asset.id)
            lowered = asset.path.lower()
            if lowered in seen_paths:
                problems.append(Problem("error", f"duplicate asset path {asset.path!r}"))
            seen_paths.add(lowered)

            payload = self._blobs.get(asset.path)
            if payload is None:
                problems.append(
                    Problem("error", f"asset {asset.id} ({asset.path}) has no bytes in the archive")
                )
                continue
            if len(payload) != asset.bytes:
                problems.append(
                    Problem(
                        "error",
                        f"asset {asset.id}: manifest says {asset.bytes} bytes, "
                        f"archive holds {len(payload)}",
                    )
                )
            actual = hashlib.sha256(payload).hexdigest()
            if actual != asset.sha256:
                problems.append(
                    Problem("error", f"asset {asset.id}: sha256 mismatch (corrupt payload)")
                )
            info = sniff(payload)
            if info is None:
                problems.append(
                    Problem("error", f"asset {asset.id}: payload is not a recognised image")
                )
            elif info.media_type != asset.media_type:
                problems.append(
                    Problem(
                        "error",
                        f"asset {asset.id}: declared {asset.media_type}, "
                        f"bytes are {info.media_type}",
                    )
                )

        for path in sorted(set(self._blobs) - seen_paths_exact(self.manifest)):
            problems.append(
                Problem("warning", f"{path} is in the archive but not in manifest.assets")
            )

        for ref in self.references():
            if ref.dangling:
                problems.append(
                    Problem("error", f"dangling image reference: {ref.target!r}")
                )

        for asset in self.orphan_assets():
            problems.append(
                Problem("info", f"asset {asset.id} ({asset.path}) is never referenced")
            )
        return problems

    def check(self) -> None:
        """Raise RkfValidationError if any error-severity problem exists."""
        errors = [p.message for p in self.validate() if p.severity == "error"]
        if errors:
            raise RkfValidationError("; ".join(errors))

    # ----------------------------------------------------------- unpack / pack

    def unpack(self, directory: str | os.PathLike[str]) -> Path:
        """Explode into a plain folder: `content.md` + `assets/` + `manifest.json`.

        This is the graceful-degradation path — the result is an ordinary Markdown folder.
        """
        root = Path(directory)
        (root / ASSET_DIR).mkdir(parents=True, exist_ok=True)
        (root / self.manifest.content).write_text(self.markdown, encoding="utf-8")
        (root / MANIFEST_MEMBER).write_text(
            json.dumps(self.manifest.to_json(), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        for path, payload in self._blobs.items():
            (root / path).write_bytes(payload)
        for name, payload in self._extras.items():
            destination = root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(payload)
        return root

    @classmethod
    def from_markdown_file(
        cls, path: str | os.PathLike[str], *, title: str | None = None
    ) -> tuple[RkDocument, list[str]]:
        """Build a document from a `.md` file, pulling in every local image it links.

        Returns the document and a list of references that could not be found on disk.
        """
        path = Path(path)
        text = path.read_text(encoding="utf-8")
        doc = cls.new(title=title or path.stem, markdown=text)
        base = path.parent
        missing: list[str] = []
        rewrites: list[tuple[tuple[int, int], str]] = []

        probe = cls(doc.manifest, text)
        for ref in probe.references():
            if _is_external(ref.target):
                continue
            raw = urllib.parse.unquote(ref.target.strip().strip("<>").split("#", 1)[0])
            candidate = (base / raw).resolve()
            if not candidate.is_file():
                missing.append(ref.target)
                continue
            try:
                asset = doc.add_image(candidate, alt=None, name=candidate.name)
            except RkfAssetError:
                missing.append(ref.target)
                continue
            if ref.target != asset.path:
                rewrites.append((ref.span, asset.path))

        for (start, end), replacement in sorted(rewrites, reverse=True):
            text = text[:start] + replacement + text[end:]
        doc.markdown = text
        return doc, missing

    # ------------------------------------------------------------------- misc

    @property
    def title(self) -> str:
        if self.manifest.title:
            return self.manifest.title
        heading = re.search(r"(?m)^#\s+(.+?)\s*$", self.markdown)
        if heading:
            return heading.group(1)
        return self.source_path.stem if self.source_path else "Untitled"

    @property
    def asset_bytes_total(self) -> int:
        """Total *uncompressed* size of the embedded assets."""
        return sum(len(b) for b in self._blobs.values())

    @property
    def asset_stored_total(self) -> int:
        """What the assets actually occupy in the container, once compressed.

        Falls back to the uncompressed total for in-memory documents, which have not been
        serialised and so have no stored sizes yet.
        """
        if not self.stored_sizes:
            return self.asset_bytes_total
        return sum(self.stored_sizes.get(a.path, len(self._blobs.get(a.path, b""))) for a in self.manifest.assets)

    @property
    def stored_total(self) -> int:
        """Compressed size of every member — the file minus its ZIP scaffolding."""
        return sum(self.stored_sizes.values())

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<RkDocument {self.title!r} {len(self.markdown)} chars, "
            f"{len(self.manifest.assets)} assets, {self.asset_bytes_total} asset bytes>"
        )

    def __iter__(self) -> Iterator[Asset]:
        return iter(self.manifest.assets)


class Problem:
    """A validation finding. `severity` is one of error / warning / info."""

    __slots__ = ("severity", "message")

    def __init__(self, severity: str, message: str) -> None:
        self.severity = severity
        self.message = message

    def __str__(self) -> str:
        return f"{self.severity}: {self.message}"


def seen_paths_exact(manifest: Manifest) -> set[str]:
    return {a.path for a in manifest.assets}


def markdown_ref(asset: Asset) -> str:
    """The canonical Markdown image reference for an asset."""
    alt = (asset.alt or Path(asset.name).stem).replace("[", r"\[").replace("]", r"\]")
    return f"![{alt}]({asset.path})"


def _generator() -> str:
    from . import __version__

    return f"rkformat-py/{__version__}"


# Media types whose bytes are already entropy-coded. Deflating them costs CPU on every
# save and reliably returns under 1%, so we skip the attempt entirely.
INCOMPRESSIBLE_MEDIA_TYPES = frozenset(
    {"image/jpeg", "image/webp", "image/avif", "image/heic", "image/gif"}
)
_COMPRESSION_PROBE = 128 * 1024
_MIN_COMPRESSION_GAIN = 0.05


def _worth_deflating(payload: bytes, media_type: str | None) -> bool:
    """Decide per-asset whether deflate earns its keep.

    PNG is the interesting case: its IDAT stream is already deflated, but with a 32 KiB
    window, so a large flat image leaves long-range redundancy that an outer deflate pass
    does catch. Measured on real files that ranges from 1% (photographic) to 66% (flat
    gradients) — worth probing rather than assuming either way.
    """
    if media_type in INCOMPRESSIBLE_MEDIA_TYPES:
        return False
    if len(payload) < 512:
        return True  # too small for the probe to say anything useful
    sample = payload[:_COMPRESSION_PROBE]
    return len(zlib.compress(sample, 6)) < len(sample) * (1 - _MIN_COMPRESSION_GAIN)


def _write(
    zf: zipfile.ZipFile,
    name: str,
    payload: bytes,
    *,
    compress: bool = True,
    media_type: str | None = None,
) -> None:
    """Add a member with a fixed timestamp so archives are byte-reproducible."""
    if compress and media_type is not None:
        compress = _worth_deflating(payload, media_type)
    info = zipfile.ZipInfo(safe_member_name(name), date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED
    info.external_attr = 0o644 << 16
    zf.writestr(info, payload)


def _read_member(zf: zipfile.ZipFile, name: str, origin: str) -> bytes:
    """Read a member the document cannot do without, reporting damage clearly."""
    try:
        return zf.read(name)
    except (zipfile.BadZipFile, zlib.error, EOFError, OSError) as exc:
        raise RkfFormatError(f"{origin}: {name} is damaged and cannot be read: {exc}") from exc


def _enforce_limits(zf: zipfile.ZipFile, origin: str) -> None:
    """Zip-bomb guard, applied before anything is decompressed."""
    total = 0
    for info in zf.infolist():
        total += info.file_size
        if total > MAX_TOTAL_UNCOMPRESSED:
            raise RkfSecurityError(
                f"{origin}: uncompressed size exceeds "
                f"{MAX_TOTAL_UNCOMPRESSED // (1024 * 1024)} MiB limit"
            )
        if (
            info.file_size > _RATIO_FLOOR
            and info.compress_size > 0
            and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO
        ):
            raise RkfSecurityError(
                f"{origin}: member {info.filename!r} has a "
                f"{info.file_size / info.compress_size:.0f}x compression ratio "
                f"(limit {MAX_COMPRESSION_RATIO}x)"
            )


def _mask_code(text: str) -> str:
    """Blank out fenced/indented code spans, preserving offsets and line structure."""
    out = list(text)
    for match in re.finditer(r"(?ms)^([ \t]*)(`{3,}|~{3,})[^\n]*\n.*?^\1\2[^\S\n]*$", text):
        for i in range(*match.span()):
            if out[i] != "\n":
                out[i] = " "
    for match in re.finditer(r"`+[^`\n]+`+", "".join(out)):
        for i in range(*match.span()):
            out[i] = " "
    return "".join(out)
