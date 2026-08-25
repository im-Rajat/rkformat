#!/usr/bin/env bash
# End-to-end browser test for the viewer at docs/.
#
# Serves docs/ and drives a headless Chrome over it, asserting on the resulting DOM. Needs
# a Chrome or Chromium binary; set CHROME to point at one. Skips (exit 0) if none is found,
# so this can run anywhere without becoming a false failure.
#
#   tests/test_site_browser.sh
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${PORT:-8731}"
work="$(mktemp -d)"
trap 'rm -rf "$work"; [ -n "${server_pid:-}" ] && kill "$server_pid" 2>/dev/null' EXIT

find_chrome() {
  for candidate in \
    "${CHROME:-}" \
    "$(command -v chromium 2>/dev/null)" \
    "$(command -v chromium-browser 2>/dev/null)" \
    "$(command -v google-chrome 2>/dev/null)" \
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
}

chrome="$(find_chrome)"
if [ -z "$chrome" ]; then
  echo "SKIP: no Chrome/Chromium found (set CHROME=/path/to/chrome to run this test)"
  exit 0
fi
echo "using $chrome"

python3 "$root/docs/build.py" >/dev/null || { echo "docs/build.py failed"; exit 1; }
(cd "$root" && python3 -m http.server "$port" >/dev/null 2>&1) &
server_pid=$!
# curl handles the wait itself, so this needs no sleep loop.
if ! curl -sf --retry 30 --retry-delay 1 --retry-connrefused \
     "http://localhost:$port/docs/index.html" >/dev/null 2>&1; then
  echo "could not start a server on port $port"
  exit 1
fi

dump() {
  "$chrome" --headless --disable-gpu --no-sandbox --virtual-time-budget=9000 \
    --dump-dom "http://localhost:$port/docs/index.html$1" 2>/dev/null
}

dump_page() {
  "$chrome" --headless --disable-gpu --no-sandbox --virtual-time-budget=12000 \
    --dump-dom "http://localhost:$port/$1" 2>/dev/null
}

# Pull a "<n>/<m> ... ALL X" summary line out of a harness page and report on it.
summary_check() { # summary_check <label> <dom-file> <element-id>
  local label="$1" file="$2" id="$3" line
  line="$(python3 - "$file" "$id" <<'PYS'
import html, re, sys
dom = open(sys.argv[1], encoding="utf-8", errors="replace").read()
found = re.search(rf'<div id="{re.escape(sys.argv[2])}">(.*?)</div>', dom, re.S)
print(html.unescape(found.group(1)).strip() if found else "NO SUMMARY (script error)")
PYS
)"
  echo "  $line"
  case "$line" in
    *"ALL STABLE"*|*"ALL PASSED"*) echo "  ok    $label" ;;
    *) echo "  FAIL  $label"; failures=$((failures + 1)) ;;
  esac
}

failures=0
check() { # check <name> <expected-count-op> <pattern> <dom-file>
  local name="$1" op="$2" pattern="$3" file="$4"
  local count
  # -o | wc -l counts occurrences; grep -c counts lines, and the details panel is one line.
  count="$(grep -o -- "$pattern" "$file" 2>/dev/null | wc -l | tr -d " ")"
  if eval "[ $count $op ]"; then
    echo "  ok    $name"
  else
    echo "  FAIL  $name (matches for '$pattern': $count)"
    failures=$((failures + 1))
  fi
}

echo "--- loading the demo document ---"
dump "?url=welcome.rkf" > "$work/demo.html"
check "landing hidden"            '-ge 1' 'id="intro" hidden'          "$work/demo.html"
check "document heading rendered" '-ge 1' '<h1>Welcome to <code>.rkf</code></h1>' "$work/demo.html"
check "images became blob URLs"   '-ge 3' 'src="blob:'                 "$work/demo.html"
check "figures with captions"     '-ge 1' '<figcaption>'               "$work/demo.html"
check "table rendered"            '-ge 1' '<thead>'                    "$work/demo.html"
check "fenced code rendered"      '-ge 1' 'class="language-bash"'      "$work/demo.html"
check "task list rendered"        '-ge 1' 'type="checkbox"'            "$work/demo.html"
check "checksums verified"        '-ge 3' 'sha256'                     "$work/demo.html"
check "no dangling images"        '-eq 0' 'rkf-missing'                "$work/demo.html"
check "no script leaked"          '-eq 0' '<script>alert'              "$work/demo.html"
check "editor toolbar present"    '-ge 15' 'data-format='              "$work/demo.html"
check "mode switcher present"     '-ge 4' 'data-layout='               "$work/demo.html"

echo "--- a tampered document must be reported ---"
python3 - "$root" "$work" <<'PY'
import pathlib, shutil, sys
root, work = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
target = root / "docs" / "_test_corrupt.rkf"
shutil.copyfile(root / "docs" / "welcome.rkf", target)
data = bytearray(target.read_bytes())
index = data.rfind(b"\x89PNG")
data[index + 2000 : index + 2010] = b"TAMPERED!!"
target.write_bytes(bytes(data))
PY
dump "?url=_test_corrupt.rkf" > "$work/corrupt.html"
check "sha256 mismatch reported" '-ge 1' 'sha256 mismatch' "$work/corrupt.html"
rm -f "$root/docs/_test_corrupt.rkf"

echo "--- a plain zip is not a document ---"
python3 -c "
import zipfile, sys
with zipfile.ZipFile(sys.argv[1] + '/docs/_test_plain.rkf', 'w') as zf:
    zf.writestr('hello.txt', 'not a document')
" "$root"
dump "?url=_test_plain.rkf" > "$work/plain.html"
check "clear error for a plain zip" '-ge 1' 'no manifest.json' "$work/plain.html"
rm -f "$root/docs/_test_plain.rkf"

echo "--- a missing file ---"
dump "?url=_test_absent.rkf" > "$work/absent.html"
check "404 reported" '-ge 1' 'answered 404' "$work/absent.html"

echo "--- the web editor: create, type, format, embed, undo, save ---"
python3 "$root/tests/make_site_harness.py" "$root/tests/site_harness.generated.html" >/dev/null
"$chrome" --headless --disable-gpu --no-sandbox --virtual-time-budget=30000 \
  --dump-dom "http://localhost:$port/tests/site_harness.generated.html" 2>/dev/null > "$work/site.html"
summary_check "the web editor works end to end" "$work/site.html" "harness-summary"
rm -f "$root/tests/site_harness.generated.html"

echo "--- source highlighting ---"
if node "$root/tests/test_highlight.js" >/dev/null 2>&1; then
  echo "  ok    the highlighter preserves every character"
else
  echo "  FAIL  the highlighter preserves every character"
  failures=$((failures + 1))
fi

echo "--- WYSIWYG round trip (rendering must be stable) ---"
dump_page "tests/wysiwyg_roundtrip.html" > "$work/roundtrip.html"
summary_check "markdown -> html -> markdown is stable" "$work/roundtrip.html" "summary"

echo "--- live editing in the extension webview ---"
python3 "$root/tests/make_live_harness.py" "$root/tests/live_harness.generated.html" >/dev/null
dump_page "tests/live_harness.generated.html" > "$work/live.html"
summary_check "live editing drives the real webview shell" "$work/live.html" "harness-summary"
rm -f "$root/tests/live_harness.generated.html"

echo
if [ "$failures" -eq 0 ]; then
  echo "all browser checks passed"
else
  echo "$failures browser check(s) failed"
fi
exit "$failures"
