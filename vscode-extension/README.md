# RK Document — VS Code extension

A custom editor for `.rkf` files: Markdown on the left, a Word-like rendered page on the
right, and images embedded in the file itself.

## What it does

- **Opens `.rkf` and `.rk` files** as a split source/preview editor instead of a binary blob.
- **Paste or drag an image** into the editor and it is embedded in the document — no
  sidecar folder, no broken links when you send the file to someone.
- **Images panel** lists every embedded asset with its size and dimensions, and lets you
  insert a reference or delete it.
- **Live validation** surfaces dangling references and corrupt assets as you type.
- Commands for packing a `.md` file into a `.rkf`, unpacking back to a folder, exporting
  self-contained HTML, and sweeping unreferenced images.

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
| `rkformat.command` | `["python3", "-m", "rkformat"]` | How to invoke the CLI. |
| `rkformat.extraPythonPath` | `""` | Prepended to `PYTHONPATH`. |
| `rkformat.defaultLayout` | `"split"` | `split`, `preview`, or `source`. |
| `rkformat.allowHtml` | `false` | Render raw HTML in the body. Off by default — a `.rkf` may come from someone else. |
| `rkformat.previewDebounceMs` | `250` | Idle time before the preview re-renders. |

## Notes on behaviour

Pasted and dropped images are written into the document **immediately**, before you save.
The CLI allocates the asset path and de-duplicates identical bytes, so the reference that
gets inserted has to come from it. If you then undo the text, the image stays behind as an
unreferenced asset — **Clean up** (or `rk gc`) removes it.
