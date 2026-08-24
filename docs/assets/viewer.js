/**
 * Viewer UI.
 *
 * Everything happens locally: the file is read with FileReader or fetch, parsed by rkf.js,
 * and rendered by markdown.js. No upload, no analytics, no third-party requests.
 */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    intro: $("intro"),
    reader: $("reader"),
    page: $("page"),
    docMeta: $("doc-meta"),
    source: $("source"),
    details: $("details"),
    detailsInfo: $("details-info"),
    detailsAssets: $("details-assets"),
    detailsProblems: $("details-problems"),
    barActions: $("bar-actions"),
    drop: $("drop"),
    file: $("file"),
    url: $("url"),
    urlForm: $("url-form"),
    status: $("status"),
    overlay: $("drop-overlay"),
    actSource: $("act-source"),
    actDetails: $("act-details"),
    actExport: $("act-export"),
    actClose: $("act-close"),
    actDemo: $("act-demo"),
  };

  let current = null;
  let currentName = "";

  // -------------------------------------------------------------------- helpers

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
    if (kind === "error") {
      const dismiss = document.createElement("button");
      dismiss.className = "link";
      dismiss.textContent = "Dismiss";
      dismiss.addEventListener("click", () => status(null));
      els.status.appendChild(dismiss);
    }
  }

  /**
   * Turn a human-facing GitHub link into one a browser is allowed to read.
   *
   * github.com/<user>/<repo>/blob/<ref>/<path> serves HTML and blocks cross-origin reads;
   * raw.githubusercontent.com serves the bytes with Access-Control-Allow-Origin: *.
   */
  function normaliseUrl(raw) {
    const value = String(raw).trim();
    const blob = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/i.exec(value);
    if (blob) {
      return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`;
    }
    return value;
  }

  function nameFromUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "document.rkf");
    } catch (err) {
      return "document.rkf";
    }
  }

  // ---------------------------------------------------------------------- render

  function resolveImage(src) {
    if (!current) return null;
    const asset = current.resolve(src);
    if (!asset) return null;
    const url = current.assetUrl(asset);
    if (!url) return null;
    return { url, width: asset.width, height: asset.height };
  }

  function renderMeta(doc) {
    const bits = [];
    const add = (html) => bits.push(html);
    add(`<span><strong>${escape(doc.title)}</strong></span>`);
    if (doc.manifest.authors && doc.manifest.authors.length) {
      add(`<span>${escape(doc.manifest.authors.join(", "))}</span>`);
    }
    if (doc.manifest.modified) add(`<span>modified ${escape(doc.manifest.modified)}</span>`);
    const count = doc.assets.length;
    add(
      `<span>${count} embedded image${count === 1 ? "" : "s"} (${human(doc.assetBytesTotal)})</span>`
    );
    els.docMeta.innerHTML = bits.join("");
  }

  function escape(text) {
    return RKF.markdown.escapeHtml(text);
  }

  function renderDetails(doc) {
    const rows = [
      ["File", currentName],
      ["Title", doc.title],
      ["Spec version", doc.manifest.rkf_version],
      ["Generator", doc.manifest.generator || "–"],
      ["Authors", (doc.manifest.authors || []).join(", ") || "–"],
      ["Created", doc.manifest.created || "–"],
      ["Modified", doc.manifest.modified || "–"],
      ["File size", human(doc.fileSize)],
      ["Text", `${human(new TextEncoder().encode(doc.markdown).length)} (${doc.markdown.length} chars)`],
      ["Images", `${doc.assets.length}, ${human(doc.assetBytesTotal)} raw`],
      ["Images in file", human(doc.assetStoredTotal)],
      ["Container overhead", human(Math.max(0, doc.fileSize - doc.storedTotal))],
    ];
    els.detailsInfo.textContent = "";
    for (const [label, value] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      els.detailsInfo.append(dt, dd);
    }

    els.detailsAssets.textContent = "";
    if (!doc.assets.length) {
      els.detailsAssets.append(note("No embedded images."));
    }
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
      const check =
        asset.verified === true
          ? " · ✓ sha256"
          : asset.verified === false
            ? " · ✗ sha256"
            : "";
      detail.textContent =
        `${asset.media_type.replace("image/", "")} · ${human(asset.bytes)}${dims}${check}`;
      meta.append(name, detail);
      row.appendChild(meta);

      const save = document.createElement("a");
      save.className = "ghost small-btn";
      save.textContent = "Save";
      save.href = doc.assetUrl(asset) || "#";
      save.download = asset.path.split("/").pop();
      row.appendChild(save);

      els.detailsAssets.appendChild(row);
    }

    els.detailsProblems.textContent = "";
    if (!doc.problems.length) {
      els.detailsProblems.append(note("Valid — every image verified, no dangling references."));
    }
    for (const problem of doc.problems) {
      const row = document.createElement("div");
      row.className = `problem ${problem.severity}`;
      row.textContent = `${problem.severity}: ${problem.message}`;
      els.detailsProblems.appendChild(row);
    }
  }

  function note(text) {
    const div = document.createElement("div");
    div.className = "muted small";
    div.textContent = text;
    return div;
  }

  function show(doc) {
    current = doc;
    els.intro.hidden = true;
    els.reader.hidden = false;
    els.barActions.hidden = false;
    document.title = `${doc.title} — .rkf viewer`;

    els.page.innerHTML = RKF.markdown.render(doc.markdown, { resolveImage });
    els.source.textContent = doc.markdown;
    els.source.hidden = true;
    setPressed(els.actSource, false);
    renderMeta(doc);
    renderDetails(doc);

    const errors = doc.problems.filter((p) => p.severity === "error").length;
    if (errors) {
      status(
        `${errors} validation ${errors === 1 ? "problem" : "problems"} — open Details.`,
        "warn"
      );
    } else {
      status(null);
    }
    window.scrollTo(0, 0);
  }

  function close() {
    if (current) current.dispose();
    current = null;
    currentName = "";
    els.reader.hidden = true;
    els.details.hidden = true;
    els.barActions.hidden = true;
    els.intro.hidden = false;
    els.page.textContent = "";
    setPressed(els.actDetails, false);
    document.title = ".rkf viewer";
    status(null);
    if (location.search) history.replaceState(null, "", location.pathname);
  }

  function setPressed(button, pressed) {
    button.setAttribute("aria-pressed", String(pressed));
    button.classList.toggle("active", pressed);
  }

  // ----------------------------------------------------------------------- input

  async function openBuffer(buffer, name) {
    status("Reading…");
    if (current) current.dispose();
    currentName = name;
    try {
      const bytes = new Uint8Array(buffer);
      if (!RKF.looksLikeRkf(bytes)) {
        // Not fatal: the magic bytes are a convention, and a hand-built ZIP may lack them.
        // rkf.js records it as a warning and carries on if a manifest is present.
        status("This file does not carry the .rkf signature — trying anyway…");
      }
      const doc = await RKF.open(buffer);
      show(doc);
    } catch (err) {
      fail(err, name);
    }
  }

  function fail(err, name) {
    els.reader.hidden = true;
    els.intro.hidden = false;
    els.barActions.hidden = true;
    const message = err && err.message ? err.message : String(err);
    status(`Could not open ${name}: ${message}`, "error");
  }

  function openFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => openBuffer(reader.result, file.name);
    reader.onerror = () => status(`Could not read ${file.name}`, "error");
    reader.readAsArrayBuffer(file);
  }

  async function openUrl(raw, { updateHistory = true } = {}) {
    const url = normaliseUrl(raw);
    const name = nameFromUrl(url);
    status(`Fetching ${name}…`);
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) {
        throw new Error(`the server answered ${response.status} ${response.statusText}`);
      }
      const buffer = await response.arrayBuffer();
      if (updateHistory) {
        history.replaceState(null, "", `?url=${encodeURIComponent(raw)}`);
      }
      await openBuffer(buffer, name);
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      const looksLikeCors = /fetch|network|load failed|cors/i.test(detail);
      status(
        looksLikeCors
          ? `Could not fetch ${name}: ${detail}. The host has to allow cross-origin reads ` +
            "(raw.githubusercontent.com does). Otherwise download the file and drop it here."
          : `Could not fetch ${name}: ${detail}`,
        "error"
      );
    }
  }

  // --------------------------------------------------------------- HTML export

  async function exportHtml() {
    if (!current) return;
    status("Building HTML…");
    try {
      const dataUris = new Map();
      for (const asset of current.assets) {
        dataUris.set(asset.path, await current.assetDataUri(asset));
      }
      const body = RKF.markdown.render(current.markdown, {
        resolveImage(src) {
          const asset = current.resolve(src);
          if (!asset) return null;
          return { url: dataUris.get(asset.path), width: asset.width, height: asset.height };
        },
      });
      const css = await fetch("assets/document.css").then((r) => r.text());
      const title = escape(current.title);
      const html =
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n" +
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n" +
        `<title>${title}</title>\n<style>${css}</style>\n</head>\n<body>\n` +
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

  // ------------------------------------------------------------------- wiring

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

  els.actDemo.addEventListener("click", () => openUrl("welcome.rkf"));
  els.actClose.addEventListener("click", close);
  els.actExport.addEventListener("click", exportHtml);

  els.actSource.addEventListener("click", () => {
    const showSource = els.source.hidden;
    els.source.hidden = !showSource;
    els.page.hidden = showSource;
    setPressed(els.actSource, showSource);
  });

  els.actDetails.addEventListener("click", () => {
    const open = els.details.hidden;
    els.details.hidden = !open;
    setPressed(els.actDetails, open);
  });

  // Drag and drop anywhere on the page.
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
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    els.overlay.hidden = true;
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (file) openFile(file);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && current) close();
  });

  // Deep link: ?url=... (or #url=...), so a .rkf can be shared as a link.
  const params = new URLSearchParams(location.search || location.hash.replace(/^#/, "?"));
  const initial = params.get("url") || params.get("doc");
  if (initial) {
    openUrl(initial, { updateHistory: false });
  }
})();
