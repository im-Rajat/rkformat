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

  // ------------------------------------------------------------------- layout

  function setLayout(name) {
    panes.dataset.layout = name;
    for (const button of document.querySelectorAll("[data-layout]")) {
      button.classList.toggle("active", button.dataset.layout === name);
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

  document.getElementById("insert-image").addEventListener("click", () =>
    vscode.postMessage({ type: "pickImage" })
  );
  document.getElementById("cleanup").addEventListener("click", () =>
    vscode.postMessage({ type: "cleanup" })
  );
  document.getElementById("toggle-assets").addEventListener("click", () => {
    assetPanel.hidden = !assetPanel.hidden;
    document.getElementById("toggle-assets").classList.toggle("active", !assetPanel.hidden);
  });

  // -------------------------------------------------------------------- editing

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
    vscode.postMessage({ type: "change", markdown: source.value });
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
    const caret = start + payload.length;
    source.setSelectionRange(caret, caret);
    source.focus();
    vscode.postMessage({ type: "change", markdown: source.value });
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
        preview.innerHTML = message.html || "";
        debounceMs = typeof message.debounceMs === "number" ? message.debounceMs : 250;
        renderAssets(message.assets);
        renderProblems(message.problems);
        setLayout((vscode.getState() && vscode.getState().layout) || message.layout || "split");
        setStatus("");
        break;

      case "preview":
        if (message.seq < lastRendered) break; // a newer render already landed
        lastRendered = message.seq;
        preview.innerHTML = message.html;
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
        if (message.text) insertAtCursor(message.text);
        setStatus("");
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
