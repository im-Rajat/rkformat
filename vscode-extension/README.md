# RK Document — VS Code extension

A custom editor for `.rkf` files: Markdown on the left, a Word-like rendered page on the
right, and images embedded in the file itself.

## What it does

Opens `.rkf` and `.rk` files as a real editor instead of a binary blob, in four modes:

| Mode | What it is |
|---|---|
| **Live** | Type straight into the rendered page, like a word processor. Formatting toolbar, Ctrl+B / Ctrl+I / Ctrl+K. |
| **Split** | Markdown source beside a live preview. |
| **Source** | Markdown only. |
| **Preview** | Rendered page only. |

- **A full-width writing surface** by default, like a word processor. The page button in the
  toolbar (or `rkformat.editorWidth`) switches to a narrow centred sheet for reading.
- **A formatting toolbar** in Live mode: undo/redo, bold, italic, strikethrough, inline code,
  H1–H3, body text, bulleted/numbered/task lists, indent and outdent, quote, code block,
  table, horizontal rule, link, image, and clear formatting. Ctrl+B / Ctrl+I / Ctrl+K work.
- **The Markdown source is syntax highlighted** in Source and Split, coloured from VS Code's
  own editor variables so it matches the surrounding theme.
- **Task lists** render as real checkboxes you can tick; the tick is written back into the
  Markdown.
- **Paste or drag an image** in and it is embedded in the document — no sidecar folder, no
  broken links when you send the file to someone. In Live mode the picture appears at the
  caret; in the other modes a Markdown reference is inserted.
- **Raw HTML works**, including `<img src="assets/x.png" width="200">`, which resolves to the
  embedded image. It is sanitised against an allowlist first, so a document from someone else
  cannot run script.
- **Images panel** lists every embedded asset with size and dimensions, and lets you insert a
  reference or delete it.
- **Live validation** surfaces dangling references and corrupt assets as you type.
- **View Markdown as Plain Text** opens the body as a read-only `.md` editor, with syntax
  highlighting, search and outline.
- Commands for packing a `.md` file into a `.rkf`, unpacking back to a folder, exporting
  self-contained HTML, and sweeping unreferenced images.
- **RK: Share as Self-Viewing HTML** writes one file you can send to someone with nothing
  installed: it displays the document offline and contains the original `.rkf`.

### About Live mode

Live editing turns the edited page back into Markdown on every keystroke. That direction is
lossy by nature, so the rule is: emit Markdown where Markdown can express something exactly,
and keep verbatim HTML where it cannot — your `<img width="200">` survives a round trip
instead of being flattened to plain Markdown image syntax.

Source stays canonical. If Live mode ever does something you did not intend, switch to Source
and the Markdown is right there. `tests/test_site_browser.sh` checks that
`render(toMarkdown(render(md)))` equals `render(md)` across 40 fixtures, so an edit that
changes nothing should not change the document.

Pasting into Live mode inserts **plain text**, deliberately: pasted rich HTML from a browser
or Word would drag in markup the format cannot represent. Images are the exception and do get
embedded.

## There is a web version too

[im-rajat.github.io/rkformat](https://im-rajat.github.io/rkformat/) has the same four modes
and the same toolbar, and can create and save `.rkf` files with nothing installed. This
extension is the better fit when the documents live in a repo you already have open; the web
editor is for when you do not want to install anything.

## Requirements

The extension is a thin shell over the `rk` CLI — all format logic lives in Python, so the
editor and the command line can never disagree. Install the package first:

```bash
cd /path/to/rkformat && uv tool install --editable .
```

Then set `rkformat.command` to `["rk"]` (a `uv`/`pipx` install puts `rk` in
`~/.local/bin`, which VS Code may not have on its `PATH` — if the editor reports it cannot
run `rk`, use the absolute path: `["/home/you/.local/bin/rk"]`).

To run against a working copy with nothing installed, keep the default
`["python3", "-m", "rkformat"]` and point `rkformat.extraPythonPath` at the repo's `src/`
directory.

## Installing this extension

```bash
./install.sh
```

That packages a `.vsix` and installs it with `code --install-extension`. No build step and
no dependencies — the extension is plain JavaScript.

A symlink into the extensions directory also works, but the path depends on your setup and
a hand-placed folder is not recorded in VS Code's extension index:

| Setup | Extensions directory |
|---|---|
| Local VS Code | `~/.vscode/extensions` |
| Remote-WSL / Remote-SSH / Dev Container | `~/.vscode-server/extensions` |
| Insiders builds | `~/.vscode-insiders/extensions`, `~/.vscode-server-insiders/extensions` |

Over Remote-WSL or Remote-SSH the extension must be installed on the **remote** side —
it spawns `rk`, which lives there. `install.sh` handles this: the remote `code` shim
installs into the remote extension host.

To develop against it instead, open `vscode-extension/` in VS Code and press F5.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `rkformat.command` | `["python3", "-m", "rkformat"]` | How to invoke the CLI. Probed automatically if unset. |
| `rkformat.extraPythonPath` | `""` | Prepended to `PYTHONPATH`. |
| `rkformat.defaultLayout` | `"split"` | `live`, `split`, `preview`, or `source`. |
| `rkformat.editorWidth` | `"full"` | `full` uses the whole editor; `page` is a narrow centred sheet. |
| `rkformat.html` | `"sanitize"` | Raw HTML handling: `sanitize` (allowlist), `escape` (show as text), `raw` (untouched). |
| `rkformat.previewDebounceMs` | `250` | Idle time before the preview re-renders. |

## Undo and redo

Ctrl+Z and Ctrl+Shift+Z (or Ctrl+Y) go through VS Code's own undo stack, so they work in
every mode and interact correctly with the dirty indicator and Save.

Granularity differs by mode, which is worth knowing: **Source** records an entry per
keystroke, so undo is character-by-character. **Live** records one per editing burst
(`rkformat.previewDebounceMs`, 250ms by default), because the page has to be converted back
to Markdown before there is anything to record - so one undo may step back a few characters
at once.

## Notes on behaviour

Pasted and dropped images are written into the document **immediately**, before you save.
The CLI allocates the asset path and de-duplicates identical bytes, so the reference that
gets inserted has to come from it. If you then undo the text, the image stays behind as an
unreferenced asset — **Clean up** (or `rk gc`) removes it.
