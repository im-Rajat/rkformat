/**
 * HTML -> Markdown, for WYSIWYG editing.
 *
 * Live editing means the user types into rendered HTML, so every keystroke has to be turned
 * back into Markdown. That direction is inherently lossy - many HTML shapes have no Markdown
 * spelling - so the rule here is: **emit Markdown when Markdown can express it exactly, and
 * fall back to verbatim HTML when it cannot.** Nothing is silently discarded.
 *
 * That is why the renderers tag images with `data-rkf-src` (the original reference, since the
 * displayed `src` is a data: or blob: URL) and `data-rkf-md` (it came from `![...](...)`
 * rather than an author-written `<img>`). Without the second marker, round-tripping
 * `<img src="assets/x.png" width="200">` would quietly lose the width.
 *
 * The invariant worth testing is not `toMarkdown(render(md)) === md` - that is false for
 * harmless reasons like `*x*` versus `_x_`. It is that rendering is **stable**:
 *
 *     render(toMarkdown(render(md))) === render(md)
 *
 * so a WYSIWYG edit never degrades the document. `tests/test_wysiwyg_roundtrip.html` checks it.
 */

(function (global) {
  "use strict";

  // Attributes the renderers add. They must not leak back into the Markdown.
  const INJECTED_ATTRIBUTES = new Set([
    "data-rkf-src", "data-rkf-md", "data-rkf-dangling", "loading",
  ]);

  const BLOCK_TAGS = new Set([
    "address", "article", "aside", "blockquote", "details", "div", "dl", "figure",
    "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol",
    "p", "pre", "section", "table", "ul",
  ]);

  // Inline elements Markdown has no syntax for: kept as HTML so nothing is lost.
  const KEEP_INLINE = new Set([
    "abbr", "bdi", "bdo", "cite", "dfn", "ins", "kbd", "mark", "q", "rp", "rt", "ruby",
    "samp", "small", "sub", "sup", "time", "u", "var", "wbr",
  ]);

  const VOID_TAGS = new Set(["br", "col", "hr", "img", "wbr"]);

  function tag(node) {
    return node.nodeName.toLowerCase();
  }

  /** Rebuild an element as HTML, dropping renderer-injected attributes. */
  function verbatim(node, inner) {
    const name = tag(node);
    const parts = [name];
    for (const attribute of Array.from(node.attributes || [])) {
      const attrName = attribute.name.toLowerCase();
      if (INJECTED_ATTRIBUTES.has(attrName)) continue;
      if (attrName === "src") {
        // The live DOM holds a data:/blob: URL; write the archive path instead.
        const original = node.getAttribute("data-rkf-src");
        parts.push(`src="${escapeAttribute(original || attribute.value)}"`);
        continue;
      }
      if (attrName === "class") {
        const kept = attribute.value
          .split(/\s+/)
          .filter((cls) => cls && !cls.startsWith("rkf-"));
        if (!kept.length) continue;
        parts.push(`class="${escapeAttribute(kept.join(" "))}"`);
        continue;
      }
      parts.push(`${attrName}="${escapeAttribute(attribute.value)}"`);
    }
    const open = `<${parts.join(" ")}`;
    if (VOID_TAGS.has(name)) return `${open} />`;
    return `${open}>${inner}</${name}>`;
  }

  function escapeAttribute(value) {
    return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  /**
   * Escape characters that would otherwise be read as Markdown syntax.
   *
   * Kept deliberately light: over-escaping produces noisy source. Underscores between word
   * characters are left alone, since intraword emphasis is not recognised anyway.
   */
  function escapeText(text) {
    return text
      .replace(/([\\`*\[\]])/g, "\\$1")
      .replace(/(^|\s)_/g, "$1\\_")
      .replace(/_(\s|$)/g, "\\_$1")
      .replace(/^(\s*)([-+>])(\s)/gm, "$1\\$2$3")
      .replace(/^(\s*)(#{1,6})(\s)/gm, "$1\\$2$3")
      .replace(/^(\s*\d+)\.(\s)/gm, "$1\\.$2");
  }

  function collapse(text) {
    return text.replace(/[ \t\r\n]+/g, " ");
  }

  // ------------------------------------------------------------------- inline

  function inlineChildren(node) {
    let out = "";
    for (const child of Array.from(node.childNodes)) out += inlineNode(child);
    return out;
  }

  function inlineNode(node) {
    if (node.nodeType === 3) return escapeText(collapse(node.nodeValue));
    if (node.nodeType === 8) return "";
    if (node.nodeType !== 1) return "";

    const name = tag(node);
    switch (name) {
      case "br":
        return "  \n";
      case "strong":
      case "b": {
        const inner = inlineChildren(node).trim();
        return inner ? `**${inner}**` : "";
      }
      case "em":
      case "i": {
        const inner = inlineChildren(node).trim();
        return inner ? `*${inner}*` : "";
      }
      case "s":
      case "del":
      case "strike": {
        const inner = inlineChildren(node).trim();
        return inner ? `~~${inner}~~` : "";
      }
      case "code": {
        if (node.parentElement && tag(node.parentElement) === "pre") {
          return node.textContent;
        }
        const text = node.textContent;
        // Use a longer fence than any backtick run inside the content.
        const longest = (text.match(/`+/g) || []).reduce((n, run) => Math.max(n, run.length), 0);
        const fence = "`".repeat(longest + 1);
        const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
        return `${fence}${pad}${text}${pad}${fence}`;
      }
      case "a": {
        const href = node.getAttribute("href") || "";
        const title = node.getAttribute("title");
        const inner = inlineChildren(node).trim() || href;
        if (!href) return inner;
        const suffix = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
        return `[${inner}](${encodeTarget(href)}${suffix})`;
      }
      case "img":
        return image(node);
      case "span": {
        // A bare <span> adds nothing Markdown cannot express; a styled one must survive.
        const meaningful = Array.from(node.attributes || []).filter(
          (a) => !INJECTED_ATTRIBUTES.has(a.name.toLowerCase())
        );
        const inner = inlineChildren(node);
        return meaningful.length ? verbatim(node, inner) : inner;
      }
      default:
        if (KEEP_INLINE.has(name)) return verbatim(node, inlineChildren(node));
        return inlineChildren(node);
    }
  }

  /** An image is Markdown only if it came from Markdown and carries nothing extra. */
  function image(node) {
    const target = node.getAttribute("data-rkf-src") || node.getAttribute("src") || "";
    const alt = node.getAttribute("alt") || "";
    const fromMarkdown = node.hasAttribute("data-rkf-md");
    if (!fromMarkdown) return verbatim(node, "");

    const expressible = new Set([
      "src", "alt", "class", "width", "height", ...INJECTED_ATTRIBUTES,
    ]);
    for (const attribute of Array.from(node.attributes || [])) {
      if (!expressible.has(attribute.name.toLowerCase())) return verbatim(node, "");
    }
    const title = node.getAttribute("title");
    const suffix = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
    return `![${alt.replace(/([\[\]])/g, "\\$1")}](${encodeTarget(target)}${suffix})`;
  }

  function encodeTarget(target) {
    return /[\s()]/.test(target) ? `<${target}>` : target;
  }

  // -------------------------------------------------------------------- blocks

  function blockChildren(node, indent) {
    const blocks = [];
    let pending = [];

    const flush = () => {
      const text = pending.join("").trim();
      pending = [];
      if (text) blocks.push(text);
    };

    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 1 && BLOCK_TAGS.has(tag(child))) {
        flush();
        const rendered = blockNode(child, indent);
        if (rendered) blocks.push(rendered);
      } else if (child.nodeType === 1 && (tag(child) === "li" || tag(child) === "tr")) {
        flush();
        const rendered = blockNode(child, indent);
        if (rendered) blocks.push(rendered);
      } else {
        pending.push(inlineNode(child));
      }
    }
    flush();
    return blocks;
  }

  function blockNode(node, indent) {
    const name = tag(node);
    switch (name) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const inner = inlineChildren(node).trim();
        return inner ? `${"#".repeat(Number(name[1]))} ${inner}` : "";
      }
      case "p":
        return inlineChildren(node).trim();
      case "hr":
        return "---";
      case "br":
        return "";
      case "pre": {
        const code = node.querySelector("code");
        const text = (code || node).textContent.replace(/\n$/, "");
        const language = code ? languageOf(code) : "";
        const longest = (text.match(/^`{3,}/gm) || []).reduce(
          (n, run) => Math.max(n, run.length), 2
        );
        const fence = "`".repeat(longest + 1);
        return `${fence}${language}\n${text}\n${fence}`;
      }
      case "blockquote":
        return blockChildren(node, indent)
          .join("\n\n")
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n");
      case "ul":
      case "ol":
        return list(node, indent);
      case "figure": {
        // The caption is the image's alt text, so the image alone reproduces it.
        const img = node.querySelector("img");
        const rest = Array.from(node.childNodes).filter(
          (child) => child !== img && tag(child) !== "figcaption"
        );
        if (img && !rest.some((child) => (child.textContent || "").trim())) {
          return inlineNode(img);
        }
        return verbatim(node, node.innerHTML);
      }
      case "table":
        return table(node);
      case "div":
      case "section":
      case "article":
      case "main":
      case "header":
      case "footer":
      case "aside": {
        const meaningful = Array.from(node.attributes || []).filter(
          (a) => !INJECTED_ATTRIBUTES.has(a.name.toLowerCase())
        );
        const inner = blockChildren(node, indent).join("\n\n");
        if (!meaningful.length) return inner;
        return verbatim(node, node.innerHTML);
      }
      default:
        return verbatim(node, node.innerHTML);
    }
  }

  function languageOf(code) {
    const match = /(?:^|\s)language-([A-Za-z0-9_+-]+)/.exec(code.className || "");
    return match ? match[1] : "";
  }

  function list(node, indent) {
    const ordered = tag(node) === "ol";
    const start = Number(node.getAttribute("start") || 1) || 1;
    const items = Array.from(node.children).filter((child) => tag(child) === "li");
    const lines = [];
    let loose = false;
    for (const item of items) {
      if (Array.from(item.children).some((child) => tag(child) === "p")) loose = true;
    }
    items.forEach((item, index) => {
      // A task list item carries a checkbox that must come back as `[ ]` or `[x]`. Scoped to
      // the item's own content so a checkbox in a nested list is not picked up here.
      const checkbox = item.querySelector(
        ':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]'
      );
      const task = checkbox
        ? checkbox.checked || checkbox.hasAttribute("checked")
          ? "[x] "
          : "[ ] "
        : "";
      const listMarker = ordered ? `${start + index}. ` : "- ";
      const marker = listMarker + task;
      // Continuation lines line up with the *list marker*, not the task checkbox: `[ ]` is
      // part of the item's content, so counting it would over-indent a nested list far
      // enough that it reads back as plain text instead of a sublist.
      const pad = " ".repeat(listMarker.length);
      // A nested list must follow its item's text with a single newline. A blank line
      // there would make the outer list loose, and the paragraphs would come back wrapped
      // in <p> - a visible change from an edit that changed nothing.
      const body = blockChildren(item, indent + pad).reduce((acc, block, position) => {
        if (position === 0) return block;
        const nestedList = /^\s*(?:[-*+]|\d+\.)\s/.test(block);
        return acc + (nestedList ? "\n" : "\n\n") + block;
      }, "");
      const rendered = body
        .split("\n")
        .map((line, lineIndex) => (lineIndex === 0 ? marker + line : line ? pad + line : ""))
        .join("\n");
      lines.push(rendered);
    });

    // Anything inside the list that is not an <li> would otherwise be dropped. That is
    // reachable in practice: dropping an image at the end of a list can land it as a direct
    // child of the <ul>. Emit those after the list rather than losing them.
    const strays = [];
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 1 && tag(child) === "li") continue;
      const rendered =
        child.nodeType === 1 && BLOCK_TAGS.has(tag(child))
          ? blockNode(child, indent)
          : inlineNode(child).trim();
      if (rendered) strays.push(rendered);
    }

    const rendered = lines.join(loose ? "\n\n" : "\n");
    return strays.length ? [rendered, ...strays].join("\n\n") : rendered;
  }

  function table(node) {
    const rows = Array.from(node.querySelectorAll("tr"));
    if (!rows.length) return "";
    const headerCells = Array.from(rows[0].children);
    const alignments = headerCells.map((cell) => {
      const style = (cell.getAttribute("style") || "").toLowerCase();
      const attr = (cell.getAttribute("align") || "").toLowerCase();
      if (style.includes("text-align:center") || attr === "center") return ":-:";
      if (style.includes("text-align:right") || attr === "right") return "--:";
      if (style.includes("text-align:left") || attr === "left") return ":--";
      return "---";
    });
    const line = (cells) =>
      `| ${cells.map((cell) => inlineChildren(cell).trim().replace(/\|/g, "\\|") || " ").join(" | ")} |`;
    const out = [line(headerCells), `| ${alignments.join(" | ")} |`];
    for (const row of rows.slice(1)) out.push(line(Array.from(row.children)));
    return out.join("\n");
  }

  /** Serialise a rendered document element back to Markdown. */
  function toMarkdown(root) {
    const blocks = blockChildren(root, "");
    return blocks.filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  global.RKF = Object.assign(global.RKF || {}, { toMarkdown });
})(typeof globalThis !== "undefined" ? globalThis : window);
