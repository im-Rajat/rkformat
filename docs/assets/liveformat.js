/**
 * Formatting actions for Live (WYSIWYG) mode, shared by the VS Code webview and the web editor.
 *
 * toolbar.js decides which buttons exist; this decides what they do to the editable page.
 * Both hosts used to carry their own copy, which is exactly where the two could drift without
 * any test noticing. What genuinely differs stays with the host: undo/redo (VS Code owns the
 * stack in the extension, the page owns it on the web), picking an image, and turning the
 * edited page back into Markdown afterwards.
 *
 * Every function takes the editable root, so nothing here reaches for a global element.
 */

(function (global) {
  "use strict";

  const FORMAT_BLOCKS = { h1: "H1", h2: "H2", h3: "H3", p: "P", quote: "BLOCKQUOTE", pre: "PRE" };

  // Actions that map straight onto an execCommand verb.
  const EXEC_COMMANDS = {
    bold: "bold",
    italic: "italic",
    indent: "indent",
    outdent: "outdent",
    strikethrough: "strikeThrough",
    clearFormat: "removeFormat",
    ul: "insertUnorderedList",
    ol: "insertOrderedList",
  };

  const TABLE_HTML =
    "<table><thead><tr><th>Column</th><th>Column</th><th>Column</th></tr></thead>" +
    "<tbody><tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table>";

  /** The nearest ancestor of the caret matching `selector`, within the editable page. */
  function closest(root, selector) {
    const selection = window.getSelection();
    if (!selection || !selection.anchorNode) return null;
    const anchor = selection.anchorNode;
    const start = anchor.nodeType === 1 ? anchor : anchor.parentElement;
    if (!start || !root.contains(start)) return null;
    return start.closest(selector);
  }

  /** Wrap the selection in an element, for formats execCommand has no verb for. */
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
      /* selection spanned incompatible blocks; leave it alone */
    }
  }

  function taskCheckbox() {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.setAttribute("contenteditable", "false");
    return box;
  }

  /**
   * Turn the block at the caret into a task item, or back into a plain one.
   *
   * Done by moving nodes rather than with execCommand: asking the browser to make a list out
   * of a heading nests the <ul> *inside* the <h2>, which the serialiser then flattens back to
   * a heading - silently losing the checkbox. Chaining formatBlock first does not help, since
   * the selection does not survive it reliably.
   */
  function toggleTask(root) {
    const item = closest(root, "li");
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
        host.insertBefore(taskCheckbox(), host.firstChild);
      }
      return;
    }

    const block = closest(root, "p, h1, h2, h3, h4, h5, h6, blockquote") || root.lastElementChild;
    if (!block || !root.contains(block)) return;
    const list = document.createElement("ul");
    const listItem = document.createElement("li");
    listItem.className = "rkf-task";
    listItem.appendChild(taskCheckbox());
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

  /**
   * Apply a toolbar action to the editable page.
   *
   * Covers every action except undo, redo and image, which the host handles itself. The
   * caller re-serialises the page afterwards.
   */
  function apply(root, action) {
    root.focus();
    if (EXEC_COMMANDS[action]) {
      document.execCommand(EXEC_COMMANDS[action], false, null);
      return;
    }
    switch (action) {
      case "code":
        wrapSelection("code");
        break;
      case "task":
        toggleTask(root);
        break;
      case "hr":
        document.execCommand("insertHTML", false, "<hr>");
        break;
      case "table":
        document.execCommand("insertHTML", false, TABLE_HTML);
        break;
      case "link": {
        const url = window.prompt("Link URL");
        if (url) document.execCommand("createLink", false, url);
        break;
      }
      default:
        if (FORMAT_BLOCKS[action]) {
          document.execCommand("formatBlock", false, FORMAT_BLOCKS[action]);
        }
    }
  }

  /**
   * Insert an embedded image at the caret, as a real element.
   *
   * `data-rkf-src` carries the archive path, so the serialiser writes `assets/x.png` rather
   * than the data or blob URL the page displays. `data-rkf-md` marks it as Markdown image
   * syntax rather than author HTML.
   */
  function insertImage(root, { src, alt, path, width, height }) {
    const img = document.createElement("img");
    img.src = src || "";
    img.alt = alt || "";
    img.className = "rkf-image";
    img.setAttribute("data-rkf-src", path);
    img.setAttribute("data-rkf-md", "1");
    if (width && height) {
      img.width = width;
      img.height = height;
    }
    const selection = window.getSelection();
    const caretInPage = selection && selection.rangeCount && root.contains(selection.anchorNode);
    if (!caretInPage) {
      root.appendChild(img);
      return;
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(img);
    range.setStartAfter(img);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /**
   * Make the rendered checkboxes clickable.
   *
   * The renderers emit them `disabled`, which is right for a read-only page or an exported
   * HTML file, but in live editing a checkbox you cannot tick is useless. `contenteditable`
   * is turned off on them so the caret does not land inside.
   */
  function enableCheckboxes(root) {
    for (const box of root.querySelectorAll('input[type="checkbox"]')) {
      box.disabled = false;
      box.setAttribute("contenteditable", "false");
    }
  }

  global.RKF = Object.assign(global.RKF || {}, {
    liveFormat: { apply, insertImage, enableCheckboxes },
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
