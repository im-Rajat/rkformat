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
four things worth having: images stored as raw bytes rather than base64, random access to
a single image without reading the whole document, **graceful degradation** — rename it
to `.zip`, extract it, and `content.md` is ordinary Markdown with working relative links —
and **legibility with no tooling at all**: the body is stored uncompressed and placed first,
so opening a `.rkf` in Notepad or `less` shows readable Markdown after a short header.

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
rk share report.rkf                     # one .html anyone can open, with the .rkf inside it
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

## Raw HTML is supported

Markdown permits raw HTML, so this works — and points at the **embedded** image, not a file
on disk:

```html
<img src="assets/diagram.png" alt="drawing" width="200"/>
```

An `<img>` in HTML is resolved against the asset table exactly like `![alt](assets/x.png)`,
so a dangling `src` is reported by `rk check` the same way. `<div align>`, `<kbd>`, `<sub>`,
`<details>`, `<table>`, `<span style>` and the rest of the text-level vocabulary all work.

Because a document arrives from someone else, HTML is **rebuilt from an allowlist** rather
than passed through. Script-bearing elements are dropped with their contents, event-handler
attributes and unknown URL schemes are removed, and `style` is limited to a fixed set of
harmless properties. Three modes:

```bash
rk render doc.rkf                  # sanitize (default)
rk render doc.rkf --html escape    # show the markup as literal text
rk render doc.rkf --html raw       # pass through untouched; only for your own documents
```

The reference implementations are [rkformat/sanitize.py](src/rkformat/sanitize.py) and
[docs/assets/sanitize.js](docs/assets/sanitize.js), and the parity test diffs them over a
battery of hostile inputs.

## Task lists

GitHub-flavoured checkboxes work:

```markdown
- [x] Ship the viewer
- [ ] Write the announcement
```

They render as real checkboxes, and in the VS Code editor's Live mode you can tick them —
the tick is written back into the Markdown. The transform runs *after* HTML sanitising, so
the generated `<input>` never requires `<input>` on the allowlist; an author writing raw
`<input>` still has it dropped.

## Sending one to someone who has nothing installed

```bash
rk share notes.rkf          # -> notes.html
```

One HTML file they can double-click. It renders the document properly — images, tables,
checkboxes — **offline**, and the original `.rkf` is inside it: a Download button hands back
the exact bytes, verified byte-for-byte by
[tests/test_rkformat.py](tests/test_rkformat.py). So the thing you send is both a readable
document and a carrier for the real file. The web editor has the same action, filling the
same [template](docs/assets/share-template.html).

It costs about 1.33× the `.rkf` for image-heavy documents (base64 overhead) plus a fixed
~70 KB of inlined reader, which dominates for small files. The archive is carried once and
unzipped in the browser rather than rendering the images inline *and* attaching the archive,
which would be 2.7×.

With scripting off, the page still shows the Markdown as text.

## Reading one without any tooling

Four routes, in increasing order of fidelity:

1. **Any text editor.** The body is stored uncompressed and first, so `cat`, `less`, Notepad
   or a mail-client preview shows the Markdown after ~60 bytes of ZIP header. Images appear
   as `![alt](assets/x.png)` references rather than pictures, which is the point — the prose
   is never trapped.
2. **The web viewer** below: full rendering, nothing to install.
3. **`rk cat doc.rkf`**, or *RK: View Markdown as Plain Text* in VS Code, which opens the
   body as a read-only `.md` editor with highlighting and search.
4. **`rk share doc.rkf`** — see above. The most useful thing to send someone who has nothing
   installed and may be offline.

## Write and read one in the browser

[**im-rajat.github.io/rkformat**](https://im-rajat.github.io/rkformat/) is a full editor, not
just a viewer. Nothing to install:

- **New document** — start from an empty file and write. It works as a notepad that happens
  to save real `.rkf` files.
- **The same four modes** as the VS Code extension — Live, Source, Split, Preview — and the
  same formatting toolbar, generated from the same
  [toolbar definition](docs/assets/toolbar.js).
- **Paste or drop an image** and it is embedded in the file, checksum and all.
- **Save** with Ctrl+S. Where the browser supports the File System Access API (Chromium) that
  overwrites the file you opened; elsewhere it downloads. **Save a copy** always prompts.
- **Unsaved work is kept in IndexedDB**, so closing the tab does not lose a document — the
  whole `.rkf` is stored, images included.
- Open a file, or share a deep link:

```
https://im-rajat.github.io/rkformat/?url=https://github.com/you/repo/blob/main/notes.rkf
```

GitHub `blob` links are rewritten to `raw.githubusercontent.com` automatically. Any other
host has to allow cross-origin reads; otherwise download the file and drop it in.

**Everything is client-side.** A `.rkf` is a ZIP, so the browser both reads one
(`DecompressionStream`) and writes one (`CompressionStream`) unaided — see
[rkfwrite.js](docs/assets/rkfwrite.js), which follows the same member ordering, compression
policy and determinism rules as the Python writer. Every asset's SHA-256 is recomputed with
WebCrypto. Nothing is uploaded, and the page makes no third-party requests.

It lives in [docs/](docs/) and is served by GitHub Pages from that folder — static files, no
build step, no dependencies.

### Keeping two implementations honest

The site cannot call Python, so some things necessarily exist twice. Three mechanisms keep
them from drifting:

- **Shared source where it is possible.** The renderer, the sanitiser, the HTML→Markdown
  serialiser, the toolbar definition and the source highlighter live once in `docs/assets/`
  and the extension gets generated copies from [docs/build.py](docs/build.py). One test
  asserts the copies are current; another asserts that anything the webview loads is actually
  in the build script's list, so a new shared file cannot be forgotten.
  The stylesheet is generated from `rkformat.render.PAGE_CSS` the same way.
- **Rendering is diffed.** [tests/test_site_parity.js](tests/test_site_parity.js) renders 110
  fixtures — nested emphasis, tight and loose lists, tables, entities, raw HTML and
  script-injection attempts — through both renderers and compares the HTML.
- **Writing is cross-checked.** [tests/test_web_write.js](tests/test_web_write.js) builds
  documents with the browser writer and hands them to the Python `rk check`. If Python
  verifies every checksum and returns the body intact, the two agree on the format.

That last one is the important one: writing a container is exactly where two implementations
quietly diverge, and checking JavaScript against itself would prove nothing.

## Edit it in VS Code

[vscode-extension/](vscode-extension/) is a custom editor with four modes:

| Mode | What it is |
|---|---|
| **Live** | Type straight into the rendered page, like a word processor. Full formatting toolbar. |
| **Split** | Markdown source beside a live preview. |
| **Source** | Markdown only. |
| **Preview** | Rendered page only. |

The Markdown source is **syntax highlighted** — headings, emphasis, code, links, task boxes
and table rules all coloured, with the markup characters dimmed so the structure reads at a
glance. A textarea cannot colour its own text, so a highlighted layer sits behind a
transparent one; the metrics that decide where lines wrap live in a single shared stylesheet,
because a one-character difference between the layers would offset everything below it.

The writing surface uses the **full width** of the editor by default, because a narrow
measure suits reading and gets cramped for writing. `rkformat.editorWidth: "page"` — or the
page button in the toolbar — switches to a narrow centred sheet.

The Live toolbar covers undo/redo, bold, italic, strikethrough, inline code, H1–H3, body
text, bulleted, numbered and task lists, indent and outdent, block quote, code block, table,
horizontal rule, link, image, and clear formatting.

**Paste or drag an image straight in** and it is embedded in the file. The extension has no
dependencies and no build step — it shells out to the `rk` CLI, so the editor and the command
line can never disagree about what a document means.

Live mode works by turning the edited page back into Markdown on every keystroke
([tomarkdown.js](docs/assets/tomarkdown.js)). That direction is inherently lossy, so the rule
is: emit Markdown where Markdown can express something exactly, and keep verbatim HTML where
it cannot — an author's `<img width="200">` survives a round trip rather than being flattened.
The invariant under test is not that the Markdown text is unchanged (`*x*` and `_x_` are both
fine) but that **rendering is stable**:

    render(toMarkdown(render(md))) === render(md)

so a WYSIWYG edit never degrades the document. Source remains canonical; if Live mode ever
does something you did not intend, the Markdown is right there in Source.

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
pytest                           # the format library - or, with no pytest installed:
python3 tests/test_rkformat.py

node tests/test_site_parity.js   # browser renderer vs. `rk render`, 102 fixtures
node tests/test_extension_undo.js  # the extension's undo/redo stack, against a vscode stub
node tests/test_web_write.js     # the browser writer, validated by the Python CLI
node tests/test_highlight.js     # the source highlighter, 94 checks
tests/test_site_browser.sh       # headless Chrome: the web editor end to end, the WYSIWYG
                                 # round trip, and live editing in the real webview shell
```

The Python suite covers round-tripping, determinism, reference resolution (including
code-fence masking), integrity checks, and the security limits above. Image fixtures are
synthesised with the standard library, so there are no binary files in the repo beyond the
demo document.

`test_site_browser.sh` needs a Chrome or Chromium binary and skips cleanly if there isn't
one, so it never turns into a false failure. It builds its live-editing harness by lifting
the webview's actual HTML out of `extension.js`, so the test cannot drift from what ships.

## Layout

| Path | What |
|---|---|
| [SPEC.md](SPEC.md) | The format specification |
| [src/rkformat/container.py](src/rkformat/container.py) | Read, write, mutate, validate |
| [src/rkformat/manifest.py](src/rkformat/manifest.py) | `manifest.json` model |
| [src/rkformat/imageinfo.py](src/rkformat/imageinfo.py) | Stdlib-only image sniffing |
| [src/rkformat/render.py](src/rkformat/render.py) | HTML rendering and page styles |
| [src/rkformat/sanitize.py](src/rkformat/sanitize.py) | HTML allowlist for author markup |
| [src/rkformat/cli.py](src/rkformat/cli.py) | The `rk` command |
| [vscode-extension/](vscode-extension/) | VS Code custom editor |
| [docs/](docs/) | The web editor, served by GitHub Pages |
| [docs/assets/rkfwrite.js](docs/assets/rkfwrite.js) | Writes `.rkf` in the browser |
| [docs/assets/toolbar.js](docs/assets/toolbar.js) | Toolbar shared with the extension |
| [docs/assets/highlight.js](docs/assets/highlight.js) | Markdown source highlighting, shared |
| [src/rkformat/share.py](src/rkformat/share.py) | Builds the self-viewing HTML for `rk share` |
| [examples/](examples/) | A demo document and the script that builds it |

## Possible next steps

- **A recent-documents list** in the web editor. Drafts already live in IndexedDB; keeping
  more than one and listing them is a small step from here.

- A **text-safe variant** (MIME multipart with base64 parts) for channels that only carry
  text, as a `--text-safe` export alongside the canonical ZIP.
- **Markdown input rules in Live mode** — typing `# ` or `- ` at the start of a line could
  format as you go, the way a word processor autocorrects. Today formatting is by toolbar
  and keyboard shortcut.
- **TextBundle interop** — `.textbundle`/`.textpack` is a near-identical layout, so
  import/export would be cheap and buys compatibility with Ulysses, Bear and iA Writer.
- Non-image assets with richer typing, and a thumbnail cache in `meta/` for fast listing.
