/**
 * RK Document — VS Code custom editor for the .rkf compound format.
 *
 * The extension host owns no format logic: every read, write and render is delegated to
 * the `rk` CLI so the editor and the command line can never disagree about what a
 * document means. Plain JavaScript, no dependencies, no build step.
 */

"use strict";

const vscode = require("vscode");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");

const VIEW_TYPE = "rkformat.editor";

// --------------------------------------------------------------------- rk bridge

function settings() {
  return vscode.workspace.getConfiguration("rkformat");
}

/**
 * Candidate ways to reach the CLI, best first.
 *
 * An explicit `rkformat.command` is honoured alone — if someone names an interpreter, a
 * silent fallback to a different one would be worse than a clear failure. Otherwise we
 * probe, because a `uv`/`pipx` install lands in ~/.local/bin, which VS Code often does not
 * inherit on its PATH, while a working copy may not be installed at all.
 */
function argvCandidates() {
  const inspected = settings().inspect("command") || {};
  const explicit =
    inspected.globalValue ||
    inspected.workspaceValue ||
    inspected.workspaceFolderValue;
  if (Array.isArray(explicit) && explicit.length) return [explicit.slice()];
  return [
    ["rk"],
    [path.join(os.homedir(), ".local", "bin", "rk")],
    ["python3", "-m", "rkformat"],
    ["python", "-m", "rkformat"],
  ];
}

let resolvedArgv = null;

/** Probe the candidates once with `--version` and remember the one that answers. */
async function resolveArgv() {
  if (resolvedArgv) return resolvedArgv;
  const tried = [];
  for (const candidate of argvCandidates()) {
    try {
      await exec(candidate.concat(["--version"]), {});
      resolvedArgv = candidate;
      return resolvedArgv;
    } catch (err) {
      tried.push(`${candidate.join(" ")} (${String(err.message).split("\n")[0]})`);
    }
  }
  throw new Error(
    `cannot find the rk CLI. Tried: ${tried.join("; ")}. ` +
      `Install it with \`uv tool install --editable .\` in the rkformat repo, ` +
      `or set "rkformat.command" to a working invocation.`
  );
}

/** Raw-HTML policy for renders, validated so a stale setting cannot break the CLI call. */
function htmlMode() {
  const mode = settings().get("html");
  return ["sanitize", "escape", "raw"].includes(mode) ? mode : "sanitize";
}

function childEnv() {
  const env = Object.assign({}, process.env);
  const extra = settings().get("extraPythonPath");
  if (extra) {
    env.PYTHONPATH = env.PYTHONPATH ? `${extra}${path.delimiter}${env.PYTHONPATH}` : extra;
  }
  return env;
}

/** Run the rk CLI, resolving how to invoke it on first use. */
async function rk(args, options = {}) {
  const argv = (await resolveArgv()).concat(args);
  return exec(argv, options);
}

/** Spawn an explicit argv. Resolves with stdout; rejects with stderr on a non-zero exit. */
function exec(argv, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        env: childEnv(),
        cwd: options.cwd,
      });
    } catch (err) {
      reject(new Error(`cannot run ${argv[0]}: ${err.message}`));
      return;
    }
    const out = [];
    const errOut = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => errOut.push(chunk));
    child.on("error", (err) => reject(new Error(`cannot run ${argv[0]}: ${err.message}`)));
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(errOut).toString("utf8").trim();
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `${argv.join(" ")} exited with code ${code}`));
      }
    });
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

async function rkJson(args, payload) {
  const stdout = await rk(args, payload === undefined ? {} : { stdin: JSON.stringify(payload) });
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`rk ${args[0]} returned unparseable output: ${stdout.slice(0, 400)}`);
  }
}

// ------------------------------------------------------------------- the document

class RkfDocument {
  constructor(uri, snapshot) {
    this.uri = uri;
    this.markdown = snapshot.markdown;
    this.savedMarkdown = snapshot.markdown;
    this.snapshot = snapshot;
    this._onDidDispose = new vscode.EventEmitter();
    this.onDidDispose = this._onDidDispose.event;
  }

  get isDirty() {
    return this.markdown !== this.savedMarkdown;
  }

  dispose() {
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
  }
}

class RkfEditorProvider {
  constructor(context) {
    this.context = context;
    this.panels = new Map(); // fsPath -> Set<WebviewPanel>
    this._onDidChangeCustomDocument = new vscode.EventEmitter();
    this.onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;
  }

  // ---------------------------------------------------------------- lifecycle

  async openCustomDocument(uri, openContext) {
    const source = openContext.backupId ? vscode.Uri.parse(openContext.backupId) : uri;
    const snapshot = await rkJson(["export-json", source.fsPath, "--html", htmlMode()]);
    const document = new RkfDocument(uri, snapshot);
    if (openContext.backupId) {
      // Restoring after a crash: the backup holds the unsaved body.
      document.savedMarkdown = null;
      this._onDidChangeCustomDocument.fire({ document });
    }
    return document;
  }

  async resolveCustomEditor(document, panel) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    panel.webview.html = await this.buildHtml(panel.webview);

    const key = document.uri.fsPath;
    if (!this.panels.has(key)) this.panels.set(key, new Set());
    this.panels.get(key).add(panel);
    panel.onDidDispose(() => {
      const set = this.panels.get(key);
      if (set) {
        set.delete(panel);
        if (!set.size) this.panels.delete(key);
      }
    });

    panel.webview.onDidReceiveMessage((message) =>
      this.handleMessage(document, panel, message).catch((err) =>
        this.fail(panel, err)
      )
    );
  }

  async buildHtml(webview) {
    const media = (name) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", name));
    let documentCss = "";
    try {
      documentCss = await rk(["css"]);
    } catch (err) {
      documentCss = `/* rk css unavailable: ${String(err.message).replace(/\*\//g, "")} */`;
    }
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media("editor.css")}">
<style>${documentCss}</style>
</head>
<body class="rkf-editor">
  <header id="toolbar">
    <div class="group" role="group" aria-label="Layout">
      <button data-layout="live" title="Type directly into the page (WYSIWYG)">Live</button>
      <button data-layout="source" title="Markdown source only">Source</button>
      <button data-layout="split" title="Source and preview">Split</button>
      <button data-layout="preview" title="Rendered page only">Preview</button>
    </div>
    <div class="group">
      <button id="insert-image" title="Embed an image file">Insert image</button>
      <button id="toggle-assets" title="Show embedded images">Images</button>
      <button id="cleanup" title="Delete images the body no longer references">Clean up</button>
    </div>
    <div class="spacer"></div>
    <div id="status" aria-live="polite"></div>
  </header>
  <div id="format-bar" role="toolbar" aria-label="Formatting" hidden>
    <button data-format="bold" title="Bold (Ctrl+B)"><b>B</b></button>
    <button data-format="italic" title="Italic (Ctrl+I)"><i>I</i></button>
    <button data-format="strikethrough" title="Strikethrough"><s>S</s></button>
    <button data-format="code" title="Inline code">&lt;/&gt;</button>
    <span class="sep"></span>
    <button data-format="h1" title="Heading 1">H1</button>
    <button data-format="h2" title="Heading 2">H2</button>
    <button data-format="h3" title="Heading 3">H3</button>
    <button data-format="p" title="Body text">&para;</button>
    <span class="sep"></span>
    <button data-format="ul" title="Bulleted list">&bull; List</button>
    <button data-format="ol" title="Numbered list">1. List</button>
    <button data-format="quote" title="Block quote">&ldquo;</button>
    <button data-format="pre" title="Code block">Code</button>
    <span class="sep"></span>
    <button data-format="link" title="Insert link (Ctrl+K)">Link</button>
    <button data-format="table" title="Insert a 3-column table">Table</button>
    <button data-format="hr" title="Horizontal rule">&mdash;</button>
  </div>
  <main id="panes">
    <section id="live-pane">
      <div id="live" class="rkf-page" contenteditable="true" spellcheck="true"
           role="textbox" aria-multiline="true" aria-label="Document"></div>
    </section>
    <section id="source-pane">
      <textarea id="source" spellcheck="true" aria-label="Markdown source"
        placeholder="Write Markdown. Paste or drop an image to embed it in this file."></textarea>
    </section>
    <div id="divider" role="separator" aria-orientation="vertical"></div>
    <section id="preview-pane"><div id="preview" class="rkf-page"></div></section>
  </main>
  <aside id="assets" hidden><div id="asset-list"></div></aside>
  <footer id="problems" hidden></footer>
  <script nonce="${nonce}" src="${media("tomarkdown.js")}"></script>
  <script nonce="${nonce}" src="${media("editor.js")}"></script>
</body>
</html>`;
  }

  // ------------------------------------------------------------------ messaging

  post(document, message) {
    const set = this.panels.get(document.uri.fsPath);
    if (set) for (const panel of set) panel.webview.postMessage(message);
  }

  fail(panel, err) {
    const text = err && err.message ? err.message : String(err);
    panel.webview.postMessage({ type: "error", message: text });
    vscode.window.showErrorMessage(`RK Document: ${text}`);
  }

  async handleMessage(document, panel, message) {
    switch (message.type) {
      case "ready":
        panel.webview.postMessage({
          type: "init",
          markdown: document.markdown,
          html: document.snapshot.html,
          title: document.snapshot.title,
          assets: document.snapshot.assets,
          problems: document.snapshot.problems,
          layout: settings().get("defaultLayout"),
          debounceMs: settings().get("previewDebounceMs"),
        });
        return;

      case "change":
        document.markdown = message.markdown;
        this._onDidChangeCustomDocument.fire({ document });
        return;

      case "requestPreview": {
        const result = await rkJson(
          ["preview", document.uri.fsPath, "--html", htmlMode()],
          { markdown: message.markdown }
        );
        panel.webview.postMessage({
          type: "preview",
          seq: message.seq,
          forLive: Boolean(message.forLive),
          html: result.html,
          problems: result.problems,
          assets: result.assets,
        });
        return;
      }

      case "pickImage": {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: "Embed",
          filters: { Images: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic"] },
        });
        if (!picked || !picked.length) return;
        const images = [];
        for (const file of picked) {
          const bytes = await vscode.workspace.fs.readFile(file);
          images.push({
            filename: path.basename(file.fsPath),
            data_base64: Buffer.from(bytes).toString("base64"),
          });
        }
        await this.embed(document, panel, images);
        return;
      }

      case "pasteImage":
        await this.embed(document, panel, [
          { filename: message.filename || "pasted.png", data_base64: message.data_base64 },
        ]);
        return;

      case "removeAsset":
        await rkJson(["import-json", document.uri.fsPath], {
          markdown: document.markdown,
          remove_assets: [message.ref],
          prune_refs: true,
        });
        await this.refresh(document);
        return;

      case "cleanup": {
        const before = document.snapshot.assets.length;
        await rk(["gc", document.uri.fsPath]);
        await this.refresh(document);
        const after = document.snapshot.assets.length;
        vscode.window.showInformationMessage(
          before === after
            ? "RK Document: every embedded image is referenced."
            : `RK Document: removed ${before - after} unreferenced image(s).`
        );
        return;
      }

      case "save":
        await vscode.commands.executeCommand("workbench.action.files.save");
        return;
    }
  }

  /**
   * Embed images and hand the editor the Markdown to insert.
   *
   * Images are committed to the file immediately rather than held as pending state: the
   * CLI allocates the asset path (and de-duplicates identical bytes), so the reference we
   * insert has to come from it. Unused images are cheap to sweep later with `rk gc`.
   */
  async embed(document, panel, images) {
    const result = await rkJson(["import-json", document.uri.fsPath], {
      markdown: document.markdown,
      add_images: images,
    });
    document.savedMarkdown = document.markdown; // the body on disk now matches
    await this.refresh(document);
    panel.webview.postMessage({
      type: "insert",
      text: result.added.map((asset) => asset.markdown).join("\n\n"),
      assets: document.snapshot.assets,
    });
  }

  /** Re-read the document from disk, keeping the in-editor body. */
  async refresh(document) {
    const snapshot = await rkJson(["export-json", document.uri.fsPath]);
    document.snapshot = snapshot;
    this.post(document, {
      type: "assets",
      assets: snapshot.assets,
      problems: snapshot.problems,
    });
  }

  // --------------------------------------------------------------- save / revert

  async saveCustomDocument(document) {
    await rkJson(["import-json", document.uri.fsPath], { markdown: document.markdown });
    document.savedMarkdown = document.markdown;
    await this.refresh(document);
    if (this.textProvider) this.textProvider.refresh(document.uri);
  }

  async saveCustomDocumentAs(document, destination) {
    // Copy first, then write into the copy, so Save As never touches the original.
    await vscode.workspace.fs.copy(document.uri, destination, { overwrite: true });
    await rkJson(["import-json", destination.fsPath], { markdown: document.markdown });
  }

  async revertCustomDocument(document) {
    const snapshot = await rkJson(["export-json", document.uri.fsPath]);
    document.snapshot = snapshot;
    document.markdown = snapshot.markdown;
    document.savedMarkdown = snapshot.markdown;
    this.post(document, {
      type: "init",
      markdown: snapshot.markdown,
      html: snapshot.html,
      title: snapshot.title,
      assets: snapshot.assets,
      problems: snapshot.problems,
      layout: settings().get("defaultLayout"),
      debounceMs: settings().get("previewDebounceMs"),
    });
  }

  async backupCustomDocument(document, context) {
    const destination = context.destination;
    await vscode.workspace.fs.copy(document.uri, destination, { overwrite: true });
    await rkJson(["import-json", destination.fsPath], { markdown: document.markdown });
    return {
      id: destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(destination);
        } catch (err) {
          /* the backup is already gone; nothing to do */
        }
      },
    };
  }
}

// ---------------------------------------------------------------------- commands

async function commandNew() {
  const target = await vscode.window.showSaveDialog({
    filters: { "RK Document": ["rkf"] },
    saveLabel: "Create",
  });
  if (!target) return;
  const title = await vscode.window.showInputBox({
    prompt: "Document title",
    value: path.basename(target.fsPath, path.extname(target.fsPath)),
  });
  await rk(["new", target.fsPath, "--force"].concat(title ? ["--title", title] : []));
  await vscode.commands.executeCommand("vscode.openWith", target, VIEW_TYPE);
}

function activeRkfUri() {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  if (input && input.uri && /\.(rkf|rk)$/i.test(input.uri.fsPath)) return input.uri;
  return undefined;
}

async function pickRkf(uri) {
  if (uri) return uri;
  const active = activeRkfUri();
  if (active) return active;
  const picked = await vscode.window.showOpenDialog({
    filters: { "RK Document": ["rkf", "rk"] },
    canSelectMany: false,
  });
  return picked && picked[0];
}

async function commandRender(uri) {
  const source = await pickRkf(uri);
  if (!source) return;
  const target = source.with({ path: source.path.replace(/\.(rkf|rk)$/i, ".html") });
  await rk(["render", source.fsPath, "-o", target.fsPath]);
  const choice = await vscode.window.showInformationMessage(
    `Exported ${path.basename(target.fsPath)} — self-contained, images inlined.`,
    "Open in browser",
    "Reveal"
  );
  if (choice === "Open in browser") await vscode.env.openExternal(target);
  if (choice === "Reveal") await vscode.commands.executeCommand("revealFileInOS", target);
}

async function commandUnpack(uri) {
  const source = await pickRkf(uri);
  if (!source) return;
  const target = source.with({ path: source.path.replace(/\.(rkf|rk)$/i, "") });
  await rk(["unpack", source.fsPath, "-d", target.fsPath, "--force"]);
  vscode.window.showInformationMessage(
    `Unpacked into ${path.basename(target.fsPath)}/ — plain Markdown plus assets/.`
  );
}

async function commandPack(uri) {
  let source = uri;
  if (!source) {
    const editor = vscode.window.activeTextEditor;
    source = editor && editor.document.uri;
  }
  if (!source) {
    vscode.window.showWarningMessage("RK Document: open or select a Markdown file first.");
    return;
  }
  const target = source.with({ path: source.path.replace(/\.(md|markdown|txt)$/i, "") + ".rkf" });
  const output = await rk(["pack", source.fsPath, "-o", target.fsPath, "--force"]);
  vscode.window.showInformationMessage(`RK Document: ${output.trim()}`);
  await vscode.commands.executeCommand("vscode.openWith", target, VIEW_TYPE);
}

async function commandCheck(uri) {
  const source = await pickRkf(uri);
  if (!source) return;
  let problems;
  try {
    problems = await rkJson(["check", source.fsPath, "--json"]);
  } catch (err) {
    vscode.window.showErrorMessage(`RK Document: ${err.message}`);
    return;
  }
  const errors = problems.filter((p) => p.severity === "error");
  if (!errors.length) {
    vscode.window.showInformationMessage(
      `RK Document: ${path.basename(source.fsPath)} is valid (${problems.length} note(s)).`
    );
    return;
  }
  const channel = vscode.window.createOutputChannel("RK Document");
  channel.clear();
  for (const problem of problems) channel.appendLine(`${problem.severity}: ${problem.message}`);
  channel.show(true);
}

async function commandGc(uri) {
  const source = await pickRkf(uri);
  if (!source) return;
  const output = await rk(["gc", source.fsPath]);
  vscode.window.showInformationMessage(`RK Document: ${output.trim().split("\n").pop()}`);
}

// ------------------------------------------------------- plain-text Markdown view

const TEXT_SCHEME = "rkf-md";

/**
 * Exposes a document's Markdown body as a read-only text editor.
 *
 * A .rkf is a ZIP, so opening it with the built-in text editor shows binary. This serves
 * the body as a virtual `.md` document instead, which gives syntax highlighting, find,
 * outline and copy-paste for free. Read-only on purpose: edits belong in the .rkf editor,
 * which knows how to write the container back.
 */
class MarkdownTextProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }

  /** rkf-md:/<name>.md?<absolute path of the .rkf> */
  static uriFor(source) {
    const name = path.basename(source.fsPath).replace(/\.(rkf|rk)$/i, "");
    return vscode.Uri.parse(
      `${TEXT_SCHEME}:/${encodeURIComponent(name)}.md?${encodeURIComponent(source.fsPath)}`
    );
  }

  refresh(source) {
    this._onDidChange.fire(MarkdownTextProvider.uriFor(source));
  }

  async provideTextDocumentContent(uri) {
    const target = decodeURIComponent(uri.query);
    try {
      return await rk(["cat", target]);
    } catch (err) {
      return `Could not read ${target}\n\n${err.message}\n`;
    }
  }
}

async function commandOpenAsText(uri) {
  const source = await pickRkf(uri);
  if (!source) return;
  const document = await vscode.workspace.openTextDocument(MarkdownTextProvider.uriFor(source));
  await vscode.languages.setTextDocumentLanguage(document, "markdown");
  await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

function activate(context) {
  const provider = new RkfEditorProvider(context);
  const textProvider = new MarkdownTextProvider();
  provider.textProvider = textProvider;
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(TEXT_SCHEME, textProvider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("rkformat.command")) resolvedArgv = null;
    }),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: false,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("rkformat.new", () => guard(commandNew())),
    vscode.commands.registerCommand("rkformat.render", (uri) => guard(commandRender(uri))),
    vscode.commands.registerCommand("rkformat.unpack", (uri) => guard(commandUnpack(uri))),
    vscode.commands.registerCommand("rkformat.pack", (uri) => guard(commandPack(uri))),
    vscode.commands.registerCommand("rkformat.check", (uri) => guard(commandCheck(uri))),
    vscode.commands.registerCommand("rkformat.gc", (uri) => guard(commandGc(uri))),
    vscode.commands.registerCommand("rkformat.openAsText", (uri) => guard(commandOpenAsText(uri))),
    vscode.commands.registerCommand("rkformat.toggleLive", () => {
      const uri = activeRkfUri();
      const panels = uri && provider.panels.get(uri.fsPath);
      if (!panels || !panels.size) {
        vscode.window.showWarningMessage("RK Document: focus an .rkf editor first.");
        return;
      }
      for (const panel of panels) panel.webview.postMessage({ type: "setLayout", layout: "live" });
    }),
    vscode.commands.registerCommand("rkformat.insertImage", () => {
      const uri = activeRkfUri();
      const panels = uri && provider.panels.get(uri.fsPath);
      if (!panels || !panels.size) {
        vscode.window.showWarningMessage("RK Document: focus an .rkf editor first.");
        return;
      }
      for (const panel of panels) panel.webview.postMessage({ type: "pickImage" });
    })
  );
}

function guard(promise) {
  return Promise.resolve(promise).catch((err) =>
    vscode.window.showErrorMessage(`RK Document: ${err.message}`)
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
