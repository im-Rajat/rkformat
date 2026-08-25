/**
 * The web editor.
 *
 * Everything the VS Code extension does, minus VS Code: create, open, edit and save .rkf
 * documents entirely in the browser. Reading is rkf.js, writing is rkfwrite.js, rendering is
 * markdown.js, and turning the edited page back into Markdown is tomarkdown.js - all shared
 * with the extension, which is what keeps the two surfaces honest.
 *
 * What differs from the extension, and has to be built here instead:
 *
 *   undo/redo   VS Code owns the edit stack there; here the page owns it
 *   saving      no host to write the file, so File System Access or a download
 *   drafts      no workspace to recover from, so unsaved work is kept in IndexedDB
 *
 * Nothing is uploaded. There is no network request beyond fetching a document you point at.
 */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    bar: $("bar"),
    modes: $("modes"),
    barActions: $("bar-actions"),
    formatBar: $("format-bar"),
    intro: $("intro"),
    workspace: $("workspace"),
    live: $("live"),
    source: $("source"),
    preview: $("preview"),
    docMeta: $("doc-meta"),
    docName: $("doc-name"),
    details: $("details"),
    detailsInfo: $("details-info"),
    detailsAssets: $("details-assets"),
    detailsProblems: $("details-problems"),
    drop: $("drop"),
    file: $("file"),
    url: $("url"),
    urlForm: $("url-form"),
    status: $("status"),
    overlay: $("drop-overlay"),
    draftNotice: $("draft-notice"),
    draftText: $("draft-text"),
  };

  const ICON = (name) => RKF.toolbar.icon(name);

  let doc = null;
  let currentName = "untitled.rkf";
  let fileHandle = null; // File System Access handle, when the browser has it
  let layout = "live";
  let width = "full";
  let saved = true;

  // Undo/redo. Snapshots of the body: simple, and a document body is small next to its
  // images. Coalesced by time so a burst of typing is one step, as in a text editor.
  const history = { stack: [], index: -1, lastPush: 0 };
  const HISTORY_COALESCE_MS = 400;
  const HISTORY_LIMIT = 300;

  let previewTimer = null;
  let liveTimer = null;
  let draftTimer = null;
  let liveDirty = false;

  // ------------------------------------------------------------------- helpers

  function human(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(1)} GB`;
  }

  function status(message, kind) {
    if (!message) {
      els.status.hidden = true;
      return;
    }
    els.status.hidden = false;
    els.status.className = kind || "";
    els.status.textContent = "";
    const text = document.createElement("span");
    text.textContent = message;
    els.status.appendChild(text);
    if (kind === "error" || kind === "warn") {
      const dismiss = document.createElement("button");
      dismiss.className = "link";
      dismiss.textContent = "Dismiss";
      dismiss.addEventListener("click", () => status(null));
      els.status.appendChild(dismiss);
    } else {
      setTimeout(() => {
        if (els.status.textContent.startsWith(message)) status(null);
      }, 2500);
    }
  }

  function escape(text) {
    return RKF.markdown.escapeHtml(text);
  }

  /** github.com/blob links serve HTML and block cross-origin reads; raw serves the bytes. */
  function normaliseUrl(raw) {
    const value = String(raw).trim();
    const blob = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/i.exec(value);
    return blob ? `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}` : value;
  }

  function nameFromUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "document.rkf");
    } catch (err) {
      return "document.rkf";
    }
  }

  function markDirty(dirty) {
    saved = !dirty;
    els.docName.textContent = (dirty ? "● " : "") + currentName;
    els.docName.classList.toggle("dirty", dirty);
    if (dirty) scheduleDraft();
  }

  // ------------------------------------------------------------------ rendering

  function resolveImage(src) {
    if (!doc) return null;
    const asset = doc.resolve(src);
    if (!asset) return null;
    const url = doc.assetUrl(asset);
    return url ? { url, width: asset.width, height: asset.height } : null;
  }

  function render(markdown) {
    return RKF.markdown.render(markdown, { resolveImage });
  }

  function renderPreview() {
    els.preview.innerHTML = render(els.source.value);
    renderMeta();
    renderDetails();
  }

  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 200);
  }

  function renderMeta() {
    if (!doc) return;
    const bits = [`<span><strong>${escape(doc.title)}</strong></span>`];
    if (doc.manifest.authors && doc.manifest.authors.length) {
      bits.push(`<span>${escape(doc.manifest.authors.join(", "))}</span>`);
    }
    const count = doc.assets.length;
    bits.push(
      `<span>${count} embedded image${count === 1 ? "" : "s"} (${human(doc.assetBytesTotal)})</span>`
    );
    els.docMeta.innerHTML = bits.join("");
  }

  // ------------------------------------------------------------------- layout

  function setLayout(name) {
    const previous = layout;
    layout = name;
    els.workspace.dataset.layout = name;
    els.formatBar.hidden = name !== "live";
    for (const button of els.modes.querySelectorAll("[data-layout]")) {
      button.classList.toggle("active", button.dataset.layout === name);
    }
    if (name === "live" && previous !== "live") loadLive();
    if (previous === "live" && name !== "live") serializeLive(true);
    if (name !== "live") renderPreview();
    remember();
  }

  function setWidth(name) {
    width = name === "page" ? "page" : "full";
    document.body.dataset.width = width;
    $("act-width").classList.toggle("active", width === "page");
    remember();
  }

  function remember() {
    try {
      localStorage.setItem("rkf.ui", JSON.stringify({ layout, width }));
    } catch (err) {
      /* private browsing; preferences just will not persist */
    }
  }

  function recall() {
    try {
      return JSON.parse(localStorage.getItem("rkf.ui") || "{}");
    } catch (err) {
      return {};
    }
  }

  // -------------------------------------------------------------- live editing

  /** Load the rendered document into the editable page. */
  function loadLive() {
    els.live.innerHTML = render(els.source.value);
    for (const box of els.live.querySelectorAll('input[type="checkbox"]')) {
      // The renderers emit checkboxes disabled, which is right for a read-only page. While
      // editing, a checkbox you cannot tick is useless.
      box.disabled = false;
      box.setAttribute("contenteditable", "false");
    }
    liveDirty = false;
  }

  /**
   * Turn the edited page back into Markdown.
   *
   * The page is never re-rendered while typing - that would move the caret on every
   * keystroke. The DOM is serialised instead and the source textarea updated, so switching
   * modes is seamless either way.
   */
  function serializeLive(immediate) {
    if (liveTimer) {
      clearTimeout(liveTimer);
      liveTimer = null;
    }
    const run = () => {
      if (!liveDirty) return;
      liveDirty = false;
      let markdown;
      try {
        markdown = RKF.toMarkdown(els.live);
      } catch (err) {
        status("Could not read the edited page", "error");
        return;
      }
      if (markdown === els.source.value) return;
      els.source.value = markdown;
      commit(markdown);
    };
    if (immediate) run();
    else liveTimer = setTimeout(run, 300);
  }

  /** Record a body change: history, dirty flag, draft, and the document itself. */
  function commit(markdown) {
    if (!doc || markdown === doc.markdown) return;
    const now = Date.now();
    if (history.index < history.stack.length - 1) {
      history.stack = history.stack.slice(0, history.index + 1);
    }
    if (now - history.lastPush > HISTORY_COALESCE_MS || history.stack.length === 0) {
      history.stack.push(doc.markdown);
      if (history.stack.length > HISTORY_LIMIT) history.stack.shift();
      history.index = history.stack.length - 1;
      history.lastPush = now;
    }
    doc.markdown = markdown;
    doc.revalidate();
    markDirty(true);
    if (layout !== "live") schedulePreview();
    renderDetails();
  }

  function undo() {
    if (!doc || history.index < 0) {
      status("Nothing to undo");
      return;
    }
    const previous = history.stack[history.index];
    history.stack[history.index] = doc.markdown; // so redo can come back
    history.index -= 1;
    applyBody(previous);
  }

  function redo() {
    if (!doc || history.index >= history.stack.length - 1) {
      status("Nothing to redo");
      return;
    }
    history.index += 1;
    const next = history.stack[history.index];
    history.stack[history.index] = doc.markdown;
    applyBody(next);
  }

  /** Put a body back without recording it as a new edit. */
  function applyBody(markdown) {
    doc.markdown = markdown;
    const previous = els.source.value;
    let common = 0;
    while (common < previous.length && common < markdown.length && previous[common] === markdown[common]) {
      common += 1;
    }
    els.source.value = markdown;
    if (document.activeElement === els.source) {
      const caret = Math.min(common, markdown.length);
      try {
        els.source.setSelectionRange(caret, caret);
      } catch (err) {
        /* not focusable; harmless */
      }
    }
    doc.revalidate();
    markDirty(true);
    if (layout === "live") loadLive();
    else renderPreview();
    renderDetails();
  }

  // ------------------------------------------------------------- format actions

  function closest(selector) {
    const selection = window.getSelection();
    if (!selection || !selection.anchorNode) return null;
    const start =
      selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement;
    return start && els.live.contains(start) ? start.closest(selector) : null;
  }

  function wrapSelection(tagName) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (range.collapsed) return;
    const wrapper = document.createElement(tagName);
    try {
      wrapper.appendChild(range.extractContents());
      range.insertNode(wrapper);
      selection.removeAllRanges();
      const after = document.createRange();
      after.selectNodeContents(wrapper);
      selection.addRange(after);
    } catch (err) {
      /* selection spanned incompatible blocks */
    }
  }

  /**
   * Turn the block at the caret into a task item, or back into a plain one.
   *
   * Done by moving nodes rather than with execCommand: asking the browser to make a list out
   * of a heading nests the <ul> *inside* the <h2>, which the serialiser then flattens back to
   * a heading - silently losing the checkbox. Chaining formatBlock first does not help, since
   * the selection does not survive it reliably.
   */
  function toggleTask() {
    const checkbox = () => {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.setAttribute("contenteditable", "false");
      return box;
    };

    const item = closest("li");
    if (item) {
      const host = item.querySelector(":scope > p") || item;
      const existing = item.querySelector(
        ':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]'
      );
      if (existing) {
        existing.remove();
        item.classList.remove("rkf-task");
      } else {
        item.classList.add("rkf-task");
        host.insertBefore(checkbox(), host.firstChild);
      }
      return;
    }

    const block = closest("p, h1, h2, h3, h4, h5, h6, blockquote") || els.live.lastElementChild;
    if (!block || !els.live.contains(block)) return;
    const list = document.createElement("ul");
    const listItem = document.createElement("li");
    listItem.className = "rkf-task";
    listItem.appendChild(checkbox());
    while (block.firstChild) listItem.appendChild(block.firstChild);
    list.appendChild(listItem);
    block.replaceWith(list);

    const range = document.createRange();
    range.selectNodeContents(listItem);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  const FORMAT_BLOCKS = { h1: "H1", h2: "H2", h3: "H3", p: "P", quote: "BLOCKQUOTE", pre: "PRE" };

  function applyFormat(action) {
    if (action === "undo") return undo();
    if (action === "redo") return redo();
    if (action === "image") return pickImages();
    els.live.focus();
    switch (action) {
      case "bold":
      case "italic":
      case "outdent":
      case "indent":
        document.execCommand(action, false, null);
        break;
      case "strikethrough":
        document.execCommand("strikeThrough", false, null);
        break;
      case "clearFormat":
        document.execCommand("removeFormat", false, null);
        break;
      case "code":
        wrapSelection("code");
        break;
      case "task":
        toggleTask();
        break;
      case "ul":
        document.execCommand("insertUnorderedList", false, null);
        break;
      case "ol":
        document.execCommand("insertOrderedList", false, null);
        break;
      case "hr":
        document.execCommand("insertHTML", false, "<hr>");
        break;
      case "table":
        document.execCommand(
          "insertHTML",
          false,
          "<table><thead><tr><th>Column</th><th>Column</th><th>Column</th></tr></thead>" +
            "<tbody><tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table>"
        );
        break;
      case "link": {
        const url = window.prompt("Link URL");
        if (url) document.execCommand("createLink", false, url);
        break;
      }
      default:
        if (FORMAT_BLOCKS[action]) document.execCommand("formatBlock", false, FORMAT_BLOCKS[action]);
    }
    liveDirty = true;
    serializeLive(true);
  }

  // -------------------------------------------------------------------- images

  async function embedFiles(files) {
    if (!doc || !files || !files.length) return [];
    const added = [];
    for (const file of files) {
      if (!file.type.startsWith("image/") && !/\.(png|jpe?g|gif|webp|bmp|svg|avif|heic)$/i.test(file.name)) {
        continue;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        added.push(await doc.addImageBytes(bytes, file.name, null));
      } catch (err) {
        status(`${file.name}: ${err.message}`, "error");
      }
    }
    if (added.length) {
      markDirty(true);
      renderDetails();
    }
    return added;
  }

  function insertAsset(asset) {
    const reference = `![${asset.alt || ""}](${asset.path})`;
    if (layout === "live") {
      const img = document.createElement("img");
      img.src = doc.assetUrl(asset) || "";
      img.alt = asset.alt || "";
      img.className = "rkf-image";
      img.setAttribute("data-rkf-src", asset.path);
      img.setAttribute("data-rkf-md", "1");
      if (asset.width && asset.height) {
        img.width = asset.width;
        img.height = asset.height;
      }
      const selection = window.getSelection();
      if (selection && selection.rangeCount && els.live.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(img);
        range.setStartAfter(img);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        els.live.appendChild(img);
      }
      liveDirty = true;
      serializeLive(true);
      return;
    }
    const start = els.source.selectionStart;
    const before = els.source.value.slice(0, start);
    const after = els.source.value.slice(els.source.selectionEnd);
    const lead = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const payload = lead + reference + (after.startsWith("\n") ? "\n" : "\n\n");
    els.source.value = before + payload + after;
    const caret = start + payload.length;
    els.source.setSelectionRange(caret, caret);
    els.source.focus();
    commit(els.source.value);
    schedulePreview();
  }

  async function pickImages() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.addEventListener("change", async () => {
      const added = await embedFiles(Array.from(input.files || []));
      added.forEach(insertAsset);
    });
    input.click();
  }

  // -------------------------------------------------------------------- details

  function note(text) {
    const div = document.createElement("div");
    div.className = "muted small";
    div.textContent = text;
    return div;
  }

  function renderDetails() {
    if (!doc) return;
    const rows = [
      ["File", currentName],
      ["Title", doc.title],
      ["Spec version", doc.manifest.rkf_version || "1.0"],
      ["Authors", (doc.manifest.authors || []).join(", ") || "–"],
      ["Modified", doc.manifest.modified || "–"],
      ["Text", `${human(new TextEncoder().encode(doc.markdown).length)} (${doc.markdown.length} chars)`],
      ["Images", `${doc.assets.length}, ${human(doc.assetBytesTotal)} raw`],
    ];
    if (doc.fileSize) rows.splice(5, 0, ["File size", human(doc.fileSize)]);
    els.detailsInfo.textContent = "";
    for (const [label, value] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      els.detailsInfo.append(dt, dd);
    }

    els.detailsAssets.textContent = "";
    if (!doc.assets.length) els.detailsAssets.append(note("No embedded images yet."));
    for (const asset of doc.assets) {
      const row = document.createElement("div");
      row.className = "asset";

      const thumb = document.createElement("img");
      thumb.src = doc.assetUrl(asset) || "";
      thumb.alt = asset.alt || asset.path;
      thumb.loading = "lazy";
      row.appendChild(thumb);

      const meta = document.createElement("div");
      meta.className = "asset-meta";
      const name = document.createElement("div");
      name.className = "asset-name";
      name.textContent = asset.path;
      const detail = document.createElement("div");
      detail.className = "asset-detail";
      const dims = asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : "";
      const verified =
        asset.verified === true ? " · ✓ sha256" : asset.verified === false ? " · ✗ sha256" : "";
      detail.textContent = `${asset.media_type.replace("image/", "")} · ${human(asset.bytes)}${dims}${verified}`;
      meta.append(name, detail);
      row.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "asset-actions";
      const insert = document.createElement("button");
      insert.textContent = "Insert";
      insert.title = "Insert a reference at the cursor";
      insert.addEventListener("click", () => insertAsset(asset));
      const save = document.createElement("a");
      save.className = "small-btn";
      save.textContent = "Save";
      save.href = doc.assetUrl(asset) || "#";
      save.download = asset.path.split("/").pop();
      const remove = document.createElement("button");
      remove.textContent = "Remove";
      remove.className = "danger";
      remove.addEventListener("click", () => {
        doc.removeAsset(asset.id, { pruneRefs: true });
        els.source.value = doc.markdown;
        markDirty(true);
        doc.revalidate();
        if (layout === "live") loadLive();
        else renderPreview();
        renderDetails();
      });
      actions.append(insert, save, remove);
      row.appendChild(actions);
      els.detailsAssets.appendChild(row);
    }

    els.detailsProblems.textContent = "";
    const problems = doc.problems || [];
    if (!problems.length) els.detailsProblems.append(note("No problems."));
    for (const problem of problems) {
      const row = document.createElement("div");
      row.className = `problem ${problem.severity}`;
      row.textContent = `${problem.severity}: ${problem.message}`;
      els.detailsProblems.appendChild(row);
    }
  }

  // ------------------------------------------------------------- open and close

  function openDocument(next, name, handle) {
    if (doc) doc.dispose();
    doc = next;
    currentName = name || "untitled.rkf";
    fileHandle = handle || null;
    history.stack = [];
    history.index = -1;
    history.lastPush = 0;

    els.intro.hidden = true;
    els.workspace.hidden = false;
    els.modes.hidden = false;
    els.barActions.hidden = false;
    els.docName.hidden = false;
    $("act-new-top").hidden = false;
    document.title = `${doc.title} — .rkf`;

    els.source.value = doc.markdown;
    doc.revalidate();
    markDirty(false);
    const remembered = recall();
    setWidth(remembered.width || "full");
    setLayout(remembered.layout || "live");
    // setLayout only loads the editable page on a *transition* into live mode, so that
    // re-picking the current mode does not throw the caret away. Opening a document is not a
    // transition, so the page has to be filled explicitly.
    if (layout === "live") loadLive();
    renderPreview();

    const errors = (doc.problems || []).filter((p) => p.severity === "error").length;
    if (errors) status(`${errors} validation problem${errors === 1 ? "" : "s"} — see details.`, "warn");
    window.scrollTo(0, 0);
  }

  async function openBuffer(buffer, name, handle) {
    status("Reading…");
    try {
      const bytes = new Uint8Array(buffer);
      if (!RKF.looksLikeRkf(bytes)) {
        status("This file does not carry the .rkf signature — trying anyway…");
      }
      openDocument(await RKF.open(buffer), name, handle);
      status(null);
    } catch (err) {
      els.workspace.hidden = true;
      els.intro.hidden = false;
      status(`Could not open ${name}: ${err.message}`, "error");
    }
  }

  function openFile(file, handle) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => openBuffer(reader.result, file.name, handle);
    reader.onerror = () => status(`Could not read ${file.name}`, "error");
    reader.readAsArrayBuffer(file);
  }

  async function openUrl(raw, options = {}) {
    const url = normaliseUrl(raw);
    const name = nameFromUrl(url);
    status(`Fetching ${name}…`);
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`the server answered ${response.status} ${response.statusText}`);
      const buffer = await response.arrayBuffer();
      if (options.updateHistory !== false) {
        window.history.replaceState(null, "", `?url=${encodeURIComponent(raw)}`);
      }
      await openBuffer(buffer, name, null);
    } catch (err) {
      const detail = err.message || String(err);
      status(
        /fetch|network|load failed|cors/i.test(detail)
          ? `Could not fetch ${name}: ${detail}. The host has to allow cross-origin reads ` +
            "(raw.githubusercontent.com does). Otherwise download it and drop it here."
          : `Could not fetch ${name}: ${detail}`,
        "error"
      );
    }
  }

  const NEW_BODY = "# Untitled\n\nStart writing.\n";

  function newDocument() {
    const title = window.prompt("Document title", "Untitled");
    if (title === null) return;
    const clean = title.trim() || "Untitled";
    const created = RKF.create({ title: clean, markdown: `# ${clean}\n\n` });
    const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
    openDocument(created, `${slug}.rkf`, null);
    els.live.focus();
  }

  function closeDocument() {
    if (!saved && !window.confirm("This document has unsaved changes. Close it anyway?")) return;
    if (doc) doc.dispose();
    doc = null;
    fileHandle = null;
    els.workspace.hidden = true;
    els.modes.hidden = true;
    els.barActions.hidden = true;
    els.docName.hidden = true;
    els.details.hidden = true;
    els.formatBar.hidden = true;
    $("act-new-top").hidden = true;
    els.intro.hidden = false;
    els.live.innerHTML = "";
    els.source.value = "";
    document.title = ".rkf — read, write and edit in the browser";
    if (location.search) window.history.replaceState(null, "", location.pathname);
    clearDraft();
    status(null);
  }

  // ---------------------------------------------------------------------- save

  const SAVE_PICKER_OPTIONS = {
    suggestedName: "document.rkf",
    types: [{ description: "RK Document", accept: { "application/vnd.rkformat+zip": [".rkf"] } }],
  };

  async function save(forceNewFile) {
    if (!doc) return;
    if (layout === "live") serializeLive(true);
    status("Saving…");
    try {
      const bytes = await RKF.serialize(doc);
      // File System Access lets a save actually overwrite the file you opened. Where it is
      // missing (Firefox, Safari) a download is the only option the browser offers.
      if (window.showSaveFilePicker) {
        if (forceNewFile || !fileHandle) {
          fileHandle = await window.showSaveFilePicker({
            ...SAVE_PICKER_OPTIONS,
            suggestedName: currentName,
          });
          currentName = fileHandle.name || currentName;
        }
        const writable = await fileHandle.createWritable();
        await writable.write(bytes);
        await writable.close();
      } else {
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.rkformat+zip" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = currentName;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
      markDirty(false);
      clearDraft();
      status(`Saved ${currentName}`);
    } catch (err) {
      if (err && err.name === "AbortError") {
        status(null);
        return;
      }
      status(`Could not save: ${err.message}`, "error");
    }
  }

  async function openViaPicker() {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: SAVE_PICKER_OPTIONS.types,
          multiple: false,
        });
        openFile(await handle.getFile(), handle);
      } catch (err) {
        if (err && err.name !== "AbortError") status(err.message, "error");
      }
      return;
    }
    els.file.click();
  }

  async function exportHtml() {
    if (!doc) return;
    status("Building HTML…");
    try {
      const dataUris = new Map();
      for (const asset of doc.assets) dataUris.set(asset.path, await doc.assetDataUri(asset));
      const body = RKF.markdown.render(doc.markdown, {
        resolveImage(src) {
          const asset = doc.resolve(src);
          return asset ? { url: dataUris.get(asset.path), width: asset.width, height: asset.height } : null;
        },
      });
      const css = await fetch("assets/document.css").then((r) => r.text());
      const html =
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
        `<title>${escape(doc.title)}</title>\n<style>${css}</style>\n</head>\n<body>\n` +
        `<main class="rkf-page">\n${body}\n</main>\n</body>\n</html>\n`;
      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = currentName.replace(/\.(rkf|rk)$/i, "") + ".html";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      status(null);
    } catch (err) {
      status(`Could not build HTML: ${err.message}`, "error");
    }
  }

  // -------------------------------------------------------------------- drafts

  /**
   * Unsaved work is kept in IndexedDB.
   *
   * A web page can be closed or reloaded at any moment, and losing a document to a stray
   * Ctrl+W would make this useless as a notepad. The whole .rkf is stored, images included,
   * because localStorage would blow its quota on the first screenshot.
   */
  const DRAFT_DB = "rkformat";
  const DRAFT_STORE = "drafts";

  function withStore(mode) {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB unavailable"));
        return;
      }
      const request = indexedDB.open(DRAFT_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        resolve(db.transaction(DRAFT_STORE, mode).objectStore(DRAFT_STORE));
      };
      request.onerror = () => reject(request.error || new Error("IndexedDB failed"));
    });
  }

  function scheduleDraft() {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 1500);
  }

  async function saveDraft() {
    if (!doc || saved) return;
    try {
      const store = await withStore("readwrite");
      store.put(
        { name: currentName, bytes: await RKF.serialize(doc), savedAt: new Date().toISOString() },
        "current"
      );
    } catch (err) {
      /* no IndexedDB: drafts simply are not kept */
    }
  }

  async function readDraft() {
    try {
      const store = await withStore("readonly");
      return await new Promise((resolve) => {
        const request = store.get("current");
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
      });
    } catch (err) {
      return null;
    }
  }

  async function clearDraft() {
    try {
      (await withStore("readwrite")).delete("current");
    } catch (err) {
      /* nothing to clear */
    }
  }

  async function offerDraft() {
    const draft = await readDraft();
    if (!draft || !draft.bytes) return;
    els.draftNotice.hidden = false;
    const when = new Date(draft.savedAt);
    els.draftText.textContent = `Unsaved work from ${when.toLocaleString()} (${draft.name}).`;
    $("act-restore").addEventListener("click", async () => {
      els.draftNotice.hidden = true;
      const bytes = draft.bytes instanceof Uint8Array ? draft.bytes : new Uint8Array(draft.bytes);
      await openBuffer(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        draft.name,
        null
      );
      markDirty(true);
    });
    $("act-discard").addEventListener("click", () => {
      els.draftNotice.hidden = true;
      clearDraft();
    });
  }

  // -------------------------------------------------------------------- wiring

  els.formatBar.innerHTML = RKF.toolbar.formatBarHtml();
  for (const button of els.formatBar.querySelectorAll("[data-format]")) {
    button.addEventListener("mousedown", (event) => {
      event.preventDefault(); // keep the selection in the editable page
      applyFormat(button.dataset.format);
    });
  }

  const TOOL_ICONS = {
    "act-save": "save",
    "act-saveas": "saveas",
    "act-images": "gallery",
    "act-cleanup": "sweep",
    "act-width": "page",
    "act-export": "export",
    "act-close": "close",
    "act-new-top": "newfile",
  };
  for (const [id, name] of Object.entries(TOOL_ICONS)) {
    const button = $(id);
    if (button) button.innerHTML = ICON(name) || "";
  }

  for (const button of els.modes.querySelectorAll("[data-layout]")) {
    button.addEventListener("click", () => setLayout(button.dataset.layout));
  }

  $("act-new").addEventListener("click", newDocument);
  $("act-new-top").addEventListener("click", () => {
    if (saved || window.confirm("This document has unsaved changes. Start a new one anyway?")) {
      newDocument();
    }
  });
  $("act-open").addEventListener("click", openViaPicker);
  $("act-demo").addEventListener("click", () => openUrl("welcome.rkf"));
  $("act-save").addEventListener("click", () => save(false));
  $("act-saveas").addEventListener("click", () => save(true));
  $("act-export").addEventListener("click", exportHtml);
  $("act-close").addEventListener("click", closeDocument);
  $("act-width").addEventListener("click", () => setWidth(width === "page" ? "full" : "page"));
  $("act-details-close").addEventListener("click", () => {
    els.details.hidden = true;
    $("act-images").classList.remove("active");
  });
  $("act-images").addEventListener("click", () => {
    els.details.hidden = !els.details.hidden;
    $("act-images").classList.toggle("active", !els.details.hidden);
    renderDetails();
  });
  $("act-cleanup").addEventListener("click", () => {
    if (!doc) return;
    const orphans = doc.orphanAssets();
    if (!orphans.length) {
      status("Every embedded image is referenced.");
      return;
    }
    let freed = 0;
    for (const asset of orphans) {
      freed += asset.bytes;
      doc.removeAsset(asset.id);
    }
    markDirty(true);
    doc.revalidate();
    renderDetails();
    status(`Removed ${orphans.length} unreferenced image${orphans.length === 1 ? "" : "s"} (${human(freed)}).`);
  });

  els.drop.addEventListener("click", () => els.file.click());
  els.drop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      els.file.click();
    }
  });
  els.file.addEventListener("change", () => {
    openFile(els.file.files[0]);
    els.file.value = "";
  });

  els.urlForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = els.url.value.trim();
    if (value) openUrl(value);
  });

  els.source.addEventListener("input", () => {
    commit(els.source.value);
    schedulePreview();
  });

  els.source.addEventListener("scroll", () => {
    const range = els.source.scrollHeight - els.source.clientHeight;
    if (range <= 0 || layout !== "split") return;
    const pane = $("preview-pane");
    pane.scrollTop = (els.source.scrollTop / range) * (pane.scrollHeight - pane.clientHeight);
  });

  els.live.addEventListener("input", () => {
    liveDirty = true;
    serializeLive(false);
  });
  els.live.addEventListener("blur", () => serializeLive(true));
  els.live.addEventListener("change", (event) => {
    if (event.target && event.target.type === "checkbox") {
      liveDirty = true;
      serializeLive(true);
    }
  });

  // Paste: images are embedded, everything else arrives as plain text so foreign markup
  // cannot smuggle in structures the format cannot express.
  document.addEventListener("paste", async (event) => {
    if (!doc) return;
    const data = event.clipboardData;
    if (!data) return;
    const images = Array.from(data.items || [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (images.length) {
      event.preventDefault();
      status("Embedding image…");
      const added = await embedFiles(images);
      added.forEach(insertAsset);
      status(null);
      return;
    }
    if (event.target === els.live) {
      const text = data.getData("text/plain");
      if (text) {
        event.preventDefault();
        document.execCommand("insertText", false, text);
      }
    }
  });

  let dragDepth = 0;
  window.addEventListener("dragenter", (event) => {
    if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
    dragDepth += 1;
    els.overlay.hidden = false;
  });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.overlay.hidden = true;
  });
  window.addEventListener("drop", async (event) => {
    event.preventDefault();
    dragDepth = 0;
    els.overlay.hidden = true;
    const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
    if (!files.length) return;
    const document_ = files.find((file) => /\.(rkf|rk)$/i.test(file.name));
    if (document_) {
      openFile(document_);
      return;
    }
    if (doc) {
      const added = await embedFiles(files);
      added.forEach(insertAsset);
    }
  });

  window.addEventListener("keydown", (event) => {
    const meta = event.ctrlKey || event.metaKey;
    if (meta && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save(false);
      return;
    }
    if (!doc) return;
    if (meta && event.key.toLowerCase() === "z") {
      // The textarea has its own undo; only take over inside the editable page.
      if (document.activeElement === els.source) return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (meta && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (meta && layout === "live" && document.activeElement === els.live) {
      const key = event.key.toLowerCase();
      if (key === "b" || key === "i") {
        event.preventDefault();
        applyFormat(key === "b" ? "bold" : "italic");
      } else if (key === "k") {
        event.preventDefault();
        applyFormat("link");
      }
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (saved) return;
    saveDraft();
    event.preventDefault();
    event.returnValue = "";
  });

  // A shared link opens straight into the document.
  const params = new URLSearchParams(location.search || location.hash.replace(/^#/, "?"));
  const initial = params.get("url") || params.get("doc");
  if (initial) {
    openUrl(initial, { updateHistory: false });
  } else if (params.has("new")) {
    openDocument(RKF.create({ title: "Untitled", markdown: NEW_BODY }), "untitled.rkf", null);
  } else {
    offerDraft();
  }
})();
