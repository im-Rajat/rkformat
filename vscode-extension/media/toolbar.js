/* GENERATED COPY - do not edit.
 *
 * Source of truth: docs/assets/toolbar.js. Re-run docs/build.py after changing
 * it, or the extension and the web editor will disagree.
 */
/**
 * The formatting toolbar, shared by the VS Code webview and the web editor.
 *
 * One definition means the two surfaces cannot drift apart on which actions exist or what
 * they are called - only the styling differs, since one lives in a VS Code theme and the
 * other on a web page. Loads as a <script> in the browser and as a require() in Node, which
 * is how the extension host builds its HTML.
 */

(function (global) {
  "use strict";

  /**
   * Inline SVG icons, so the toolbar stays compact without shipping an icon font.
   *
   * Text labels ("Insert image", "Clean up") read as heavy in a dense toolbar; single glyphs
   * for the letter-shaped formats (B, I, S, H1..H3) and icons for everything else matches how
   * word processors lay this out.
   */
  const ICONS = {
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h9a6 6 0 1 1 0 12h-4"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9h-9a6 6 0 1 0 0 12h4"/>',
    bullet: '<circle cx="4.5" cy="6.5" r="1.4"/><circle cx="4.5" cy="12" r="1.4"/><circle cx="4.5" cy="17.5" r="1.4"/><path d="M9 6.5h11M9 12h11M9 17.5h11"/>',
    ordered: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M3 4.5h1.5V9M3 9h3M3 14.5h2.5v2H3.5v2H6"/>',
    task: '<rect x="2.6" y="4.6" width="4.8" height="4.8" rx="1"/><path d="m3.4 7 1.3 1.3 2-2.4"/><rect x="2.6" y="14.6" width="4.8" height="4.8" rx="1"/><path d="M10 7h10M10 17h10"/>',
    outdent: '<path d="M10 6.5h10M10 12h10M10 17.5h10M4 6.5h3M4 17.5h3"/><path d="m7 12-3 2.5v-5z"/>',
    indent: '<path d="M10 6.5h10M10 12h10M10 17.5h10M4 6.5h3M4 17.5h3"/><path d="m4 12 3 2.5v-5z"/>',
    quote: '<path d="M8.5 7c-2 0-3.5 1.5-3.5 3.5S6.5 14 8.5 14c0 2-1.5 3-3 3.5"/><path d="M18 7c-2 0-3.5 1.5-3.5 3.5S16 14 18 14c0 2-1.5 3-3 3.5"/>',
    codeblock: '<rect x="2.8" y="4.5" width="18.4" height="15" rx="2"/><path d="m9.5 9.5-2 2.5 2 2.5M14.5 9.5l2 2.5-2 2.5"/>',
    table: '<rect x="2.8" y="4.5" width="18.4" height="15" rx="2"/><path d="M2.8 9.5h18.4M2.8 14.5h18.4M9 4.5v15M15 4.5v15"/>',
    rule: '<path d="M3 12h18"/><path d="M6 7.5h12M6 16.5h12" opacity=".35"/>',
    link: '<path d="M10 13a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 1 0-5.7-5.7L11.4 6"/><path d="M14 11a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7L12.6 18"/>',
    image: '<rect x="2.8" y="4.5" width="18.4" height="15" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="m3.5 17.5 5-4.5 4 3.5 3-2.5 5 4"/>',
    clear: '<path d="M6 18h12"/><path d="M9 15 19 5l-4-1-9 9z"/><path d="m13 6 4 4"/>',
    gallery: '<rect x="2.8" y="6.5" width="13" height="11" rx="1.8"/><path d="M18 8.5h3v9a2 2 0 0 1-2 2H8"/><path d="m4.5 15 3-2.5 2.5 2 2-1.5 2.5 2"/>',
    sweep: '<path d="M4 20l6-6"/><path d="m9 11 4 4 5.5-5.5a2.5 2.5 0 0 0 0-3.5l-.5-.5a2.5 2.5 0 0 0-3.5 0z"/>',
    page: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>',
    // Web-editor actions. The extension gets these from its host instead, but the icon set
    // is shared so both surfaces look the same where they do overlap.
    save: '<path d="M5 3.5h9l5 5v12a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 20.5v-15A1.5 1.5 0 0 1 5.5 4"/><path d="M8 3.5v6h6"/><rect x="8" y="14" width="8" height="6.5"/>',
    saveas: '<path d="M5 3.5h8l5 5v5"/><path d="M4 5.5v15A1.5 1.5 0 0 0 5.5 22h6"/><path d="M8 3.5v6h6"/><path d="m15 20 3-3 3 3m-3-3v6"/>',
    export: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9h17"/><path d="m10 13.5 2.5 2.5 4-4.5"/>',
    close: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
    share: '<path d="M4 12v7a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-7"/><path d="M12 15.5V3.5"/><path d="m8 7.5 4-4 4 4"/>',
    newfile: '<path d="M13 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V9.5z"/><path d="M13 3.5v6h6"/><path d="M12 12.5v5M9.5 15h5"/>',
  };

  function icon(name) {
    return (
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      ICONS[name] +
      "</svg>"
    );
  }

  /** Build one formatting button. `glyph` is used when a letter reads better than an icon. */
  function formatButton({ action, title, iconName, glyph, className }) {
    const label = iconName ? icon(iconName) : `<span class="glyph">${glyph}</span>`;
    const classes = ["fmt", className].filter(Boolean).join(" ");
    return `<button class="${classes}" data-format="${action}" title="${title}" aria-label="${title}">${label}</button>`;
  }

  const FORMAT_GROUPS = [
    [
      { action: "undo", title: "Undo (Ctrl+Z)", iconName: "undo" },
      { action: "redo", title: "Redo (Ctrl+Shift+Z)", iconName: "redo" },
    ],
    [
      { action: "bold", title: "Bold (Ctrl+B)", glyph: "B", className: "glyph-bold" },
      { action: "italic", title: "Italic (Ctrl+I)", glyph: "I", className: "glyph-italic" },
      { action: "strikethrough", title: "Strikethrough", glyph: "S", className: "glyph-strike" },
      { action: "code", title: "Inline code", glyph: "&lt;/&gt;", className: "glyph-code" },
    ],
    [
      { action: "h1", title: "Heading 1", glyph: "H1" },
      { action: "h2", title: "Heading 2", glyph: "H2" },
      { action: "h3", title: "Heading 3", glyph: "H3" },
      { action: "p", title: "Body text", glyph: "&para;" },
    ],
    [
      { action: "ul", title: "Bulleted list", iconName: "bullet" },
      { action: "ol", title: "Numbered list", iconName: "ordered" },
      { action: "task", title: "Task list", iconName: "task" },
      { action: "outdent", title: "Decrease indent", iconName: "outdent" },
      { action: "indent", title: "Increase indent", iconName: "indent" },
    ],
    [
      { action: "quote", title: "Block quote", iconName: "quote" },
      { action: "pre", title: "Code block", iconName: "codeblock" },
      { action: "table", title: "Insert table", iconName: "table" },
      { action: "hr", title: "Horizontal rule", iconName: "rule" },
    ],
    [
      { action: "link", title: "Insert link (Ctrl+K)", iconName: "link" },
      { action: "image", title: "Insert image", iconName: "image" },
    ],
    [{ action: "clearFormat", title: "Clear formatting", iconName: "clear" }],
  ];

  function formatBarHtml() {
    return FORMAT_GROUPS.map((group) => group.map(formatButton).join("")).join(
      '<span class="sep"></span>'
    );
  }

  global.RKF = Object.assign(global.RKF || {}, {
    toolbar: { ICONS, icon, formatButton, FORMAT_GROUPS, formatBarHtml },
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
