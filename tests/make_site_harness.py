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


def _index_html() -> str:
    return (ROOT / "docs" / "index.html").read_text(encoding="utf-8")


def extract_body() -> str:
    """The contents of index.html's <body>, minus its script tags."""
    match = re.search(r"<body>(.*?)</body>", _index_html(), re.S)
    if not match:
        raise SystemExit("could not find <body> in docs/index.html")
    return re.sub(r'\s*<script src="[^"]*"></script>', "", match.group(1))


def extract_stylesheets() -> str:
    """The page's stylesheets, repointed at docs/.

    Read from index.html rather than restated, so adding one to the page cannot leave the
    harness testing a differently-styled document.
    """
    links = re.findall(r'<link rel="stylesheet" href="(assets/[^"]+)">', _index_html())
    return "\n".join(f'<link rel="stylesheet" href="../docs/{href}">' for href in links)


def extract_scripts(before_app: bool) -> str:
    """The page's scripts, repointed at docs/, split around app.js.

    Also read from index.html: the harness once hard-coded this list, and adding a dependency
    to the page silently broke every check because the stub ran against a half-loaded editor.
    """
    sources = re.findall(r'<script src="(assets/[^"]+)"></script>', _index_html())
    chosen = [s for s in sources if (s != "assets/app.js") == before_app]
    return "\n".join(f'<script src="../docs/{src}"></script>' for src in chosen)


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

// Capture blobs handed to downloads, so a generated file can be inspected.
const createdBlobs = [];
const realCreateObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (blob) => {
  createdBlobs.push(blob);
  return realCreateObjectURL(blob);
};

// The OS hands a launched file to launchQueue. Stubbed the way a browser provides it, so the
// app's consumer can be driven directly.
// defineProperty, not assignment: Chrome already exposes launchQueue as a read-only
// property, so `window.launchQueue = ...` fails silently and the app talks to the real one -
// which never fires without an actual file launch.
Object.defineProperty(window, "launchQueue", {
  configurable: true,
  value: {
    setConsumer: (fn) => {
      window.__launchConsumer = fn;
    },
  },
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

    // 9. Layout: the source pane must fill the workspace.
    //
    // It used to collapse to the textarea's intrinsic two rows, because `height: 100%` on the
    // pane resolves against a *definite* parent height and the landing page's body is
    // `min-height: 100vh`. The whole document was there, just clipped to three lines.
    click('[data-layout="source"]');
    await waitFor("source mode", () => workspace.dataset.layout === "source");
    const workspaceHeight = workspace.getBoundingClientRect().height;
    const paneHeight = $("source-pane").getBoundingClientRect().height;
    check("the page is in editing layout", document.body.classList.contains("editing"));
    check(
      "the source pane fills the workspace",
      workspaceHeight > 100 && paneHeight > workspaceHeight * 0.9,
      `pane ${Math.round(paneHeight)} of workspace ${Math.round(workspaceHeight)}`
    );
    check(
      "the textarea fills the pane",
      $("source").getBoundingClientRect().height > paneHeight * 0.9,
      Math.round($("source").getBoundingClientRect().height)
    );

    // 10. Pasting from a web page must arrive as plain text.
    //
    // The guard compared `event.target` with the editable root, which never matches: the
    // target is the element holding the caret. So rich clipboard HTML went straight in.
    click('[data-layout="live"]');
    await waitFor("live mode", () => workspace.dataset.layout === "live");
    const pasteTarget = live.querySelector("p") || live.querySelector("li") || live;
    selectInside(pasteTarget);
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        items: [],
        getData: (type) =>
          type === "text/plain"
            ? "PLAINTEXTPASTE"
            : '<b>RICHPASTE</b><div style="color:red">markup</div>',
      },
    });
    pasteTarget.dispatchEvent(pasteEvent);
    await waitFor("paste", () => source.value.includes("PLAINTEXTPASTE"));
    check("a paste arrives as plain text", source.value.includes("PLAINTEXTPASTE"), source.value);
    check(
      "the clipboard's markup did not come with it",
      !live.innerHTML.includes("RICHPASTE") && !source.value.includes("RICHPASTE"),
      live.innerHTML.slice(0, 200)
    );

    // 11. Syntax highlighting, and the alignment it depends on.
    //
    // The layer and the textarea must wrap identically. If they do not, their content heights
    // diverge and every line below the first difference is offset - so heights are the thing
    // to assert, not colours. The document deliberately mixes long unbroken URLs, bold and
    // italic runs, tabs and CJK, since those are what break wrapping.
    click('[data-layout="source"]');
    await waitFor("source mode", () => workspace.dataset.layout === "source");
    const layer = $("source-layer");
    check("the highlight layer exists", layer !== null);

    const ALIGN = [
      "# Heading with **bold** and *italic*",
      "",
      "- Go DT-SFI/dr-devops -> master: https://dta.example.com/job/DT-SFI/job/dr-devops/job/master/build?delay=0sec",
      "- **DEPLOYMENT_TYPE**: nr_dashboards and a very long trailing phrase that has to wrap somewhere sensible",
      "- [x] a task with `code` and ~~struck~~ text plus a [link](https://example.com/some/deep/path)",
      "",
      "> quoted text that is long enough to wrap across more than one visual line in a narrow pane",
      "",
      "```python",
      "print('hello')  # not a heading",
      "```",
      "",
      "\\ttab indented line with 你好 and cafe\\u0301 and an emoji rocket",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
    ].join("\\n");

    source.value = ALIGN;
    source.dispatchEvent(new Event("input", { bubbles: true }));
    // Wait for something only the *new* text contains. Waiting for "tok-heading" was
    // satisfied instantly by the previous document's heading, so every check below ran
    // against a stale layer - including the height comparison, which then meant nothing.
    await waitFor("highlight", () => layer.textContent.includes("DEPLOYMENT_TYPE"));

    check("headings are coloured", layer.innerHTML.includes("tok-heading"));
    check("code spans are coloured", layer.innerHTML.includes("tok-code"));
    check("links are coloured", layer.innerHTML.includes("tok-url"));
    check("markers are dimmed", layer.innerHTML.includes("tok-marker"));
    check("fenced code is coloured", layer.innerHTML.includes("tok-lang"));
    check("task boxes are coloured", layer.innerHTML.includes("tok-task"));
    check(
      "the layer shows exactly the document text",
      layer.textContent === `${ALIGN}\\n`,
      JSON.stringify(layer.textContent.slice(0, 60))
    );

    // Compare wrapped heights. The textarea's own height is set from the layer, so measure
    // its scrollHeight, which reflects how the browser laid the same text out.
    const layerHeight = layer.scrollHeight;
    const textHeight = source.scrollHeight;
    check(
      "the layer and the textarea wrap to the same height",
      Math.abs(layerHeight - textHeight) <= 2,
      `layer ${layerHeight} vs textarea ${textHeight}`
    );
    check(
      "the wrapped text is taller than one line (so wrapping was exercised)",
      layerHeight > 300,
      layerHeight
    );

    // Narrow the pane to force different wrap points, then compare again.
    const workspaceElement = workspace;
    const originalWidth = workspaceElement.style.width;
    workspaceElement.style.width = "420px";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(80);
    check(
      "they still agree when the pane is narrow",
      Math.abs(layer.scrollHeight - source.scrollHeight) <= 2,
      `layer ${layer.scrollHeight} vs textarea ${source.scrollHeight}`
    );
    workspaceElement.style.width = originalWidth;

    click('[data-layout="live"]');
    await waitFor("back to live", () => workspace.dataset.layout === "live");

    // 12. The shareable file: one HTML anyone can open, with the .rkf inside it.
    //
    // Built from the same template `rk share` fills, so the two surfaces cannot drift into
    // producing different artifacts. The check that matters is that the document can be read
    // back out of the page - that is the whole promise of the file.
    const blobsBefore = createdBlobs.length;
    click("#act-share");
    const built = await waitFor("share", () => createdBlobs.length > blobsBefore, 400);
    check("a shareable file was produced", built, createdBlobs.length - blobsBefore);

    if (built) {
      const page = await createdBlobs[createdBlobs.length - 1].text();
      check("it is an HTML document", page.startsWith("<!doctype html>"), page.slice(0, 40));
      check("no placeholders were left unfilled", !/\\{\\{[A-Z_]+\\}\\}/.test(page),
        (page.match(/\\{\\{[A-Z_]+\\}\\}/g) || []).join(","));
      check("nothing external is referenced", !/<script src=|<link /.test(page),
        (page.match(/<script src=[^>]*>|<link [^>]*>/g) || []).join(" "));
      check("the reader is inlined", page.includes("function looksLikeRkf"));
      check("the renderer is inlined", page.includes("tok-") === false || page.includes("figurize"),
        "markdown.js marker missing");
      check("there is a text fallback for no-JavaScript", page.includes("<noscript>"));

      const match = /<script id="rkf-payload" type="application\\/base64">([\\s\\S]*?)<\\/script>/.exec(page);
      check("it carries a payload", match !== null);
      if (match) {
        const binary = atob(match[1].replace(/\\s+/g, ""));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        check("the payload is a .rkf", RKF.looksLikeRkf(bytes), "signature missing");
        const reopened = await RKF.open(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        );
        check(
          "the document reads back out of the page",
          reopened.markdown === source.value,
          JSON.stringify(reopened.markdown.slice(0, 60))
        );
        check("its images came with it", reopened.assets.length === 1, reopened.assets.length);
        check("their checksums verify", reopened.assets[0].verified === true);
      }
    }

    // 13. The images panel.
    click("#act-images");
    await wait(150);
    check("the details panel opens", $("details").hidden === false);
    check("it lists the embedded image", $("details-assets").textContent.includes("assets/dot.png"),
      $("details-assets").textContent);
    check("it reports the checksum as verified", $("details-assets").textContent.includes("sha256"),
      $("details-assets").textContent);
    // 14. Installability, and opening a double-clicked .rkf.
    //
    // Last, because a launch replaces the open document.
    //
    // A browser picks its handler from the file extension, so the only way a .rkf can open in
    // one is for an installed app to claim the extension through the manifest. These checks
    // cover the parts that do not need an actual install: the manifest declares the handler,
    // and the app acts on a launch when the OS delivers one.
    const manifest = await fetch("../docs/manifest.webmanifest").then((r) => r.json());
    check("the manifest declares a file handler", Array.isArray(manifest.file_handlers));
    const handler = (manifest.file_handlers || [])[0] || {};
    const extensions = Object.values(handler.accept || {}).flat();
    check("it claims .rkf", extensions.includes(".rkf"), JSON.stringify(extensions));
    check("it claims .rk too", extensions.includes(".rk"), JSON.stringify(extensions));
    check(
      "under the format's own media type",
      Object.keys(handler.accept || {})[0] === "application/vnd.rkformat+zip",
      Object.keys(handler.accept || {}).join(",")
    );
    check("the manifest has an installable icon", (manifest.icons || []).some(
      (icon) => icon.sizes === "192x192" && icon.type === "image/png"
    ));
    check("and a maskable one", (manifest.icons || []).some(
      (icon) => (icon.purpose || "").includes("maskable")
    ));

    check("the app registered a launch consumer", typeof window.__launchConsumer === "function");
    if (typeof window.__launchConsumer === "function") {
      // Deliver a real document the way a double-click would.
      const response = await fetch("../docs/welcome.rkf");
      const launched = new File([await response.blob()], "launched.rkf", {
        type: "application/vnd.rkformat+zip",
      });
      let savedThrough = null;
      await window.__launchConsumer({
        files: [
          {
            // A launch hands over a handle, not a File, which is what lets Ctrl+S write back.
            getFile: async () => launched,
            createWritable: async () => ({
              write: async (bytes) => {
                savedThrough = bytes;
              },
              close: async () => {},
            }),
            name: "launched.rkf",
          },
        ],
      });
      const opened = await waitFor("launch", () => $("doc-name").textContent.includes("launched.rkf"));
      check("a launched .rkf opens", opened, $("doc-name").textContent);
      check(
        "its content is there",
        source.value.includes("Welcome to"),
        source.value.slice(0, 50)
      );

      // The handle came from the launch, so saving must go back through it rather than
      // prompting for a new file.
      click("#act-save");
      const wroteBack = await waitFor("save through handle", () => savedThrough !== null);
      check("saving writes back to the launched file", wroteBack, "no write seen");
      if (wroteBack) {
        check("what it wrote is a .rkf", RKF.looksLikeRkf(new Uint8Array(savedThrough)));
      }
    }

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
    stylesheets = extract_stylesheets()
    libraries = extract_scripts(before_app=True)
    application = extract_scripts(before_app=False)
    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Web editor harness</title>
{stylesheets}
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
{libraries}
{application}
{DRIVER_SCRIPT}
</body>
</html>
"""
    target.write_text(page, encoding="utf-8")
    print(f"wrote {target} ({target.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
