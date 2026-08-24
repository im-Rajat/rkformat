/**
 * Markdown renderer for the browser viewer.
 *
 * This is deliberately a second implementation: GitHub Pages is static hosting, so the
 * site cannot call the Python renderer the way the VS Code extension does. It targets the
 * same feature set markdown-it-py is configured with in rkformat/render.py - CommonMark
 * plus tables and strikethrough - and emits the same markup for images and figures, so the
 * shared stylesheet applies unchanged.
 *
 * `tests/test_site_parity.js` renders fixtures through both implementations and diffs the
 * HTML, which is what keeps the two honest. Where they disagree, `rk render` is canonical.
 *
 * Raw HTML in the document is escaped, not executed (SPEC.md section 4).
 */

(function (global) {
  "use strict";

  // Private-use code points, written as escapes so no editor can strip them: these
  // stand in for already-rendered inline HTML and cannot collide with document text.
  const PH_OPEN = "\uE000";
  const PH_CLOSE = "\uE001";

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(text) {
    return escapeHtml(text).replace(/'/g, "&#39;");
  }

  /**
   * Decide whether a URL may appear in an href or src.
   *
   * Returns null for anything that could carry script. Callers then leave the original
   * Markdown as literal text rather than emitting a neutered tag - which is what
   * markdown-it's validateLink does, so the two renderers agree.
   */
  function safeUrl(url) {
    const trimmed = String(url || "").trim();
    if (/^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i.test(trimmed)) return trimmed;
    if (/^data:image\//i.test(trimmed)) return trimmed;
    if (/^blob:/i.test(trimmed)) return trimmed;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null; // some other scheme - refuse it
    return trimmed; // relative path
  }

  // ------------------------------------------------------------------- inline

  class Inline {
    constructor(options) {
      this.options = options;
      this.slots = [];
    }

    stash(html) {
      this.slots.push(html);
      return `${PH_OPEN}${this.slots.length - 1}${PH_CLOSE}`;
    }

    restore(text) {
      let out = text;
      // Nested placeholders (a link inside emphasis) need repeated passes.
      for (let pass = 0; pass < 8 && out.includes(PH_OPEN); pass += 1) {
        out = out.replace(
          new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, "g"),
          (whole, index) => this.slots[Number(index)] ?? whole
        );
      }
      return out;
    }

    render(text) {
      let out = this.codeSpans(text);
      out = this.escapes(out);
      out = escapeHtml(out);
      out = this.imagesAndLinks(out);
      out = this.autolinks(out);
      out = this.emphasis(out);
      out = this.breaks(out);
      return this.restore(out);
    }

    /** Code spans win over every other inline construct, so they go first. */
    codeSpans(text) {
      return text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (whole, ticks, body) => {
        let content = body.replace(/\n/g, " ");
        if (content.length > 2 && content.startsWith(" ") && content.endsWith(" ")) {
          content = content.slice(1, -1);
        }
        return this.stash(`<code>${escapeHtml(content)}</code>`);
      });
    }

    escapes(text) {
      const punctuation = "\\\\`*_{}[]()#+-.!|<>~\"'$%&,/:;=?@^";
      return text.replace(/\\(.)/g, (whole, char) =>
        punctuation.includes(char) ? this.stash(escapeHtml(char)) : whole
      );
    }

    imagesAndLinks(text) {
      let out = text;
      let previous = null;
      // Innermost first, repeated: handles [![img](a)](b) and emphasis inside link text.
      while (out !== previous) {
        previous = out;
        out = out.replace(
          /!\[([^\[\]]*)\]\(\s*(?:&lt;)?([^\s()]*?)(?:&gt;)?(?:\s+(?:"([^"]*)"|&quot;([^&]*?)&quot;))?\s*\)/g,
          (whole, alt, src, title1, title2) => {
            const rendered = this.image(alt, src, title1 || title2 || null);
            return rendered === null ? whole : this.stash(rendered);
          }
        );
        out = out.replace(
          /\[([^\[\]]*)\]\(\s*(?:&lt;)?([^\s()]*?)(?:&gt;)?(?:\s+(?:"([^"]*)"|&quot;([^&]*?)&quot;))?\s*\)/g,
          (whole, label, href, title1, title2) => {
            const url = safeUrl(unescapeEntities(href));
            if (url === null) return whole;
            const title = title1 || title2;
            const attrs = title ? ` title="${escapeAttr(title)}"` : "";
            return this.stash(
              `<a href="${escapeAttr(url)}"${attrs}>${this.render(label)}</a>`
            );
          }
        );
        // Reference forms: ![alt][id], [text][id], [text][], [text]
        out = out.replace(/!\[([^\[\]]*)\]\[([^\[\]]*)\]/g, (whole, alt, id) => {
          const target = this.options.references[(id || alt).toLowerCase()];
          if (!target) return whole;
          const rendered = this.image(alt, target.href, target.title);
          return rendered === null ? whole : this.stash(rendered);
        });
        out = out.replace(/\[([^\[\]]*)\]\[([^\[\]]*)\]/g, (whole, label, id) => {
          const target = this.options.references[(id || label).toLowerCase()];
          if (!target) return whole;
          const href = safeUrl(target.href);
          if (href === null) return whole;
          const attrs = target.title ? ` title="${escapeAttr(target.title)}"` : "";
          return this.stash(
            `<a href="${escapeAttr(href)}"${attrs}>${this.render(label)}</a>`
          );
        });
      }
      out = out.replace(/\[([^\[\]]+)\]/g, (whole, label) => {
        const target = this.options.references[label.toLowerCase()];
        if (!target) return whole;
        const href = safeUrl(target.href);
        if (href === null) return whole;
        const attrs = target.title ? ` title="${escapeAttr(target.title)}"` : "";
        return this.stash(
          `<a href="${escapeAttr(href)}"${attrs}>${this.render(label)}</a>`
        );
      });
      return out;
    }

    /**
     * Emit an image tag.
     *
     * Attribute order matches rkformat/render.py exactly so the parity test can diff the
     * two renderers' output directly.
     */
    image(alt, rawSrc, title) {
      const src = unescapeEntities(rawSrc);
      const resolved = this.options.resolveImage ? this.options.resolveImage(src) : null;
      const attrs = [];
      if (resolved) {
        attrs.push(`src="${escapeAttr(resolved.url)}"`);
        attrs.push(`alt="${escapeAttr(alt)}"`);
        if (resolved.width && resolved.height) {
          attrs.push(`width="${resolved.width}" height="${resolved.height}"`);
        }
        attrs.push('class="rkf-image"');
      } else {
        const url = safeUrl(src);
        if (url === null) return null; // refused scheme: not an image at all
        attrs.push(`src="${escapeAttr(url)}"`);
        attrs.push(`alt="${escapeAttr(alt)}"`);
        attrs.push('class="rkf-image rkf-missing"');
        if (!/^(https?:|data:)/i.test(src)) {
          attrs.push(`data-rkf-dangling="${escapeAttr(src)}"`);
        }
      }
      if (title) attrs.push(`title="${escapeAttr(title)}"`);
      return `<img ${attrs.join(" ")} loading="lazy">`;
    }

    autolinks(text) {
      let out = text.replace(/&lt;((?:https?:\/\/|mailto:)[^\s<>]+)&gt;/gi, (whole, url) => {
        const clean = unescapeEntities(url);
        return this.stash(`<a href="${escapeAttr(clean)}">${escapeHtml(clean)}</a>`);
      });
      // Bare URLs are deliberately NOT linkified: markdown-it-py only does so when the
      // optional linkify-it-py package is present, which would make rendering depend on
      // whether a transitive dependency happens to be installed. Both sides now agree that
      // only explicit <autolinks> and [links](...) become anchors.
      return out;
    }

    emphasis(text) {
      let out = text;
      let previous = null;
      while (out !== previous) {
        previous = out;
        out = out.replace(
          /\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g,
          (w, body) => `<em><strong>${body}</strong></em>`
        );
        out = out.replace(
          /(^|[^A-Za-z0-9_])___(?=\S)([\s\S]*?\S)___(?![A-Za-z0-9_])/g,
          (w, lead, body) => `${lead}<em><strong>${body}</strong></em>`
        );
        out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, (w, body) => `<strong>${body}</strong>`);
        out = out.replace(
          /(^|[^A-Za-z0-9_])__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9_])/g,
          (w, lead, body) => `${lead}<strong>${body}</strong>`
        );
        out = out.replace(/~~(?=\S)([\s\S]*?\S)~~/g, (w, body) => `<s>${body}</s>`);
        out = out.replace(/\*(?=\S)([^*]*?\S)\*/g, (w, body) => `<em>${body}</em>`);
        out = out.replace(
          /(^|[^A-Za-z0-9_])_(?=\S)([^_]*?\S)_(?![A-Za-z0-9_])/g,
          (w, lead, body) => `${lead}<em>${body}</em>`
        );
      }
      return out;
    }

    breaks(text) {
      return text.replace(/ {2,}\n/g, "<br />\n").replace(/\\\n/g, "<br />\n");
    }
  }

  function unescapeEntities(text) {
    return String(text)
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }

  // -------------------------------------------------------------------- blocks

  const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
  const FENCE = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*([^`\n]*)$/;
  const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
  const BULLET = /^( {0,3})([-*+])([ \t]+|$)/;
  const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)/;
  const QUOTE = /^ {0,3}>[ \t]?/;
  const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
  const DELIMITER_ROW = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

  function startsBlock(line) {
    return (
      !line.trim() ||
      ATX.test(line) ||
      FENCE.test(line) ||
      HR.test(line) ||
      QUOTE.test(line) ||
      BULLET.test(line) ||
      ORDERED.test(line)
    );
  }

  function splitRow(row) {
    const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells = [];
    let current = "";
    for (let i = 0; i < trimmed.length; i += 1) {
      const char = trimmed[i];
      if (char === "\\" && trimmed[i + 1] === "|") {
        current += "|";
        i += 1;
      } else if (char === "|") {
        cells.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    cells.push(current);
    return cells.map((cell) => cell.trim());
  }

  class Blocks {
    constructor(options) {
      this.options = options;
    }

    inline(text) {
      return new Inline(this.options).render(text);
    }

    render(lines) {
      const out = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];

        if (!line.trim()) {
          i += 1;
          continue;
        }

        const fence = FENCE.exec(line);
        if (fence) {
          const [, indent, marker, info] = fence;
          const body = [];
          i += 1;
          while (i < lines.length) {
            const closing = new RegExp(`^[ \\t]{0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
            if (closing.test(lines[i])) {
              i += 1;
              break;
            }
            body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i]);
            i += 1;
          }
          const language = info.trim().split(/\s+/)[0];
          const cls = language ? ` class="language-${escapeAttr(language)}"` : "";
          out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}${body.length ? "\n" : ""}</code></pre>`);
          continue;
        }

        const atx = ATX.exec(line);
        if (atx) {
          const level = atx[1].length;
          out.push(`<h${level}>${this.inline(atx[2] || "")}</h${level}>`);
          i += 1;
          continue;
        }

        if (HR.test(line)) {
          out.push("<hr />");
          i += 1;
          continue;
        }

        if (QUOTE.test(line)) {
          const body = [];
          while (i < lines.length && lines[i].trim()) {
            // Lazy continuation: a plain line after a '>' line stays in the quote.
            if (!QUOTE.test(lines[i]) && startsBlock(lines[i])) break;
            body.push(lines[i].replace(QUOTE, ""));
            i += 1;
          }
          out.push(`<blockquote>\n${this.render(body)}</blockquote>`);
          continue;
        }

        if (BULLET.test(line) || ORDERED.test(line)) {
          const [html, next] = this.list(lines, i);
          out.push(html);
          i = next;
          continue;
        }

        if (line.includes("|") && i + 1 < lines.length && DELIMITER_ROW.test(lines[i + 1])) {
          const [html, next] = this.table(lines, i);
          if (html) {
            out.push(html);
            i = next;
            continue;
          }
        }

        if (/^ {4,}\S/.test(line)) {
          const body = [];
          while (i < lines.length && (/^ {4}/.test(lines[i]) || !lines[i].trim())) {
            if (!lines[i].trim() && !lines.slice(i + 1).some((l) => /^ {4}/.test(l))) break;
            body.push(lines[i].replace(/^ {4}/, ""));
            i += 1;
          }
          while (body.length && !body[body.length - 1].trim()) body.pop();
          out.push(`<pre><code>${escapeHtml(body.join("\n"))}\n</code></pre>`);
          continue;
        }

        // Paragraph, possibly closed by a setext underline.
        const body = [];
        let heading = 0;
        while (i < lines.length && lines[i].trim()) {
          if (body.length && SETEXT.test(lines[i])) {
            heading = lines[i].trim().startsWith("=") ? 1 : 2;
            i += 1;
            break;
          }
          if (body.length && startsBlock(lines[i])) break;
          body.push(lines[i]);
          i += 1;
        }
        const text = body.join("\n").trim();
        if (!text) continue;
        out.push(
          heading ? `<h${heading}>${this.inline(text)}</h${heading}>` : `<p>${this.inline(text)}</p>`
        );
      }
      return out.length ? `${out.join("\n")}\n` : "";
    }

    /**
     * Parse a list starting at `start`.
     *
     * The tight/loose distinction is the fiddly part: a list is loose when a blank line
     * separates any two items (or an item holds more than one block), and loose items get
     * their paragraphs kept while tight items have them unwrapped.
     */
    list(lines, start) {
      const ordered = !BULLET.test(lines[start]);
      const startNumber = ordered ? Number(ORDERED.exec(lines[start])[2]) : null;
      const items = [];
      let loose = false;
      let i = start;

      while (i < lines.length) {
        const match = ordered ? ORDERED.exec(lines[i]) : BULLET.exec(lines[i]);
        if (!match || match[1].length >= 4) break;
        if (ordered ? BULLET.test(lines[i]) : !BULLET.test(lines[i])) break;

        const rest = lines[i].replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]*/, "");
        const contentIndent = Math.max(2, lines[i].length - rest.length);
        const content = [rest];
        i += 1;
        let blanks = 0;

        while (i < lines.length) {
          const line = lines[i];
          if (!line.trim()) {
            blanks += 1;
            i += 1;
            continue;
          }
          const leading = line.length - line.replace(/^ +/, "").length;
          const indented = leading >= contentIndent;
          const sibling = BULLET.test(line) || ORDERED.test(line);

          if (blanks > 0) {
            if (indented) {
              for (let b = 0; b < blanks; b += 1) content.push("");
              blanks = 0;
            } else {
              if (sibling) loose = true; // a blank line between items makes the list loose
              break;
            }
          }
          if (!indented && (sibling || startsBlock(line))) break;
          content.push(indented ? line.slice(contentIndent) : line); // lazy continuation
          i += 1;
        }
        items.push(content);
      }

      const rendered = items.map((content) => {
        while (content.length && !content[content.length - 1].trim()) content.pop();
        const multiBlock = content.some((line, index) => index > 0 && !line.trim());
        const inner = this.render(content);
        if (loose || multiBlock) return `<li>\n${inner}</li>`;
        return `<li>${unwrapParagraphs(inner)}</li>`;
      });

      const tag = ordered ? "ol" : "ul";
      const attr = ordered && startNumber !== 1 ? ` start="${startNumber}"` : "";
      return [`<${tag}${attr}>\n${rendered.join("\n")}\n</${tag}>`, i];
    }

    table(lines, start) {
      const header = splitRow(lines[start]);
      const delimiters = splitRow(lines[start + 1]);
      if (delimiters.length !== header.length) return [null, start];
      const alignments = delimiters.map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        if (left) return "left";
        return null;
      });

      let i = start + 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }

      const cell = (tag, text, align) => {
        const style = align ? ` style="text-align:${align}"` : "";
        return `<${tag}${style}>${this.inline(text)}</${tag}>`;
      };

      const head = header.map((text, index) => cell("th", text, alignments[index])).join("");
      const body = rows
        .map((row) => {
          const cells = [];
          for (let index = 0; index < header.length; index += 1) {
            cells.push(cell("td", row[index] || "", alignments[index]));
          }
          return `<tr>${cells.join("")}</tr>`;
        })
        .join("\n");

      const table =
        `<table>\n<thead>\n<tr>${head}</tr>\n</thead>\n` +
        (body ? `<tbody>\n${body}\n</tbody>\n` : "") +
        "</table>";
      return [table, i];
    }
  }

  function unwrapParagraphs(html) {
    return html
      .replace(/(^|<\/(?:ul|ol|pre|table|blockquote)>\n?)<p>([\s\S]*?)<\/p>/g, "$1$2")
      .trim();
  }

  /** Pull out link reference definitions before block parsing. */
  function extractReferences(text) {
    const references = {};
    const cleaned = text.replace(
      /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/gm,
      (whole, label, href, t1, t2, t3) => {
        // A definition pointing at a refused scheme is not a definition. Leave the line
        // in place so it renders as ordinary text, which is what markdown-it does.
        if (safeUrl(href) === null) return whole;
        references[label.toLowerCase()] = { href, title: t1 || t2 || t3 || null };
        return "";
      }
    );
    return { references, text: cleaned };
  }

  /** Promote a lone image in a paragraph to a captioned figure. Mirrors render._figurize. */
  function figurize(html) {
    return html.replace(/<p>\s*(<img\b[^>]*>)\s*<\/p>/gi, (whole, tag) => {
      const alt = /\balt\s*=\s*"([^"]*)"/i.exec(tag);
      const caption = alt && alt[1].trim() ? `<figcaption>${alt[1]}</figcaption>` : "";
      return `<figure>${tag}${caption}</figure>`;
    });
  }

  /**
   * Render Markdown to an HTML fragment.
   *
   * options.resolveImage(src) should return {url, width, height} for an embedded asset, or
   * null to mark the reference dangling.
   */
  function render(markdown, options = {}) {
    const normalised = String(markdown).replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
    const { references, text } = extractReferences(normalised);
    const blocks = new Blocks({ ...options, references });
    return figurize(blocks.render(text.split("\n")));
  }

  global.RKF = Object.assign(global.RKF || {}, {
    markdown: { render, escapeHtml, escapeAttr, safeUrl },
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
