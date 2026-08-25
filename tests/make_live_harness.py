#!/usr/bin/env python3
"""Build a browser harness for the extension's live (WYSIWYG) editing.

The webview normally runs inside VS Code, which cannot be driven from a test. This lifts the
**real** page shell out of `vscode-extension/extension.js`, so the harness cannot drift from
what ships, stubs the VS Code API, and drives the editor the way a user would.

    python3 tests/make_live_harness.py <output.html>

The stub answers `requestPreview` with the browser renderer, which the parity test already
holds to the Python renderer's output - so what the harness renders is what the extension
would show.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def extract_shell() -> str:
    """Pull the <body> of the webview out of the extension source."""
    source = (ROOT / "vscode-extension" / "extension.js").read_text(encoding="utf-8")
    match = re.search(r'(<body class="rkf-editor">.*?)\n  <script', source, re.S)
    if not match:
        raise SystemExit("could not find the webview body in extension.js")
    return match.group(1)


STUB_SCRIPT = """
<script>
// ---- VS Code API stub, defined before editor.js runs -----------------------
const posted = [];
let state = {};
function acquireVsCodeApi() {
  return {
    postMessage: (message) => {
      posted.push(message);
      if (message.type === "requestPreview") {
        // Answer with the browser renderer, which parity-tests against the Python one.
        const html = RKF.markdown.render(message.markdown, { resolveImage });
        window.postMessage(
          { type: "preview", seq: message.seq, forLive: message.forLive, html,
            problems: [], assets: ASSETS },
          "*"
        );
      }
    },
    getState: () => state,
    setState: (next) => { state = next; },
  };
}

const ASSETS = [
  { id: "a1", path: "assets/gradient.png", media_type: "image/png", bytes: 100,
    width: 640, height: 200, alt: "A gradient",
    data_uri: "data:image/png;base64,AAAA" },
];
const BY_PATH = new Map(ASSETS.map((a) => [a.path, a]));
function resolveImage(src) {
  const asset = BY_PATH.get(String(src).replace(/^\\.?\\//, ""));
  return asset ? { url: asset.data_uri, width: asset.width, height: asset.height } : null;
}

</script>
"""

DRIVER_SCRIPT = """
<script>
// ---- test driver ------------------------------------------------------------
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail: condition ? "" : String(detail || "") });
}

function lastChange() {
  for (let i = posted.length - 1; i >= 0; i -= 1) {
    if (posted[i].type === "change") return posted[i].markdown;
  }
  return null;
}

function selectInside(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function click(selector) {
  const element = document.querySelector(selector);
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
}

const START = "# Title\\n\\nA paragraph of body text.\\n\\n- one\\n- two\\n";

window.addEventListener("load", () => {
  const live = document.getElementById("live");
  const source = document.getElementById("source");
  const panes = document.getElementById("panes");
  const formatBar = document.getElementById("format-bar");

  // 1. Initial load, as the host sends it.
  window.postMessage(
    { type: "init", markdown: START, html: RKF.markdown.render(START, { resolveImage }),
      title: "T", assets: ASSETS, problems: [], layout: "split", debounceMs: 5 },
    "*"
  );

  setTimeout(() => {
    check("init populated the source", source.value === START, source.value);
    check("init populated the live page", live.querySelector("h1") !== null, live.innerHTML);
    check("format bar hidden outside live mode", formatBar.hidden === true);

    // 2. Switch to live editing.
    document.querySelector('[data-layout="live"]').click();
    setTimeout(() => {
      check("layout switched to live", panes.dataset.layout === "live", panes.dataset.layout);
      check("format bar visible in live mode", formatBar.hidden === false);
      check("live page has the document", live.textContent.includes("A paragraph"), live.textContent);

      // 3. Type into the page: the paragraph gets new text.
      const paragraph = live.querySelector("p");
      paragraph.textContent = "A paragraph of body text. Typed live.";
      live.dispatchEvent(new Event("input", { bubbles: true }));

      setTimeout(() => {
        const afterTyping = lastChange();
        check("typing produced markdown", afterTyping !== null, "no change posted");
        check(
          "typed text is in the markdown",
          afterTyping && afterTyping.includes("Typed live."),
          afterTyping
        );
        check(
          "heading survived serialisation",
          afterTyping && /^# Title$/m.test(afterTyping),
          afterTyping
        );
        check(
          "list survived serialisation",
          afterTyping && /^- one$/m.test(afterTyping) && /^- two$/m.test(afterTyping),
          afterTyping
        );
        check("source textarea kept in step", source.value === afterTyping);

        // 4. Bold the paragraph through the toolbar.
        selectInside(live.querySelector("p"));
        click('[data-format="bold"]');

        setTimeout(() => {
          const afterBold = lastChange();
          check("bold produced markdown emphasis", afterBold && afterBold.includes("**"), afterBold);

          // 5. Heading conversion via the toolbar.
          selectInside(live.querySelector("p") || live.querySelector("h2") || live.querySelector("h1"));
          click('[data-format="h2"]');

          setTimeout(() => {
            const afterHeading = lastChange();
            check(
              "h2 button produced a level-2 heading",
              afterHeading && /^## /m.test(afterHeading),
              afterHeading
            );

            // 6. An embedded image inserted at the caret.
            const range = document.createRange();
            range.selectNodeContents(live.lastElementChild);
            range.collapse(false);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            window.postMessage(
              { type: "insert", text: "![A gradient](assets/gradient.png)", assets: ASSETS },
              "*"
            );

            setTimeout(() => {
              const afterImage = lastChange();
              check(
                "image inserted as an element",
                live.querySelector('img[data-rkf-src="assets/gradient.png"]') !== null,
                live.innerHTML.slice(0, 300)
              );
              check(
                "image serialised back to its archive path",
                afterImage && afterImage.includes("(assets/gradient.png)"),
                afterImage
              );
              check(
                "no data: URL leaked into the markdown",
                afterImage && !afterImage.includes("data:image"),
                afterImage
              );

              // 7. Back to source: the textarea holds the edited markdown.
              document.querySelector('[data-layout="source"]').click();
              setTimeout(() => {
                check(
                  "switching back to source keeps the edits",
                  source.value.includes("Typed live.") && source.value.includes("assets/gradient.png"),
                  source.value
                );

                // 8. Undo: the host pushes a previous body back with a `restore`.
                const changesBefore = posted.filter((m) => m.type === "change").length;
                const restored = "# Title\\n\\nRestored by undo.\\n";
                source.focus();
                window.postMessage({ type: "restore", markdown: restored }, "*");

                setTimeout(() => {
                  check("restore replaced the body", source.value === restored, source.value);
                  check(
                    "restore did not post a change (no edit loop)",
                    posted.filter((m) => m.type === "change").length === changesBefore,
                    posted.filter((m) => m.type === "change").length - changesBefore
                  );
                  check(
                    "caret parked at the first difference",
                    source.selectionStart === "# Title\\n\\n".length,
                    source.selectionStart
                  );

                  // 9. A restore while in live mode must re-render the page.
                  document.querySelector('[data-layout="live"]').click();
                  setTimeout(() => {
                    const second = "# Title\\n\\nSecond undo step.\\n";
                    window.postMessage({ type: "restore", markdown: second }, "*");
                    setTimeout(() => {
                      check(
                        "restore in live mode re-rendered the page",
                        live.textContent.includes("Second undo step."),
                        live.textContent
                      );
                      check(
                        "live restore did not post a change either",
                        posted.filter((m) => m.type === "change").length === changesBefore,
                        posted.filter((m) => m.type === "change").length - changesBefore
                      );
                      report();
                    }, 120);
                  }, 60);
                }, 60);
              }, 40);
            }, 60);
          }, 60);
        }, 60);
      }, 60);
    }, 60);
  }, 60);
});

function report() {
  const failed = results.filter((r) => !r.ok);
  const box = document.createElement("div");
  box.id = "harness-results";
  box.textContent = results
    .map((r) => `${r.ok ? "ok" : "FAIL"}  ${r.name}${r.ok ? "" : "  :: " + r.detail}`)
    .join("\\n");
  document.body.appendChild(box);
  const summary = document.createElement("div");
  summary.id = "harness-summary";
  summary.textContent =
    `${results.length - failed.length}/${results.length} live-editing checks passed` +
    (failed.length ? "" : " :: ALL PASSED");
  document.body.appendChild(summary);
}
</script>
"""


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    target = Path(sys.argv[1])
    shell = extract_shell()
    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Live editing harness</title>
<style>
  /* The real stylesheets are VS Code themed; only layout switching matters here. */
  #panes {{ display: flex; }}
  [hidden] {{ display: none !important; }}
  #panes[data-layout="live"] #source-pane,
  #panes[data-layout="live"] #preview-pane,
  #panes[data-layout="live"] #divider {{ display: none; }}
  #panes[data-layout="source"] #live-pane,
  #panes[data-layout="source"] #preview-pane {{ display: none; }}
  #harness-results {{ white-space: pre; font-family: monospace; }}
</style>
</head>
{shell}
<script src="../docs/assets/sanitize.js"></script>
<script src="../docs/assets/markdown.js"></script>
<script src="../docs/assets/tomarkdown.js"></script>
{STUB_SCRIPT}
<script src="../vscode-extension/media/editor.js"></script>
{DRIVER_SCRIPT}
</body>
</html>
"""
    target.write_text(page, encoding="utf-8")
    print(f"wrote {target} ({target.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
