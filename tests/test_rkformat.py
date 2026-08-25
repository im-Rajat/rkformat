"""Test suite for the .rkf container.

Runs under pytest, and also standalone (`python3 tests/test_rkformat.py`) so the format
can be verified in an environment without pytest installed.
"""

from __future__ import annotations

import io
import json
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import fixtures

from rkformat import MIMETYPE, Asset, Manifest, RkDocument, is_rkf
from rkformat.container import MANIFEST_MEMBER, MIMETYPE_MEMBER, markdown_ref
from rkformat.errors import (
    RkfError,
    RkfFormatError,
    RkfSecurityError,
    RkfValidationError,
    RkfVersionError,
)
from rkformat.imageinfo import sniff
from rkformat.manifest import safe_member_name
from rkformat.render import to_html

DIAGRAM = fixtures.png(320, 180)
PHOTO = fixtures.png(64, 48, (200, 120, 60))


def sample() -> RkDocument:
    doc = RkDocument.new(title="Sample", authors=["tester"])
    doc.markdown = "# Sample\n\nText before.\n\n"
    asset = doc.add_image_bytes(DIAGRAM, "diagram.png", alt="A diagram")
    doc.markdown += markdown_ref(asset) + "\n\nText after.\n"
    return doc


# --------------------------------------------------------------- image sniffing


def test_sniff_recognises_each_supported_type():
    assert sniff(DIAGRAM) == ("image/png", 320, 180)
    assert sniff(fixtures.gif(11, 22)) == ("image/gif", 11, 22)
    assert sniff(fixtures.jpeg(640, 480)) == ("image/jpeg", 640, 480)
    assert sniff(b'<svg width="10" height="20"></svg>') == ("image/svg+xml", 10, 20)
    assert sniff(b"not an image at all") is None


# ----------------------------------------------------------------- round tripping


def test_round_trip_preserves_text_and_bytes(tmp_path):
    doc = sample()
    path = doc.save(tmp_path / "s.rkf")
    reopened = RkDocument.open(path)
    assert reopened.markdown == doc.markdown
    assert reopened.title == "Sample"
    assert reopened.manifest.authors == ["tester"]
    assert reopened.asset_bytes("a1") == DIAGRAM
    assert reopened.assets[0].width == 320


def test_serialisation_is_byte_deterministic(tmp_path):
    doc = sample()
    doc.save(tmp_path / "s.rkf")
    first = doc.to_bytes(touch=False)
    second = doc.to_bytes(touch=False)
    assert first == second
    # Fixed ZIP timestamps, per SPEC.md section 5.
    with zipfile.ZipFile(io.BytesIO(first)) as zf:
        assert {i.date_time for i in zf.infolist()} == {(1980, 1, 1, 0, 0, 0)}


def test_magic_bytes_identify_the_format(tmp_path):
    path = sample().save(tmp_path / "s.rkf")
    assert is_rkf(path)
    assert is_rkf(path.read_bytes())
    plain = tmp_path / "plain.zip"
    with zipfile.ZipFile(plain, "w") as zf:
        zf.writestr("hello.txt", "hi")
    assert not is_rkf(plain)
    assert not is_rkf(tmp_path / "does-not-exist.rkf")


def test_mimetype_member_is_first_and_uncompressed(tmp_path):
    path = sample().save(tmp_path / "s.rkf")
    with zipfile.ZipFile(path) as zf:
        infos = zf.infolist()
    assert infos[0].filename == MIMETYPE_MEMBER
    assert infos[0].compress_type == zipfile.ZIP_STORED
    assert infos[1].filename == "content.md"
    assert infos[2].filename == MANIFEST_MEMBER


def test_body_is_readable_in_a_plain_text_editor(tmp_path):
    """The prose must be legible to someone with no .rkf tooling at all.

    content.md is stored uncompressed and placed second, so the text appears in the clear
    near the start of the file - what `cat`, `less` or Notepad would show.
    """
    doc = RkDocument.new(title="Readable")
    doc.markdown = "# Readable\n\nA distinctive sentence in the body.\n"
    doc.add_image_bytes(DIAGRAM, "diagram.png")
    raw = doc.save(tmp_path / "s.rkf").read_bytes()

    assert b"A distinctive sentence in the body." in raw
    # ...and near the front, not buried behind the image payloads.
    assert raw.index(b"A distinctive sentence") < 512
    with zipfile.ZipFile(tmp_path / "s.rkf") as zf:
        assert zf.getinfo("content.md").compress_type == zipfile.ZIP_STORED


def test_unpacked_folder_is_plain_markdown(tmp_path):
    doc = sample()
    root = doc.unpack(tmp_path / "out")
    assert (root / "content.md").read_text() == doc.markdown
    assert (root / "assets" / "diagram.png").read_bytes() == DIAGRAM
    # The relative link in the Markdown resolves on a plain filesystem.
    target = root / doc.references()[0].target
    assert target.is_file()


def test_pack_from_markdown_file_pulls_local_images(tmp_path):
    (tmp_path / "img").mkdir()
    (tmp_path / "img" / "pic.png").write_bytes(PHOTO)
    (tmp_path / "doc.md").write_text(
        "# T\n\n![Pic](img/pic.png)\n\n![Remote](https://example.com/x.png)\n\n![Gone](nope.png)\n"
    )
    doc, missing = RkDocument.from_markdown_file(tmp_path / "doc.md")
    assert [a.path for a in doc.assets] == ["assets/pic.png"]
    assert missing == ["nope.png"]
    assert "![Pic](assets/pic.png)" in doc.markdown
    assert "https://example.com/x.png" in doc.markdown  # external links untouched


def test_unknown_members_survive_a_save(tmp_path):
    path = sample().save(tmp_path / "s.rkf")
    with zipfile.ZipFile(path, "a") as zf:
        zf.writestr("meta/future-feature.json", '{"from": "a newer writer"}')
    doc = RkDocument.open(path, strict=False)
    doc.markdown += "\nedited\n"
    doc.save()
    with zipfile.ZipFile(path) as zf:
        assert zf.read("meta/future-feature.json") == b'{"from": "a newer writer"}'


# --------------------------------------------------------------------- references


def test_code_blocks_are_not_scanned_for_references():
    doc = RkDocument.new(markdown="`![x](a.png)`\n\n```\n![y](b.png)\n```\n\n![z](assets/z.png)\n")
    assert [r.target for r in doc.references()] == ["assets/z.png"]


def test_reference_resolution_forms():
    doc = RkDocument.new()
    asset = doc.add_image_bytes(DIAGRAM, "my pic.png")
    assert asset.path == "assets/my-pic.png"
    for form in ("assets/my-pic.png", "./assets/my-pic.png", "assets/my%2Dpic.png", "rkf:a1"):
        assert doc.resolve(form) is asset, form
    assert doc.resolve("https://example.com/a.png") is None
    assert doc.resolve("assets/missing.png") is None


def test_dangling_and_orphan_detection():
    doc = RkDocument.new(markdown="![a](assets/gone.png)\n")
    doc.add_image_bytes(PHOTO, "kept.png")
    problems = {p.severity: p.message for p in doc.validate()}
    assert "dangling image reference" in problems["error"]
    assert "never referenced" in problems["info"]
    assert [a.name for a in doc.orphan_assets()] == ["kept.png"]


def test_identical_bytes_are_stored_once():
    doc = RkDocument.new()
    first = doc.add_image_bytes(DIAGRAM, "a.png")
    second = doc.add_image_bytes(DIAGRAM, "b.png")
    assert first is second
    assert len(doc.assets) == 1


def test_remove_asset_can_prune_references():
    doc = sample()
    doc.remove_asset("a1", prune_refs=True)
    assert doc.assets == []
    assert "assets/diagram.png" not in doc.markdown
    assert doc.markdown.strip().endswith("Text after.")


# ---------------------------------------------------------------------- integrity


def test_sha_mismatch_is_reported(tmp_path):
    doc = sample()
    doc._blobs["assets/diagram.png"] = DIAGRAM + b"tampered"
    messages = [p.message for p in doc.validate() if p.severity == "error"]
    assert any("sha256 mismatch" in m for m in messages)
    assert any("bytes" in m for m in messages)


def test_declared_media_type_must_match_the_bytes():
    doc = RkDocument.new()
    asset = doc.add_image_bytes(DIAGRAM, "a.png")
    asset.media_type = "image/jpeg"
    assert any("bytes are image/png" in p.message for p in doc.validate())


def test_strict_open_rejects_an_invalid_document(tmp_path):
    doc = sample()
    doc.markdown += "\n![missing](assets/nope.png)\n"
    path = doc.save(tmp_path / "s.rkf")
    try:
        RkDocument.open(path, strict=True)
    except RkfValidationError as exc:
        assert "dangling" in str(exc)
    else:
        raise AssertionError("strict open should have raised")
    RkDocument.open(path, strict=False)  # non-strict still loads it for repair


def test_duplicate_ids_and_paths_are_errors():
    doc = RkDocument.new()
    doc.add_image_bytes(DIAGRAM, "a.png")
    clone = Asset(id="a1", path="assets/a.png", media_type="image/png", bytes=len(DIAGRAM),
                  sha256=doc.assets[0].sha256)
    doc.manifest.assets.append(clone)
    messages = [p.message for p in doc.validate()]
    assert any("duplicate asset id" in m for m in messages)
    assert any("duplicate asset path" in m for m in messages)


# ----------------------------------------------------------------------- security


def test_path_traversal_names_are_rejected():
    for bad in ("../escape.png", "/etc/passwd", "a\\b.png", "./x.png", "a//b.png", "", " x "):
        try:
            safe_member_name(bad)
        except RkfValidationError:
            continue
        raise AssertionError(f"accepted hostile member name {bad!r}")
    assert safe_member_name("assets/ok.png") == "assets/ok.png"


def test_zip_slip_member_is_refused_on_open(tmp_path):
    path = tmp_path / "evil.rkf"
    manifest = Manifest(title="evil", assets=[])
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(MIMETYPE_MEMBER, MIMETYPE)
        zf.writestr(MANIFEST_MEMBER, json.dumps(manifest.to_json()))
        zf.writestr("content.md", "# evil\n")
        zf.writestr("../../../../tmp/pwned.txt", "escaped")
    try:
        RkDocument.open(path, strict=False)
    except RkfValidationError as exc:
        assert "non-normalised" in str(exc)
    else:
        raise AssertionError("zip-slip member was not refused")


def test_compression_bomb_is_refused(tmp_path):
    path = tmp_path / "bomb.rkf"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(MIMETYPE_MEMBER, MIMETYPE)
        zf.writestr(MANIFEST_MEMBER, json.dumps(Manifest().to_json()))
        zf.writestr("content.md", "# x\n")
        zf.writestr("assets/bomb.png", b"\x00" * (8 * 1024 * 1024))
    try:
        RkDocument.open(path, strict=False)
    except RkfSecurityError as exc:
        assert "compression ratio" in str(exc)
    else:
        raise AssertionError("compression bomb was not refused")


def test_wrong_mimetype_is_refused_in_strict_mode(tmp_path):
    path = tmp_path / "notrkf.rkf"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(MIMETYPE_MEMBER, "application/epub+zip")
        zf.writestr(MANIFEST_MEMBER, json.dumps(Manifest().to_json()))
        zf.writestr("content.md", "# x\n")
    try:
        RkDocument.open(path, strict=True)
    except RkfFormatError as exc:
        assert "mimetype" in str(exc)
    else:
        raise AssertionError("wrong mimetype accepted in strict mode")
    assert RkDocument.open(path, strict=False).markdown == "# x\n"


def test_future_major_version_is_refused():
    try:
        Manifest.from_json({"rkf_version": "2.0", "content": "content.md", "assets": []})
    except RkfVersionError as exc:
        assert "2.0" in str(exc)
    else:
        raise AssertionError("a future major version was accepted")
    # A future MINOR is fine, and unknown keys are ignored.
    manifest = Manifest.from_json(
        {"rkf_version": "1.7", "content": "content.md", "assets": [], "future_key": 1}
    )
    assert manifest.rkf_version == "1.7"


def test_a_plain_zip_is_not_a_document(tmp_path):
    path = tmp_path / "plain.zip"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("a.txt", "hi")
    try:
        RkDocument.open(path)
    except RkfFormatError:
        return
    raise AssertionError("a plain zip was accepted as a .rkf")


# ------------------------------------------------------------------- size / storage


def test_incompressible_media_types_are_stored_not_deflated(tmp_path):
    doc = RkDocument.new(markdown="# x\n")
    # A JPEG is already entropy-coded; deflating it is pure CPU cost.
    doc.add_image_bytes(fixtures.jpeg(64, 64) + bytes(range(256)) * 40, "photo.jpg")
    path = doc.save(tmp_path / "s.rkf")
    with zipfile.ZipFile(path) as zf:
        entry = zf.getinfo("assets/photo.jpg")
    assert entry.compress_type == zipfile.ZIP_STORED


def test_compressible_assets_are_deflated(tmp_path):
    doc = RkDocument.new(markdown="# x\n")
    doc.add_image_bytes(b'<svg width="10" height="10">' + b" " * 4000 + b"</svg>", "flat.svg")
    path = doc.save(tmp_path / "s.rkf")
    with zipfile.ZipFile(path) as zf:
        entry = zf.getinfo("assets/flat.svg")
    assert entry.compress_type == zipfile.ZIP_DEFLATED
    assert entry.compress_size < entry.file_size


def test_size_accounting_never_reports_negative_overhead(tmp_path):
    """A well-compressing image must not make the container look smaller than its parts."""
    doc = RkDocument.new(markdown="# x\n")
    doc.add_image_bytes(fixtures.png(200, 200, (10, 10, 10)), "flat.png")
    path = doc.save(tmp_path / "s.rkf")
    reopened = RkDocument.open(path)
    overhead = path.stat().st_size - reopened.stored_total
    assert overhead > 0
    assert reopened.asset_stored_total <= reopened.asset_bytes_total
    assert reopened.stored_sizes["assets/flat.png"] > 0


def test_in_memory_document_falls_back_to_uncompressed_sizes():
    doc = RkDocument.new()
    doc.add_image_bytes(DIAGRAM, "d.png")
    assert doc.stored_sizes == {}
    assert doc.asset_stored_total == doc.asset_bytes_total == len(DIAGRAM)


# ---------------------------------------------------------------- generated files


# Every file docs/build.py copies into the extension. Listed here rather than inferred, so
# adding a shared file without adding it to the build is caught.
GENERATED_COPIES = ("tomarkdown.js", "toolbar.js", "highlight.js", "highlight.css")


def test_generated_extension_copies_are_current():
    """docs/build.py copies shared assets into the extension; they must not drift."""
    root = Path(__file__).resolve().parents[1]
    media = root / "vscode-extension" / "media"
    if not media.is_dir():
        return  # the extension folder is optional in a source checkout
    for name in GENERATED_COPIES:
        source = root / "docs" / "assets" / name
        copy = media / name
        assert source.is_file(), f"docs/assets/{name} is missing"
        assert copy.is_file(), f"{name} was never copied - run python3 docs/build.py"
        assert source.read_text() in copy.read_text(), (
            f"{name} is stale - run python3 docs/build.py"
        )


def test_every_shared_asset_is_copied():
    """A shared file the extension loads must be in the build script's list."""
    root = Path(__file__).resolve().parents[1]
    extension = root / "vscode-extension" / "extension.js"
    if not extension.is_file():
        return
    referenced = set(re.findall(r'media\("([^"]+)"\)', extension.read_text()))
    # These belong to the extension itself rather than being copied from docs/assets.
    own = {"editor.js", "editor.css"}
    for name in sorted(referenced - own):
        assert name in GENERATED_COPIES, (
            f"the webview loads {name}, but docs/build.py does not copy it"
        )


def test_generated_stylesheet_matches_page_css():
    root = Path(__file__).resolve().parents[1]
    generated = root / "docs" / "assets" / "document.css"
    if not generated.is_file():
        return
    from rkformat.render import PAGE_CSS

    assert PAGE_CSS in generated.read_text(), "document.css is stale - run python3 docs/build.py"


# ------------------------------------------------------------------------ render


def test_render_inlines_images_and_captions_them():
    html = to_html(sample())
    assert "data:image/png;base64," in html
    assert "<figcaption>A diagram</figcaption>" in html
    # Asserted separately: the sanitising pass emits attributes in sorted order, so their
    # adjacency is not part of the contract.
    assert 'width="320"' in html
    assert 'height="180"' in html


def test_render_marks_dangling_references():
    html = to_html(RkDocument.new(markdown="![gone](assets/gone.png)\n"))
    assert "rkf-missing" in html
    assert 'data-rkf-dangling="assets/gone.png"' in html


def test_render_never_passes_script_through():
    doc = RkDocument.new(markdown="<script>alert(1)</script>\n\nsafe\n")
    sanitised = to_html(doc)
    assert "<script>" not in sanitised
    assert "alert(1)" not in sanitised  # dropped with its content, not merely escaped
    assert "safe" in sanitised
    assert "&lt;script&gt;" in to_html(doc, html="escape")
    assert "<script>" in to_html(doc, html="raw")  # opt-in, for documents you wrote


def test_html_image_resolves_to_an_embedded_asset():
    doc = RkDocument.new()
    doc.add_image_bytes(DIAGRAM, "diagram.png")
    doc.markdown = '<img src="assets/diagram.png" alt="drawing" width="200"/>\n'
    html = to_html(doc)
    assert "data:image/png;base64," in html
    assert 'width="200"' in html          # the author's size is respected
    assert 'height="180"' not in html     # ...so intrinsic dimensions are not forced
    assert "rkf-image" in html


def test_html_allowlist_survives_a_second_pass():
    """Sanitising is idempotent, so re-rendering cannot degrade a document."""
    from rkformat.sanitize import sanitize

    markup = (
        '<div align="center"><b>bold</b> <kbd>K</kbd>'
        '<img src="x.png" width="10"></div>'
    )
    once = sanitize(markup)
    assert sanitize(once) == once


def test_render_rejects_an_unknown_html_mode():
    try:
        to_html(RkDocument.new(), html="whatever")
    except RkfError as exc:
        assert "html must be one of" in str(exc)
    else:
        raise AssertionError("an invalid html mode was accepted")


# ------------------------------------------------------- standalone test runner


def _run_standalone() -> int:
    """Minimal pytest stand-in: discovers test_* functions and fakes `tmp_path`."""
    import inspect
    import tempfile
    import traceback

    tests = [
        (name, fn)
        for name, fn in sorted(globals().items())
        if name.startswith("test_") and callable(fn)
    ]
    failures = 0
    for name, fn in tests:
        with tempfile.TemporaryDirectory(prefix="rkf-test-") as tmp:
            kwargs = {}
            if "tmp_path" in inspect.signature(fn).parameters:
                kwargs["tmp_path"] = Path(tmp)
            try:
                fn(**kwargs)
                print(f"  ok    {name}")
            except Exception:
                failures += 1
                print(f"  FAIL  {name}")
                traceback.print_exc()
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(_run_standalone())
