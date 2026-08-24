"""`rk` — command line interface for the .rkf compound document format."""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import webbrowser
from pathlib import Path

from . import __version__
from .container import MANIFEST_MEMBER, RkDocument, is_rkf, markdown_ref
from .errors import RkfError
from .render import _human, to_html

PROG = "rk"


# --------------------------------------------------------------------- helpers


def _out(message: str = "") -> None:
    print(message)


def _err(message: str) -> None:
    print(f"{PROG}: {message}", file=sys.stderr)


def _load(path: str, *, strict: bool = False) -> RkDocument:
    """Open a document. Non-strict by default so `rk check` can diagnose broken files."""
    return RkDocument.open(path, strict=strict)


def _resolve_out(explicit: str | None, source: Path, suffix: str) -> Path:
    return Path(explicit) if explicit else source.with_suffix(suffix)


def _confirm_overwrite(path: Path, force: bool) -> None:
    if path.exists() and not force:
        raise RkfError(f"{path} already exists (use --force to overwrite)")


# ---------------------------------------------------------------- new / pack


def cmd_new(args: argparse.Namespace) -> int:
    target = Path(args.output)
    _confirm_overwrite(target, args.force)
    title = args.title or target.stem
    body = f"# {title}\n\n" if args.scaffold else ""
    doc = RkDocument.new(title=title, markdown=body, authors=args.author or [])
    for image in args.image or []:
        doc.append_image(image)
    doc.save(target)
    _out(f"created {target} ({_human(target.stat().st_size)}, {len(doc.assets)} assets)")
    return 0


def cmd_pack(args: argparse.Namespace) -> int:
    source = Path(args.source)
    target = _resolve_out(args.output, source, ".rkf")
    _confirm_overwrite(target, args.force)

    if source.is_dir():
        doc, missing = _pack_dir(source)
    elif source.suffix.lower() in (".md", ".markdown", ".txt"):
        doc, missing = RkDocument.from_markdown_file(source, title=args.title)
    else:
        raise RkfError(f"don't know how to pack {source} (expected a .md file or a folder)")

    if args.title:
        doc.manifest.title = args.title
    if args.author:
        doc.manifest.authors = list(args.author)

    for reference in missing:
        _err(f"warning: could not find image {reference!r} on disk — left as a dead link")

    doc.save(target)
    _out(
        f"packed {target} ({_human(target.stat().st_size)}) "
        f"— {len(doc.assets)} image(s), {_human(doc.asset_bytes_total)} of assets"
    )
    return 0


def _pack_dir(root: Path) -> tuple[RkDocument, list[str]]:
    """Rebuild a document from an unpacked folder (the inverse of `rk unpack`)."""
    manifest_path = root / MANIFEST_MEMBER
    candidates = sorted(root.glob("*.md"))
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        content_name = manifest.get("content", "content.md")
    elif candidates:
        content_name = candidates[0].name
    else:
        raise RkfError(f"{root} has no {MANIFEST_MEMBER} and no .md file to use as content")

    content = root / content_name
    if not content.is_file():
        raise RkfError(f"{root}: content file {content_name!r} is missing")
    doc, missing = RkDocument.from_markdown_file(content)

    # Carry over metadata and any images present but not yet referenced.
    if manifest_path.is_file():
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        doc.manifest.title = raw.get("title") or doc.manifest.title
        doc.manifest.authors = [str(a) for a in raw.get("authors") or []]
        doc.manifest.created = raw.get("created") or doc.manifest.created
        doc.manifest.extra = dict(raw.get("extra") or {})
    assets_dir = root / "assets"
    if assets_dir.is_dir():
        for image in sorted(assets_dir.iterdir()):
            if image.is_file():
                try:
                    doc.add_image(image)
                except RkfError:
                    _err(f"warning: skipping unrecognised asset {image.name}")
    return doc, missing


def cmd_unpack(args: argparse.Namespace) -> int:
    doc = _load(args.file)
    target = Path(args.directory) if args.directory else Path(args.file).with_suffix("")
    if target.exists() and any(target.iterdir()) and not args.force:
        raise RkfError(f"{target} is not empty (use --force)")
    doc.unpack(target)
    _out(f"unpacked into {target}/ — {MANIFEST_MEMBER}, {doc.manifest.content}, assets/")
    _out("this folder is ordinary Markdown; `rk pack` puts it back together")
    return 0


# ------------------------------------------------------------------ inspection


def cmd_info(args: argparse.Namespace) -> int:
    path = Path(args.file)
    doc = _load(args.file)
    total = path.stat().st_size
    stored = doc.asset_stored_total
    raw = doc.asset_bytes_total
    # Everything the ZIP costs beyond the compressed payloads: headers and the central
    # directory. Comparing against *uncompressed* assets would go negative whenever the
    # images happen to deflate well.
    overhead = total - doc.stored_total
    saved = f" ({(1 - stored / raw):.0%} smaller)" if raw and stored < raw else ""
    rows = [
        ("file", str(path)),
        ("title", doc.title),
        ("spec version", doc.manifest.rkf_version),
        ("generator", doc.manifest.generator or "-"),
        ("authors", ", ".join(doc.manifest.authors) or "-"),
        ("created", doc.manifest.created or "-"),
        ("modified", doc.manifest.modified or "-"),
        ("file size", _human(total)),
        ("text", f"{_human(len(doc.markdown.encode()))} ({len(doc.markdown)} chars)"),
        ("assets", f"{len(doc.assets)} image(s), {_human(doc.asset_bytes_total)} raw"),
        ("assets in file", _human(stored) + saved),
        ("container overhead", _human(overhead)),
    ]
    refs = doc.references()
    dangling = [r for r in refs if r.dangling]
    orphans = doc.orphan_assets()
    rows.append(("references", f"{len(refs)} ({len(dangling)} dangling)"))
    if orphans:
        rows.append(("unreferenced", f"{len(orphans)} asset(s)"))
    width = max(len(k) for k, _ in rows)
    for key, value in rows:
        _out(f"{key.rjust(width)}  {value}")
    return 0


def cmd_ls(args: argparse.Namespace) -> int:
    doc = _load(args.file)
    if args.json:
        _out(json.dumps([a.to_json() for a in doc.assets], indent=2))
        return 0
    if not doc.assets:
        _out("no embedded assets")
        return 0
    used = {r.asset.id for r in doc.references() if r.asset}
    header = ("ID", "PATH", "TYPE", "SIZE", "DIMENSIONS", "REF")
    rows = [
        (
            a.id,
            a.path,
            a.media_type.removeprefix("image/"),
            _human(a.bytes),
            f"{a.width}x{a.height}" if a.width and a.height else "-",
            "yes" if a.id in used else "ORPHAN",
        )
        for a in doc.assets
    ]
    widths = [max(len(r[i]) for r in (header, *rows)) for i in range(len(header))]
    _out("  ".join(h.ljust(w) for h, w in zip(header, widths)).rstrip())
    for row in rows:
        _out("  ".join(c.ljust(w) for c, w in zip(row, widths)).rstrip())
    return 0


def cmd_cat(args: argparse.Namespace) -> int:
    sys.stdout.write(_load(args.file).markdown)
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    path = Path(args.file)
    if not is_rkf(path):
        _err(f"{path}: magic bytes do not identify this as a .rkf container")
        if not args.lenient:
            return 2
    doc = _load(args.file)
    problems = doc.validate()
    if args.json:
        _out(json.dumps([{"severity": p.severity, "message": p.message} for p in problems], indent=2))
    else:
        for problem in problems:
            _out(str(problem))
        errors = sum(p.severity == "error" for p in problems)
        warnings = sum(p.severity == "warning" for p in problems)
        if not errors:
            _out(f"OK — {len(doc.assets)} asset(s) verified, {warnings} warning(s)")
    if args.json:
        return 0  # the payload carries the severities; exit status would be redundant
    return 1 if any(p.severity == "error" for p in problems) else 0


# -------------------------------------------------------------------- mutation


def cmd_add(args: argparse.Namespace) -> int:
    doc = _load(args.file)
    for image in args.image:
        if args.no_append:
            asset = doc.add_image(image, alt=args.alt)
        else:
            asset = doc.append_image(image, alt=args.alt)
        _out(f"added {asset.id}  {asset.path}  {_human(asset.bytes)}  ->  {markdown_ref(asset)}")
    doc.save()
    return 0


def cmd_rm(args: argparse.Namespace) -> int:
    doc = _load(args.file)
    for reference in args.ref:
        asset = doc.remove_asset(reference, prune_refs=args.prune)
        _out(f"removed {asset.id} ({asset.path}, {_human(asset.bytes)})")
    doc.save()
    return 0


def cmd_gc(args: argparse.Namespace) -> int:
    doc = _load(args.file)
    orphans = doc.orphan_assets()
    if not orphans:
        _out("nothing to collect — every asset is referenced")
        return 0
    freed = 0
    for asset in orphans:
        doc.remove_asset(asset.id)
        freed += asset.bytes
        _out(f"dropped {asset.id} ({asset.path}, {_human(asset.bytes)})")
    doc.save()
    _out(f"reclaimed {_human(freed)}")
    return 0


def cmd_set(args: argparse.Namespace) -> int:
    doc = _load(args.file)
    if args.title is not None:
        doc.manifest.title = args.title
    if args.author:
        doc.manifest.authors = list(args.author)
    if args.alt:
        for pair in args.alt:
            ref, _, text = pair.partition("=")
            asset = doc.find_asset(ref)
            if asset is None:
                raise RkfError(f"no such asset: {ref!r}")
            asset.alt = text
    doc.save()
    _out(f"updated {args.file}")
    return 0


def cmd_edit(args: argparse.Namespace) -> int:
    doc = _load(args.file)
    editor = args.editor or os.environ.get("VISUAL") or os.environ.get("EDITOR") or "nano"
    with tempfile.TemporaryDirectory(prefix="rk-edit-") as tmp:
        scratch = Path(tmp) / doc.manifest.content
        scratch.write_text(doc.markdown, encoding="utf-8")
        before = scratch.read_bytes()
        subprocess.run([*editor.split(), str(scratch)], check=False)
        after = scratch.read_bytes()
        if after == before:
            _out("no changes")
            return 0
        doc.markdown = after.decode("utf-8")
    doc.save()
    dangling = [r.target for r in doc.references() if r.dangling]
    for target in dangling:
        _err(f"warning: reference {target!r} does not resolve to an embedded asset")
    _out(f"saved {args.file}")
    return 0


def cmd_extract(args: argparse.Namespace) -> int:
    doc = _load(args.file)
    targets = args.ref or [a.id for a in doc.assets]
    destination = Path(args.output or ".")
    if len(targets) > 1 or destination.is_dir():
        destination.mkdir(parents=True, exist_ok=True)
        for reference in targets:
            asset = doc.find_asset(reference)
            if asset is None:
                raise RkfError(f"no such asset: {reference!r}")
            out = destination / asset.name
            out.write_bytes(doc.asset_bytes(asset))
            _out(f"wrote {out} ({_human(asset.bytes)})")
    else:
        asset = doc.find_asset(targets[0])
        if asset is None:
            raise RkfError(f"no such asset: {targets[0]!r}")
        destination.write_bytes(doc.asset_bytes(asset))
        _out(f"wrote {destination} ({_human(asset.bytes)})")
    return 0


# --------------------------------------------------------------------- output


def cmd_render(args: argparse.Namespace) -> int:
    doc = _load(args.file)
    html_text = to_html(doc, allow_html=args.allow_html, show_meta=not args.no_meta)
    if args.output == "-":
        sys.stdout.write(html_text)
        return 0
    target = _resolve_out(args.output, Path(args.file), ".html")
    target.write_text(html_text, encoding="utf-8")
    _out(f"rendered {target} ({_human(target.stat().st_size)}, fully self-contained)")
    if args.open:
        webbrowser.open(target.resolve().as_uri())
    return 0


def cmd_view(args: argparse.Namespace) -> int:
    doc = _load(args.file)
    tmp = Path(tempfile.mkdtemp(prefix="rk-view-")) / (Path(args.file).stem + ".html")
    tmp.write_text(to_html(doc, allow_html=args.allow_html), encoding="utf-8")
    _out(f"opening {tmp}")
    webbrowser.open(tmp.resolve().as_uri())
    return 0


def cmd_export_json(args: argparse.Namespace) -> int:
    """Machine-readable dump used by the VS Code extension."""
    doc = _load(args.file)
    payload = {
        "path": str(Path(args.file).resolve()),
        "title": doc.title,
        "markdown": doc.markdown,
        "manifest": doc.manifest.to_json(),
        "html": to_html(doc, standalone=False, allow_html=args.allow_html),
        "assets": [
            {
                **asset.to_json(),
                "data_uri": "data:{};base64,{}".format(
                    asset.media_type,
                    base64.b64encode(doc.asset_bytes(asset)).decode("ascii"),
                ),
            }
            for asset in doc.assets
        ],
        "problems": [
            {"severity": p.severity, "message": p.message} for p in doc.validate()
        ],
    }
    json.dump(payload, sys.stdout)
    return 0


def cmd_import_json(args: argparse.Namespace) -> int:
    """Apply an edit described by JSON on stdin. Counterpart of `export-json`."""
    request = json.load(sys.stdin)
    doc = _load(args.file)
    if "markdown" in request:
        doc.markdown = str(request["markdown"])
    if request.get("title") is not None:
        doc.manifest.title = str(request["title"])
    added = []
    for item in request.get("add_images") or []:
        data = base64.b64decode(item["data_base64"])
        asset = doc.add_image_bytes(data, item.get("filename") or "pasted.png", alt=item.get("alt"))
        added.append({**asset.to_json(), "markdown": markdown_ref(asset)})
    for reference in request.get("remove_assets") or []:
        doc.remove_asset(reference, prune_refs=bool(request.get("prune_refs")))
    doc.save()
    json.dump(
        {
            "ok": True,
            "added": added,
            "bytes": Path(args.file).stat().st_size,
            "manifest": doc.manifest.to_json(),
        },
        sys.stdout,
    )
    return 0


def cmd_preview(args: argparse.Namespace) -> int:
    """Render a *candidate* body without saving. Drives the live editor preview.

    `pending` carries images the editor holds but has not committed yet, so a
    just-pasted picture previews before the document is saved.
    """
    raw = "" if sys.stdin.isatty() else sys.stdin.read()
    request = json.loads(raw) if raw.strip() else {}
    doc = _load(args.file)
    if "markdown" in request:
        doc.markdown = str(request["markdown"])
    for item in request.get("pending") or []:
        doc.add_image_bytes(
            base64.b64decode(item["data_base64"]),
            item.get("filename") or "pasted.png",
            alt=item.get("alt"),
        )
    json.dump(
        {
            "html": to_html(doc, standalone=False, allow_html=args.allow_html, show_meta=False),
            "assets": [a.to_json() for a in doc.assets],
            "problems": [
                {"severity": p.severity, "message": p.message} for p in doc.validate()
            ],
        },
        sys.stdout,
    )
    return 0


def cmd_css(args: argparse.Namespace) -> int:
    """Emit the document stylesheet, so every viewer styles pages identically."""
    from .render import PAGE_CSS

    sys.stdout.write(PAGE_CSS)
    return 0


# ---------------------------------------------------------------------- parser


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROG,
        description="Work with .rkf documents: Markdown with its images embedded in one file.",
        epilog="Run `rk <command> -h` for per-command options.",
    )
    parser.add_argument("--version", action="version", version=f"rkformat {__version__}")
    subs = parser.add_subparsers(dest="command", metavar="<command>", required=True)

    def add(name: str, handler, help_text: str, **kwargs):
        sub = subs.add_parser(name, help=help_text, description=help_text, **kwargs)
        sub.set_defaults(func=handler)
        return sub

    p = add("new", cmd_new, "Create an empty or image-seeded document.")
    p.add_argument("output")
    p.add_argument("-t", "--title")
    p.add_argument("-a", "--author", action="append")
    p.add_argument("-i", "--image", action="append", metavar="FILE", help="embed and reference an image")
    p.add_argument("--no-scaffold", dest="scaffold", action="store_false", help="skip the '# Title' heading")
    p.add_argument("-f", "--force", action="store_true")

    p = add("pack", cmd_pack, "Build a .rkf from a Markdown file (pulling in its images) or an unpacked folder.")
    p.add_argument("source")
    p.add_argument("-o", "--output")
    p.add_argument("-t", "--title")
    p.add_argument("-a", "--author", action="append")
    p.add_argument("-f", "--force", action="store_true")

    p = add("unpack", cmd_unpack, "Explode a .rkf into a plain Markdown folder.")
    p.add_argument("file")
    p.add_argument("-d", "--directory")
    p.add_argument("-f", "--force", action="store_true")

    p = add("info", cmd_info, "Show metadata and a size breakdown.")
    p.add_argument("file")

    p = add("ls", cmd_ls, "List embedded assets.")
    p.add_argument("file")
    p.add_argument("--json", action="store_true")

    p = add("cat", cmd_cat, "Print the Markdown body to stdout.")
    p.add_argument("file")

    p = add("check", cmd_check, "Validate the container against the spec.")
    p.add_argument("file")
    p.add_argument("--json", action="store_true", help="machine-readable findings; always exits 0")
    p.add_argument("--lenient", action="store_true", help="do not fail on a bad mimetype member")

    p = add("add", cmd_add, "Embed image files and reference them at the end of the body.")
    p.add_argument("file")
    p.add_argument("image", nargs="+")
    p.add_argument("--alt")
    p.add_argument("--no-append", action="store_true", help="embed without touching the Markdown")

    p = add("rm", cmd_rm, "Remove assets by id, path, or filename.")
    p.add_argument("file")
    p.add_argument("ref", nargs="+")
    p.add_argument("--prune", action="store_true", help="also delete the Markdown references")

    p = add("gc", cmd_gc, "Drop assets that the body no longer references.")
    p.add_argument("file")

    p = add("set", cmd_set, "Update document metadata.")
    p.add_argument("file")
    p.add_argument("-t", "--title")
    p.add_argument("-a", "--author", action="append")
    p.add_argument("--alt", action="append", metavar="REF=TEXT", help="set an asset's alt text")

    p = add("edit", cmd_edit, "Open the Markdown body in $EDITOR and save it back.")
    p.add_argument("file")
    p.add_argument("--editor")

    p = add("extract", cmd_extract, "Write embedded images back out as files.")
    p.add_argument("file")
    p.add_argument("ref", nargs="*")
    p.add_argument("-o", "--output", help="output file, or directory for multiple assets")

    p = add("render", cmd_render, "Render to a single self-contained HTML file.")
    p.add_argument("file")
    p.add_argument("-o", "--output", help="'-' for stdout")
    p.add_argument("--open", action="store_true", help="open the result in a browser")
    p.add_argument("--allow-html", action="store_true", help="render raw HTML in the body (unsafe)")
    p.add_argument("--no-meta", action="store_true")

    p = add("view", cmd_view, "Render to a temp file and open it in a browser.")
    p.add_argument("file")
    p.add_argument("--allow-html", action="store_true")

    p = add("export-json", cmd_export_json, "Dump the document as JSON (used by the VS Code editor).")
    p.add_argument("file")
    p.add_argument("--allow-html", action="store_true")

    p = add("import-json", cmd_import_json, "Apply a JSON edit from stdin and save.")
    p.add_argument("file")

    p = add("preview", cmd_preview, "Render candidate Markdown from stdin without saving.")
    p.add_argument("file")
    p.add_argument("--allow-html", action="store_true")

    p = add("css", cmd_css, "Print the shared document stylesheet.")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except RkfError as exc:
        _err(str(exc))
        return 1
    except BrokenPipeError:  # pragma: no cover - `rk cat | head`
        return 0
    except KeyboardInterrupt:  # pragma: no cover
        return 130


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
