# rkformat — the `.rkf` document

**Markdown, plus its images, in one file you can just send someone.**

A `.rkf` file holds a Markdown body and every image it references. No sidecar `images/`
folder, no broken links in the email, no base64 bloat in the text. The file grows by
roughly the true size of the pictures, and images stay images — they are never converted
to text.

```
$ rk pack notes.md -o notes.rkf
packed notes.rkf (87.2 KB) — 3 image(s), 106.8 KB of assets

$ rk info examples/welcome.rkf
             title  Welcome to .rkf
              text  1.6 KB (1648 chars)
            assets  3 image(s), 106.8 KB raw
    assets in file  85.3 KB (20% smaller)
container overhead  642 B
        references  3 (0 dangling)
```

It is a ZIP container underneath, the same way `.docx`, `.odt` and `.epub` are. That buys
three things worth having: images stored as raw bytes rather than base64, random access to
a single image without reading the whole document, and **graceful degradation** — rename it
to `.zip`, extract it, and `content.md` is ordinary Markdown with working relative links.

See [SPEC.md](SPEC.md) for the format itself, and
[examples/welcome.rkf](examples/welcome.rkf) for a document to open — rebuild it any time
with `python3 examples/make_welcome.py`.

## Install

Python 3.10+. One dependency: `markdown-it-py`, for rendering.

```bash
uv tool install --editable .    # puts `rk` on your PATH, editable
```

Ubuntu 24.04 and other recent distros ship no `pip` and refuse system-wide installs
(PEP 668), so `uv` or `pipx` is the path of least resistance:

```bash
pipx install -e .                              # same thing via pipx
python3 -m venv .venv && .venv/bin/pip install -e .   # plain venv
```

**Or don't install it at all.** The package is pure Python with one dependency that most
distros already package, so a working copy runs as-is:

```bash
PYTHONPATH=src python3 -m rkformat info notes.rkf
```

To remove it later: `uv tool uninstall rkformat`.

## Use

```bash
# Build one from a Markdown file — every local image it links gets pulled in
rk pack notes.md -o notes.rkf

# Or start from scratch
rk new report.rkf --title "Q3 Review"
rk add report.rkf chart.png photo.jpg --alt "Revenue by region"
rk edit report.rkf                      # opens $EDITOR on the body

# Look inside
rk info report.rkf
rk ls report.rkf
rk cat report.rkf                       # just the Markdown
rk check report.rkf                     # verify every asset's checksum

# Get things out
rk render report.rkf --open             # one self-contained .html, images inlined
rk extract report.rkf a1 -o chart.png   # pull one image back out
rk unpack report.rkf -d report/         # explode to a plain Markdown folder
rk pack report/ -o report.rkf           # ...and put it back together

# Housekeeping
rk gc report.rkf                        # drop images the body no longer references
```

`rk --help` lists every command.

## Use from Python

```python
from rkformat import RkDocument

doc = RkDocument.new(title="Q3 Review", authors=["you@example.com"])
doc.markdown = "# Q3 Review\n\nRevenue held up:\n\n"
doc.append_image("chart.png", alt="Revenue by region")   # embeds *and* references it
doc.save("report.rkf")

reopened = RkDocument.open("report.rkf")
print(reopened.title, len(reopened.assets), reopened.asset_bytes_total)
print(reopened.asset_bytes("a1")[:8])                    # raw PNG bytes back out
open("report.html", "w").write(reopened.to_html())       # via rkformat.render.to_html
```

## Read one in the browser

[**im-rajat.github.io/rkformat**](https://im-rajat.github.io/rkformat/) opens a `.rkf`
without installing anything. Drop a file on it, paste a link, or share a deep link:

```
https://im-rajat.github.io/rkformat/?url=https://github.com/you/repo/blob/main/notes.rkf
```

GitHub `blob` links are rewritten to `raw.githubusercontent.com` automatically. Any other
host has to allow cross-origin reads; otherwise download the file and drop it in.

The whole thing is client-side. A `.rkf` is a ZIP, so the browser can open one unaided —
the central directory gives random access and `DecompressionStream('deflate-raw')` handles
the compressed members. Every asset's SHA-256 is recomputed with WebCrypto, so the site
runs the same integrity checks as `rk check`. **Nothing is uploaded**, and the page makes no
third-party requests.

It lives in [docs/](docs/) and is served by GitHub Pages from that folder — static files,
no build step, no dependencies.

### The one place this project has two implementations

The site cannot call the Python renderer the way the VS Code extension does, so
[docs/assets/markdown.js](docs/assets/markdown.js) is a second Markdown implementation.
That is a real risk of drift, handled two ways:

- **Styling cannot drift.** `docs/assets/document.css` is generated from
  `rkformat.render.PAGE_CSS` by [docs/build.py](docs/build.py).
- **Rendering is diffed.** [tests/test_site_parity.js](tests/test_site_parity.js) renders 57
  fixtures — including nested emphasis, tight and loose lists, tables, and script-injection
  attempts — through both renderers and compares the HTML. Where they disagree, `rk render`
  is canonical.

Building that test immediately paid for itself: it caught a broken regex that silently
disabled every inline link and image, `***text***` emitting overlapping tags, and a
`linkify` setting whose effect depended on whether an optional package happened to be
installed.

## Edit it in VS Code

[vscode-extension/](vscode-extension/) is a custom editor: Markdown source on the left, a
Word-like rendered page on the right, and **paste or drag an image straight into the
document**. It has no dependencies and no build step — it shells out to the `rk` CLI, so the
editor and the command line can never disagree about what a document means.

```bash
cd vscode-extension && ./install.sh
```

See [vscode-extension/README.md](vscode-extension/README.md) for settings and packaging.

## What it is and isn't

**Is:** a container. Text stays text, images stay images, both travel together. Think
TextBundle with checksums and a validator, or a much smaller `.docx`.

**Isn't:** a word processor file. There is no styled-run model, no revision history, no
comments. Formatting is whatever Markdown expresses. If you need tracked changes and
paragraph styles, you need `.docx`.

## Design notes

- **Storage.** Raw bytes in the ZIP, so no +33% base64 penalty. Duplicate images are
  stored once — assets are keyed by SHA-256. Already-compressed formats (JPEG, WebP, GIF,
  AVIF, HEIC) are stored uncompressed rather than deflated, because deflating them returns
  under 1%; everything else is probed and compressed only if it saves ≥5%.
- **Degradation.** `content.md` is unmodified CommonMark referencing `assets/foo.png`. The
  format is a convenience, never a trap.
- **Determinism.** Writers use fixed ZIP timestamps and sorted keys, so identical content
  produces byte-identical files. Useful for checksums and content-addressed storage.
- **Integrity.** Every asset carries its length and SHA-256; `rk check` verifies them, and
  catches dangling references, orphaned images, and media types that don't match the bytes.
- **Hardening.** A `.rkf` arrives from someone else, so readers reject path traversal in
  member names, cap decompression ratio and total size, sniff magic bytes instead of
  trusting extensions, and do not render embedded HTML unless asked.

## Tests

```bash
pytest                          # the format library - or, with no pytest installed:
python3 tests/test_rkformat.py

node tests/test_site_parity.js   # browser renderer vs. `rk render`, 57 fixtures
tests/test_site_browser.sh       # drives headless Chrome over the viewer
```

The Python suite covers round-tripping, determinism, reference resolution (including
code-fence masking), integrity checks, and the security limits above. Image fixtures are
synthesised with the standard library, so there are no binary files in the repo beyond the
demo document.

`test_site_browser.sh` needs a Chrome or Chromium binary and skips cleanly if there isn't
one, so it never turns into a false failure.

## Layout

| Path | What |
|---|---|
| [SPEC.md](SPEC.md) | The format specification |
| [src/rkformat/container.py](src/rkformat/container.py) | Read, write, mutate, validate |
| [src/rkformat/manifest.py](src/rkformat/manifest.py) | `manifest.json` model |
| [src/rkformat/imageinfo.py](src/rkformat/imageinfo.py) | Stdlib-only image sniffing |
| [src/rkformat/render.py](src/rkformat/render.py) | HTML rendering and page styles |
| [src/rkformat/cli.py](src/rkformat/cli.py) | The `rk` command |
| [vscode-extension/](vscode-extension/) | VS Code custom editor |
| [docs/](docs/) | The browser viewer, served by GitHub Pages |
| [examples/](examples/) | A demo document and the script that builds it |

## Possible next steps

- A **text-safe variant** (MIME multipart with base64 parts) for channels that only carry
  text, as a `--text-safe` export alongside the canonical ZIP.
- **Editing in the browser viewer.** It is read-only today; writing a ZIP client-side with
  `CompressionStream` is very doable, but saving back to wherever the file came from is the
  actual problem.
- **TextBundle interop** — `.textbundle`/`.textpack` is a near-identical layout, so
  import/export would be cheap and buys compatibility with Ulysses, Bear and iA Writer.
- Non-image assets with richer typing, and a thumbnail cache in `meta/` for fast listing.
