#!/usr/bin/env bash
# Package the extension and install it into VS Code.
#
# Prefers `code --install-extension`, which registers the extension properly. Dropping a
# folder into the extensions directory also works, but that directory differs per setup —
# ~/.vscode/extensions locally, ~/.vscode-server/extensions over Remote-SSH or WSL — and a
# manually placed folder is not recorded in the extensions index.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

vsix="$here/rkformat-0.5.0.vsix"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx not found — install Node.js, or package the extension elsewhere and run:" >&2
  echo "  code --install-extension rkformat-0.5.0.vsix" >&2
  exit 1
fi

echo "==> packaging"
npx --yes @vscode/vsce package --skip-license -o "$vsix"

# The remote-cli `code` shim is not always on PATH in an integrated terminal.
code_bin="$(command -v code || true)"
if [ -z "$code_bin" ]; then
  code_bin="$(ls -t "$HOME"/.vscode-server/bin/*/bin/remote-cli/code 2>/dev/null | head -1 || true)"
fi
if [ -z "$code_bin" ]; then
  echo "==> packaged $vsix"
  echo "The 'code' CLI was not found. Install the extension from VS Code:" >&2
  echo "  Extensions view -> ... menu -> Install from VSIX..." >&2
  exit 0
fi

echo "==> installing with $code_bin"
"$code_bin" --install-extension "$vsix" --force

echo
echo "Installed. Reload VS Code, then open a .rkf file (try examples/welcome.rkf)."
echo "If the editor reports it cannot find the CLI, install it with:"
echo "  uv tool install --editable .."
