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

### About Live mode

Live editing turns the edited page back into Markdown on every keystroke. That direction is
lossy by nature, so the rule is: emit Markdown where Markdown can express something exactly,
and keep verbatim HTML where it cannot — your `<img width="200">` survives a round trip
instead of being flattened to `![](...)`.

Source stays canonical. If Live mode ever does something you did not intend, switch to Source
and the Markdown is right there. `tests/test_site_browser.sh` checks that
`render(toMarkdown(render(md)))` equals `render(md)` across 40 fixtures, so an edit that
changes nothing should not change the document.

Pasting into Live mode inserts **plain text**, deliberately: pasted rich HTML from a browser
or Word would drag in markup the format cannot represent. Images are the exception and do get
embedded.

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
| `rkformat.html` | `"sanitize"` | Raw HTML handling: `sanitize` (allowlist), `escape` (show as text), `raw` (untouched). |
| `rkformat.previewDebounceMs` | `250` | Idle time before the preview re-renders. |

## Notes on behaviour

Pasted and dropped images are written into the document **immediately**, before you save.
The CLI allocates the asset path and de-duplicates identical bytes, so the reference that
gets inserted has to come from it. If you then undo the text, the image stays behind as an
unreferenced asset — **Clean up** (or `rk gc`) removes it.
