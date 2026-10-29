/**
 * Webview front end for the .rkf editor.
 *
 * Rendering is not done here — the body is sent to `rk preview` and the returned HTML is
 * displayed, so the in-editor page looks exactly like `rk render` output.
 */

"use strict";

(function () {
  const vscode = acquireVsCodeApi();

  const source = document.getElementById("source");
  const sourceLayer = document.getElementById("source-layer");
  const live = document.getElementById("live");
  const formatBar = document.getElementById("format-bar");
  const preview = document.getElementById("preview");
  const panes = document.getElementById("panes");
  const status = document.getElementById("status");
  const problems = document.getElementById("problems");
  const assetPanel = document.getElementById("assets");
  const assetList = document.getElementById("asset-list");

  let debounceMs = 250;
  let previewTimer = null;
  let seq = 0;
  let lastRendered = -1;
  let assets = [];
  let syncing = false;
  let liveTimer = null;
  let latestHtml = "";
  let liveDirty = false;
  // Where "Toggle Live" goes back to. Split when the document opened straight into Live.
  let layoutBeforeLive = "split";

  // ------------------------------------------------------------------- layout

  function setLayout(name) {
    const previous = panes.dataset.layout;
    if (name === "live" && previous && previous !== "live") layoutBeforeLive = previous;
    panes.dataset.layout = name;
    formatBar.hidden = name !== "live";
    for (const button of document.querySelectorAll("[data-layout]")) {
      button.classList.toggle("active", button.dataset.layout === name);
    }
    if (name === "live" && previous !== "live") {
      // Entering live editing: fetch a fresh render of whatever the source currently says,
      // so the editable page always starts from the canonical renderer's output.
      refreshLive();
    }
    if (previous === "live" && name !== "live") {
      // Leaving live editing: make sure the source reflects the last keystrokes.
      serializeLive({ immediate: true });
    }
    if (name !== "live") {
      // The pane may have changed width, which changes where lines wrap.
      scheduleHighlight();
    }
    try {
      vscode.setState(Object.assign({}, vscode.getState(), { layout: name }));
    } catch (err) {
      /* state persistence is best effort */
    }
  }

  for (const button of document.querySelectorAll("[data-layout]")) {
    button.addEventListener("click", () => setLayout(button.dataset.layout));
  }

  /**
   * Full width or a narrow page.
   *
   * A measure of ~75 characters is right for reading, but cramped for writing - which is why
   * the default is the full pane and this only exists to switch back.
   */
  function setWidth(name) {
    const width = name === "page" ? "page" : "full";
    document.body.dataset.width = width;
    document.getElementById("toggle-width").classList.toggle("active", width === "page");
    try {
      vscode.setState({ ...(vscode.getState() || {}), width });
    } catch (err) {
      /* state persistence is best effort */
    }
  }

  document.getElementById("toggle-width").addEventListener("click", () =>
    setWidth(document.body.dataset.width === "page" ? "full" : "page")
  );
  document.getElementById("cleanup").addEventListener("click", () =>
    vscode.postMessage({ type: "cleanup" })
  );
  document.getElementById("toggle-assets").addEventListener("click", () => {
    assetPanel.hidden = !assetPanel.hidden;
    document.getElementById("toggle-assets").classList.toggle("active", !assetPanel.hidden);
  });

  // -------------------------------------------------------------------- editing

  // ------------------------------------------------------------- highlighting

  // Above this size the highlighter is skipped and the source shown plain: re-tokenising a
  // very large document on every keystroke is the one thing that would make typing lag.
  const HIGHLIGHT_LIMIT = 400 * 1024;
  let highlightFrame = null;

  /**
   * Repaint the highlighted layer under the textarea.
   *
   * The textarea is stretched to the layer's height because neither element scrolls on its
   * own - the wrapper does. See the note at the top of highlight.css for why that matters.
   */
  function refreshHighlight() {
    if (!sourceLayer) return;
    const text = source.value;
    if (text.length > HIGHLIGHT_LIMIT) {
      sourceLayer.textContent = `${text}\n`;
    } else {
      sourceLayer.innerHTML = RKF.highlight.markdown(text);
    }
    source.style.height = `${sourceLayer.offsetHeight}px`;
  }

  /**
   * Coalesce repaints across a burst of keystrokes.
   *
   * A timer rather than requestAnimationFrame: rAF only fires when the browser produces a
   * frame, which a headless browser under a virtual clock does not, so the layer would never
   * repaint under test. The guard means fast typing still costs one repaint per tick.
   */
  function scheduleHighlight() {
    if (highlightFrame) return;
    highlightFrame = setTimeout(() => {
      highlightFrame = null;
      refreshHighlight();
    }, 16);
  }

  window.addEventListener("resize", scheduleHighlight);

  // ---------------------------------------------------------------- live editing

  /** Ask the host to render the current source, and load it into the editable page. */
  function refreshLive() {
    seq += 1;
    setStatus("rendering\u2026");
    vscode.postMessage({
      type: "requestPreview",
      markdown: source.value,
      seq,
      forLive: true,
    });
  }

  /**
   * Turn the edited page back into Markdown.
   *
   * The live pane is never re-rendered while typing - that would move the caret on every
   * keystroke. Instead the DOM is serialised and the source textarea is updated, so
   * switching modes is seamless in either direction.
   */
  function serializeLive(options = {}) {
    if (liveTimer) {
      clearTimeout(liveTimer);
      liveTimer = null;
    }
    const run = () => {
      if (!liveDirty) return;
      liveDirty = false;
      let markdown;
      try {
        markdown = RKF.toMarkdown(live);
      } catch (err) {
        setStatus("could not read the edited page");
        return;
      }
      if (markdown === source.value) return;
      // Turning HTML back into Markdown is the lossy direction. If the page serialises to far
      // less than it held - foreign markup pasted in, say - the edit is still applied, since
      // refusing would strand it, but the loss is reported rather than silently accepted.
      const before = source.value.length;
      if (before > 400 && markdown.length < before * 0.6) {
        setStatus("serialised to much less text - Ctrl+Z to undo");
      }
      source.value = markdown;
      scheduleHighlight();
      vscode.postMessage({ type: "change", markdown, label: "Edit page" });
    };
    if (options.immediate) run();
    else liveTimer = setTimeout(run, debounceMs);
  }

  live.addEventListener("input", () => {
    liveDirty = true;
    serializeLive();
  });

  live.addEventListener("blur", () => serializeLive({ immediate: true }));

  // Paste as plain text: pasted rich HTML from elsewhere would drag in markup the format
  // cannot express. Images are handled separately and do get embedded.
  live.addEventListener("paste", (event) => {
    const data = event.clipboardData;
    if (!data) return;
    const hasImage = Array.from(data.items || []).some(
      (item) => item.kind === "file" && item.type.startsWith("image/")
    );
    if (hasImage) return; // the document-level handler embeds it
    const text = data.getData("text/plain");
    if (text === null || text === undefined) return;
    event.preventDefault();
    document.execCommand("insertText", false, text);
  });

  function applyFormat(action) {
    // Undo and redo belong to VS Code (see applyEdit in extension.js), so they are asked for
    // rather than reimplemented here - a second history would fight the first.
    if (action === "undo" || action === "redo") {
      vscode.postMessage({ type: "history", direction: action });
      return;
    }
    if (action === "image") {
      vscode.postMessage({ type: "pickImage" });
      return;
    }
    RKF.liveFormat.apply(live, action);
    liveDirty = true;
    serializeLive({ immediate: true });
  }

  live.addEventListener("change", (event) => {
    if (event.target && event.target.type === "checkbox") {
      liveDirty = true;
      serializeLive({ immediate: true });
    }
  });

  for (const button of formatBar.querySelectorAll("[data-format]")) {
    // mousedown, so the selection in the editable region is still live.
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      applyFormat(button.dataset.format);
    });
  }

  live.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "b" || key === "i") {
      event.preventDefault();
      applyFormat(key === "b" ? "bold" : "italic");
    } else if (key === "k") {
      event.preventDefault();
      applyFormat("link");
    }
  });

  /** Insert an embedded image at the caret, as a real element. */
  function insertImageElement(asset) {
    RKF.liveFormat.insertImage(live, {
      src: asset.data_uri,
      alt: asset.alt,
      path: asset.path,
      width: asset.width,
      height: asset.height,
    });
    liveDirty = true;
    serializeLive({ immediate: true });
  }

  /**
   * Apply a body the host handed back (undo/redo), without reporting it as an edit.
   *
   * The caret is parked at the first character that differs, which is where the change the
   * user just reversed actually was - better than snapping to the top of the document.
   */
  function restoreBody(markdown) {
    const previous = source.value;
    let common = 0;
    while (
      common < previous.length &&
      common < markdown.length &&
      previous[common] === markdown[common]
    ) {
      common += 1;
    }
    source.value = markdown;
    refreshHighlight();
    if (document.activeElement === source) {
      const caret = Math.min(common, markdown.length);
      try {
        source.setSelectionRange(caret, caret);
      } catch (err) {
        /* not focusable right now; harmless */
      }
    }
    if (panes.dataset.layout === "live") {
      // The editable page has to be re-rendered from the restored source.
      refreshLive();
    } else {
      schedulePreview();
    }
  }

  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(requestPreview, debounceMs);
  }

  function requestPreview() {
    seq += 1;
    setStatus("rendering…");
    vscode.postMessage({ type: "requestPreview", markdown: source.value, seq });
  }

  source.addEventListener("input", () => {
    scheduleHighlight();
    vscode.postMessage({ type: "change", markdown: source.value, label: "Typing" });
    schedulePreview();
  });

  source.addEventListener("scroll", () => {
    if (syncing) return;
    const range = source.scrollHeight - source.clientHeight;
    if (range <= 0) return;
    syncing = true;
    const pane = document.getElementById("preview-pane");
    pane.scrollTop = (source.scrollTop / range) * (pane.scrollHeight - pane.clientHeight);
    requestAnimationFrame(() => {
      syncing = false;
    });
  });

  function insertAtCursor(text) {
    const start = source.selectionStart;
    const end = source.selectionEnd;
    const before = source.value.slice(0, start);
    const after = source.value.slice(end);
    const lead = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const trail = after.startsWith("\n") ? "\n" : "\n\n";
    const payload = lead + text + trail;
    source.value = before + payload + after;
    scheduleHighlight();
    const caret = start + payload.length;
    source.setSelectionRange(caret, caret);
    source.focus();
    vscode.postMessage({ type: "change", markdown: source.value, label: "Insert" });
    requestPreview();
  }

  // ------------------------------------------------------- paste & drop images

  function sendImage(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      if (comma < 0) return;
      vscode.postMessage({
        type: "pasteImage",
        filename: file.name || guessName(file.type),
        data_base64: result.slice(comma + 1),
      });
      setStatus("embedding image…");
    };
    reader.readAsDataURL(file);
  }

  function guessName(mime) {
    const ext = (mime || "image/png").split("/")[1] || "png";
    return "pasted." + ext.replace("+xml", "");
  }

  document.addEventListener("paste", (event) => {
    const items = event.clipboardData && event.clipboardData.items;
    if (!items) return;
    let handled = false;
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          sendImage(file);
          handled = true;
        }
      }
    }
    if (handled) event.preventDefault();
  });

  for (const target of [source, preview]) {
    target.addEventListener("dragover", (event) => {
      event.preventDefault();
      panes.classList.add("dropping");
    });
    target.addEventListener("dragleave", () => panes.classList.remove("dropping"));
    target.addEventListener("drop", (event) => {
      panes.classList.remove("dropping");
      const files = event.dataTransfer && event.dataTransfer.files;
      if (!files || !files.length) return;
      event.preventDefault();
      for (const file of files) {
        if (file.type.startsWith("image/")) sendImage(file);
      }
    });
  }

  // -------------------------------------------------------------------- panels

  function setStatus(text) {
    status.textContent = text;
  }

  function renderProblems(list) {
    const shown = (list || []).filter((p) => p.severity !== "info");
    if (!shown.length) {
      problems.hidden = true;
      problems.textContent = "";
      return;
    }
    problems.hidden = false;
    problems.textContent = "";
    for (const problem of shown) {
      const row = document.createElement("div");
      row.className = "problem " + problem.severity;
      row.textContent = `${problem.severity}: ${problem.message}`;
      problems.appendChild(row);
    }
  }

  function human(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function renderAssets(list) {
    assets = list || [];
    assetList.textContent = "";
    const total = assets.reduce((sum, a) => sum + a.bytes, 0);
    const heading = document.createElement("div");
    heading.className = "asset-heading";
    heading.textContent = `${assets.length} embedded image${assets.length === 1 ? "" : "s"} · ${human(total)}`;
    assetList.appendChild(heading);

    for (const asset of assets) {
      const row = document.createElement("div");
      row.className = "asset";

      const thumb = document.createElement("img");
      thumb.src = asset.data_uri || "";
      thumb.alt = asset.alt || asset.path;
      row.appendChild(thumb);

      const meta = document.createElement("div");
      meta.className = "asset-meta";
      const name = document.createElement("div");
      name.className = "asset-name";
      name.textContent = asset.path;
      const detail = document.createElement("div");
      detail.className = "asset-detail";
      const dims = asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : "";
      detail.textContent = `${asset.media_type.replace("image/", "")} · ${human(asset.bytes)}${dims}`;
      meta.appendChild(name);
      meta.appendChild(detail);
      row.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "asset-actions";
      const insert = document.createElement("button");
      insert.textContent = "Insert";
      insert.title = "Insert a reference to this image at the cursor";
      insert.addEventListener("click", () =>
        insertAtCursor(`![${asset.alt || ""}](${asset.path})`)
      );
      const remove = document.createElement("button");
      remove.textContent = "Remove";
      remove.className = "danger";
      remove.title = "Delete this image and its references";
      remove.addEventListener("click", () =>
        vscode.postMessage({ type: "removeAsset", ref: asset.id })
      );
      actions.appendChild(insert);
      actions.appendChild(remove);
      row.appendChild(actions);

      assetList.appendChild(row);
    }
  }

  // ------------------------------------------------------------------ messages

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "init":
        source.value = message.markdown;
        refreshHighlight();
        latestHtml = message.html || "";
        preview.innerHTML = latestHtml;
        live.innerHTML = latestHtml;
        RKF.liveFormat.enableCheckboxes(live);
        liveDirty = false;
        debounceMs = typeof message.debounceMs === "number" ? message.debounceMs : 250;
        renderAssets(message.assets);
        renderProblems(message.problems);
        setWidth((vscode.getState() && vscode.getState().width) || message.width || "full");
        setLayout((vscode.getState() && vscode.getState().layout) || message.layout || "split");
        setStatus("");
        break;

      case "preview":
        if (message.seq < lastRendered) break; // a newer render already landed
        lastRendered = message.seq;
        latestHtml = message.html;
        preview.innerHTML = message.html;
        // Only load the editable page on an explicit request: replacing its content while
        // someone is typing would throw the caret to the top of the document.
        if (message.forLive) {
          live.innerHTML = message.html;
          RKF.liveFormat.enableCheckboxes(live);
          liveDirty = false;
        }
        renderProblems(message.problems);
        if (message.assets) renderAssets(mergeThumbnails(message.assets));
        setStatus("");
        break;

      case "assets":
        renderAssets(message.assets);
        renderProblems(message.problems);
        setStatus("");
        break;

      case "insert":
        if (message.assets) renderAssets(message.assets);
        if (panes.dataset.layout === "live") {
          // In live editing the caret is in the page, so insert the picture itself rather
          // than Markdown text the user would see as source.
          const added = (message.assets || []).filter((asset) =>
            (message.text || "").includes(asset.path)
          );
          if (added.length) added.forEach(insertImageElement);
          else refreshLive();
        } else if (message.text) {
          insertAtCursor(message.text);
        }
        setStatus("");
        break;

      case "toggleLive": {
        const inLive = panes.dataset.layout === "live";
        setLayout(inLive ? layoutBeforeLive : "live");
        break;
      }

      case "restore":
        // Undo or redo happened on the host side. Put the body back without posting a
        // change, or the restored state would be recorded as a new edit.
        restoreBody(message.markdown);
        break;

      case "pickImage":
        vscode.postMessage({ type: "pickImage" });
        break;

      case "error":
        setStatus("");
        renderProblems([{ severity: "error", message: message.message }]);
        break;
    }
  });

  /** `rk preview` omits thumbnails; keep the ones we already have. */
  function mergeThumbnails(list) {
    const existing = new Map(assets.map((a) => [a.id, a.data_uri]));
    return list.map((a) => Object.assign({}, a, { data_uri: a.data_uri || existing.get(a.id) }));
  }

  vscode.postMessage({ type: "ready" });
})();
