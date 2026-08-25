#!/usr/bin/env python3
"""Build a browser harness that drives the web editor.

`--dump-dom` can load a page but not click anything, so this lifts the **real** body out of
`docs/index.html`, loads the same scripts, and appends a driver that exercises the editor the
way a person would: create a document, type, format, embed an image, undo, and save.

    python3 tests/make_site_harness.py <output.html>

Taking the markup from index.html rather than restating it means the harness cannot drift
from the page that ships - if an element is renamed, the test notices.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def extract_body() -> str:
    """The contents of index.html's <body>, minus its script tags."""
    html = (ROOT / "docs" / "index.html").read_text(encoding="utf-8")
    match = re.search(r"<body>(.*?)</body>", html, re.S)
    if not match:
        raise SystemExit("could not find <body> in docs/index.html")
    return re.sub(r'\s*<script src="[^"]*"></script>', "", match.group(1))


# Loaded before app.js so the editor sees the stubs, exactly as a browser would see the
# real APIs.
STUB_SCRIPT = """
<script>
// A tiny 1x1 PNG, for the image-embedding checks.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARAAA//8DAgABAAA" +
  "AAAAAAAAASUVORK5CYII=";
function pngBytes() {
  const binary = atob(PNG_BASE64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// Capture what a save would have written, instead of touching the disk.
const savedFiles = [];
window.showSaveFilePicker = async () => ({
  name: "harness.rkf",
  createWritable: async () => ({
    write: async (bytes) => savedFiles.push(bytes),
    close: async () => {},
  }),
});

// Keep prompts deterministic.
window.prompt = (message, value) => (/title/i.test(message) ? "Harness Doc" : value || "x");
window.confirm = () => true;
</script>
"""

DRIVER_SCRIPT = """
<script>
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail: condition ? "" : String(detail ?? "") });
}

const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a condition rather than for a duration.
 *
 * Headless Chrome runs this with --virtual-time-budget, which fires timers immediately while
 * real async work (reading a Blob, hashing with WebCrypto) still has to be scheduled. A fixed
 * `wait(600)` therefore returns before the work lands. Polling yields to the task queue
 * repeatedly, which gives it a chance to complete.
 */
async function waitFor(label, predicate, attempts = 200) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (predicate()) return true;
    } catch (err) {
      /* the DOM may not be ready yet */
    }
    await wait(10);
  }
  return false;
}

function click(selector) {
  const element = document.querySelector(selector);
  if (!element) throw new Error("no element for " + selector);
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function selectInside(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

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
    `${results.length - failed.length}/${results.length} web-editor checks passed` +
    (failed.length ? "" : " :: ALL PASSED");
  document.body.appendChild(summary);
}

(async () => {
  try {
    const live = $("live");
    const source = $("source");
    const workspace = $("workspace");

    // 1. A brand new document, created through the button (window.prompt is stubbed).
    click("#act-new");
    await wait(200);
    check("a new document opened", workspace.hidden === false, workspace.hidden);
    check("the landing screen went away", $("intro").hidden === true);
    check("the editable page has content", live.textContent.length > 0, live.textContent);
    check("the format bar is showing", $("format-bar").hidden === false);
    check("the mode buttons are showing", $("modes").hidden === false);
    check("it starts clean", !$("doc-name").textContent.startsWith("\\u25cf"), $("doc-name").textContent);

    // 2. Typing into the page becomes Markdown.
    const heading = live.querySelector("h1");
    check("the new document has a heading", heading !== null, live.innerHTML.slice(0, 120));
    const paragraph = document.createElement("p");
    paragraph.textContent = "Typed straight into the browser.";
    live.appendChild(paragraph);
    live.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor("typing", () => source.value.includes("Typed straight into the browser."));
    check(
      "typing reached the Markdown source",
      source.value.includes("Typed straight into the browser."),
      source.value
    );
    check("the document is now dirty", $("doc-name").textContent.indexOf("\\u25cf") === 0,
      $("doc-name").textContent);

    // 3. Formatting through the toolbar.
    selectInside(live.querySelector("p"));
    click('[data-format="bold"]');
    await waitFor("bold", () => source.value.includes("**"));
    check("bold produced Markdown emphasis", source.value.includes("**"), source.value);

    selectInside(live.querySelector("p") || live.querySelector("h2"));
    click('[data-format="h2"]');
    await waitFor("h2", () => /^## /m.test(source.value));
    check("the H2 button produced a heading", /^## /m.test(source.value), source.value);

    // 4. Task lists.
    selectInside(live.querySelector("h2") || live.querySelector("p") || live.querySelector("h1"));
    click('[data-format="task"]');
    await waitFor("task", () => /^- \\[[ x]\\] /m.test(source.value));
    check("the task button produced a checkbox item", /^- \\[[ x]\\] /m.test(source.value), source.value);
    const box = live.querySelector('input[type="checkbox"]');
    check("the checkbox is clickable", box !== null && box.disabled === false, box ? box.disabled : "none");

    // 5. Undo and redo, which this page owns rather than a host.
    const beforeUndo = source.value;
    click('[data-format="undo"]');
    await waitFor("undo", () => source.value !== beforeUndo);
    check("undo changed the body", source.value !== beforeUndo, "unchanged");
    click('[data-format="redo"]');
    await waitFor("redo", () => source.value === beforeUndo);
    check("redo restored it", source.value === beforeUndo, source.value);

    // 6. Embedding an image by dropping it, which is the path a person uses.
    // A DataTransfer that has been through a dispatched DragEvent is put into protected
    // mode by the browser: the File survives but its bytes become unreadable, and
    // arrayBuffer() never settles. Supplying dataTransfer directly keeps the file readable
    // while still going through the application's real drop handler.
    const file = new File([pngBytes()], "dot.png", { type: "image/png" });
    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { files: [file], types: ["Files"] },
    });
    window.dispatchEvent(dropEvent);
    const embedded = await waitFor("embed", () => source.value.includes("assets/dot.png"));
    check("a dropped image was embedded and referenced", embedded, source.value);
    check(
      "no data: URL leaked into the Markdown",
      !source.value.includes("data:image"),
      source.value
    );

    // 7. Saving produces a real .rkf that the reader accepts.
    click("#act-save");
    const written = await waitFor("save", () => savedFiles.length === 1);
    check("a file was written", written, savedFiles.length);
    if (savedFiles.length) {
      const written = savedFiles[0];
      const copy = new Uint8Array(written);
      check("it carries the .rkf signature", RKF.looksLikeRkf(copy));
      const reopened = await RKF.open(
        copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
      );
      check("the saved file reopens", reopened.markdown === source.value, reopened.markdown);
      check("the image survived the save", reopened.assets.length === 1, reopened.assets.length);
      check("its checksum verifies", reopened.assets[0].verified === true);
      check("no validation problems", reopened.problems.length === 0, JSON.stringify(reopened.problems));
      check("saving cleared the dirty marker", $("doc-name").textContent.indexOf("\\u25cf") !== 0,
        $("doc-name").textContent);
    }

    // 8. Modes and width.
    click('[data-layout="source"]');
    await wait(150);
    check("switching to source mode", workspace.dataset.layout === "source", workspace.dataset.layout);
    click('[data-layout="split"]');
    await wait(200);
    check("split mode renders the preview", $("preview").innerHTML.includes("<h1"), $("preview").innerHTML.slice(0, 80));
    click('[data-layout="live"]');
    await wait(250);
    check("back to live mode", workspace.dataset.layout === "live", workspace.dataset.layout);
    const startWidth = document.body.dataset.width;
    click("#act-width");
    check("the width button switches mode", document.body.dataset.width !== startWidth,
      document.body.dataset.width);

    // 9. The images panel.
    click("#act-images");
    await wait(150);
    check("the details panel opens", $("details").hidden === false);
    check("it lists the embedded image", $("details-assets").textContent.includes("assets/dot.png"),
      $("details-assets").textContent);
    check("it reports the checksum as verified", $("details-assets").textContent.includes("sha256"),
      $("details-assets").textContent);
  } catch (error) {
    check("the harness ran to completion", false, (error && error.message) || String(error));
  }
  report();
})();
</script>
"""


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    target = Path(sys.argv[1])
    body = extract_body()
    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Web editor harness</title>
<link rel="stylesheet" href="../docs/assets/document.css">
<link rel="stylesheet" href="../docs/assets/viewer.css">
<style>
  #harness-results, #harness-summary {{
    white-space: pre;
    font-family: monospace;
    font-size: 11px;
    padding: 6px 10px;
  }}
</style>
</head>
<body>
{body}
{STUB_SCRIPT}
<script src="../docs/assets/rkf.js"></script>
<script src="../docs/assets/rkfwrite.js"></script>
<script src="../docs/assets/sanitize.js"></script>
<script src="../docs/assets/markdown.js"></script>
<script src="../docs/assets/tomarkdown.js"></script>
<script src="../docs/assets/toolbar.js"></script>
<script src="../docs/assets/app.js"></script>
{DRIVER_SCRIPT}
</body>
</html>
"""
    target.write_text(page, encoding="utf-8")
    print(f"wrote {target} ({target.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
