/**
 * Host-side tests for the VS Code extension's undo/redo stack.
 *
 *     node tests/test_extension_undo.js
 *
 * The extension can't be loaded inside VS Code from a test, so this stubs the `vscode`
 * module and drives `RkfEditorProvider` directly. The point of interest is the shape of the
 * event handed to `onDidChangeCustomDocument`:
 *
 *   {document}                      -> "changed, not undoable". VS Code marks the file dirty
 *                                      and DISABLES undo, while still capturing Ctrl+Z - so
 *                                      the keystroke silently does nothing.
 *   {document, undo, redo, label}   -> a real edit stack; Ctrl+Z works.
 *
 * The first form is why Ctrl+Z appeared broken, so these tests pin the second down.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const root = path.resolve(__dirname, "..");

// ------------------------------------------------------------------ vscode stub

class StubEventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
  }
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {}
}

const settings = {
  command: ["python3", "-m", "rkformat"],
  html: "sanitize",
  extraPythonPath: "",
  defaultLayout: "split",
  previewDebounceMs: 250,
};

const vscodeStub = {
  EventEmitter: StubEventEmitter,
  Uri: {
    joinPath: (...parts) => ({ fsPath: parts.join("/"), toString: () => parts.join("/") }),
    parse: (value) => ({ fsPath: value, query: "", toString: () => value }),
  },
  ViewColumn: { Beside: 2 },
  workspace: {
    getConfiguration: () => ({
      get: (key) => settings[key],
      inspect: () => ({}),
    }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
    openTextDocument: async () => ({}),
    fs: { copy: async () => {}, delete: async () => {}, readFile: async () => new Uint8Array() },
  },
  window: {
    registerCustomEditorProvider: () => ({ dispose: () => {} }),
    showErrorMessage: () => {},
    showWarningMessage: () => {},
    showInformationMessage: () => {},
    showOpenDialog: async () => undefined,
    showSaveDialog: async () => undefined,
    showInputBox: async () => undefined,
    showTextDocument: async () => {},
    createOutputChannel: () => ({ clear() {}, appendLine() {}, show() {} }),
    tabGroups: { activeTabGroup: {} },
  },
  languages: { setTextDocumentLanguage: async () => {} },
  commands: { registerCommand: () => ({ dispose: () => {} }), executeCommand: async () => {} },
  env: { openExternal: async () => {} },
};

// Make `require("vscode")` resolve to the stub, and expose the module internals.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  return originalLoad(request, parent, isMain);
};

const source = fs.readFileSync(path.join(root, "vscode-extension/extension.js"), "utf8");
const probe = path.join(os.tmpdir(), `rkf-extension-probe-${process.pid}.js`);
fs.writeFileSync(
  probe,
  `${source}\nmodule.exports.__test = { RkfEditorProvider, RkfDocument };\n`
);
const { RkfEditorProvider, RkfDocument } = require(probe).__test;
fs.unlinkSync(probe);

// ---------------------------------------------------------------------- harness

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : `  :: ${JSON.stringify(detail)}`}`);
  }
}

function makeProvider() {
  const provider = new RkfEditorProvider({
    extensionUri: { fsPath: root },
    subscriptions: [],
  });
  const events = [];
  provider.onDidChangeCustomDocument((event) => events.push(event));

  // Stand in for a live webview panel so posted messages can be inspected.
  const posted = [];
  const uri = { fsPath: "/tmp/doc.rkf", toString: () => "/tmp/doc.rkf" };
  provider.panels.set(uri.fsPath, new Set([{ webview: { postMessage: (m) => posted.push(m) } }]));

  const document = new RkfDocument(uri, { markdown: "start" });
  return { provider, document, events, posted };
}

// ------------------------------------------------------------------------ tests

console.log("--- edit events ---");
{
  const { provider, document, events } = makeProvider();
  provider.applyEdit(document, "start typed", "Typing");
  check("an edit fires exactly one event", events.length === 1, events.length);
  const event = events[0] || {};
  check("the event carries the document", event.document === document);
  check("the event supplies undo", typeof event.undo === "function", typeof event.undo);
  check("the event supplies redo", typeof event.redo === "function", typeof event.redo);
  check("the event carries a label", event.label === "Typing", event.label);
  check("the body was updated", document.markdown === "start typed", document.markdown);
}

console.log("--- undo and redo ---");
{
  const { provider, document, events, posted } = makeProvider();
  provider.applyEdit(document, "one");
  provider.applyEdit(document, "one two");
  provider.applyEdit(document, "one two three");
  check("three edits, three events", events.length === 3, events.length);

  events[2].undo();
  check("undo steps back one edit", document.markdown === "one two", document.markdown);
  events[1].undo();
  check("undo steps back again", document.markdown === "one", document.markdown);
  events[1].redo();
  check("redo steps forward", document.markdown === "one two", document.markdown);
  events[2].redo();
  check("redo reaches the newest state", document.markdown === "one two three", document.markdown);

  const restores = posted.filter((message) => message.type === "restore");
  check("every undo/redo told the webview", restores.length === 4, restores.length);
  check(
    "the restore carries the body to show",
    restores[0].markdown === "one two",
    restores[0].markdown
  );
}

console.log("--- edits that change nothing ---");
{
  const { provider, document, events } = makeProvider();
  provider.applyEdit(document, "start");
  check("an identical body is not an edit", events.length === 0, events.length);
  provider.applyEdit(document, "changed");
  provider.applyEdit(document, "changed");
  check("only the real change was recorded", events.length === 1, events.length);
}

console.log("--- undoing back to the original ---");
{
  const { provider, document, events } = makeProvider();
  provider.applyEdit(document, "edited");
  events[0].undo();
  check("the original body comes back", document.markdown === "start", document.markdown);
  check("dirty tracking clears", document.isDirty === false, document.isDirty);
}

console.log("--- save marks a clean point ---");
{
  const { provider, document } = makeProvider();
  provider.applyEdit(document, "edited");
  check("the document is dirty after an edit", document.isDirty === true);
  document.savedMarkdown = document.markdown;
  check("saving clears dirty", document.isDirty === false);
}

console.log(`\n${failures === 0 ? "all" : failures} undo/redo check(s) ${failures ? "FAILED" : "passed"}`);
process.exit(failures ? 1 : 0);
