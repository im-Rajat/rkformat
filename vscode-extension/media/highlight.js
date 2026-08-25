/* GENERATED COPY - do not edit.
 *
 * Source of truth: docs/assets/highlight.js. Re-run docs/build.py after changing
 * it, or the extension and the web editor will disagree.
 */
/**
 * Markdown syntax highlighting for the source editor.
 *
 * A <textarea> cannot colour its own text, so both editors put a highlighted layer behind a
 * transparent textarea. That only works if the layer holds **exactly the same characters** as
 * the textarea - every `#`, `*` and backtick included - because a single missing character
 * changes where a line wraps and the two layers slide out of alignment.
 *
 * So this is not a parser that rewrites text; it wraps spans around the original characters
 * and never adds or removes one. `tests/test_highlight.js` asserts that invariant directly:
 *
 *     stripTags(highlight(text)) === escapeHtml(text)
 *
 * Being a highlighter rather than a renderer, it can be approximate at the edges - a
 * mis-coloured emphasis run is cosmetic. It must never lose text.
 */

(function (global) {
  "use strict";

  // Private-use code points, written as escapes so no editor can strip them: placeholders
  // for spans already emitted, so later passes cannot match inside them.
  const PH_OPEN = "\uE000";
  const PH_CLOSE = "\uE001";

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  const FENCE = /^([ \t]{0,3})(`{3,}|~{3,})(.*)$/;
  const ATX = /^([ \t]{0,3})(#{1,6})([ \t]+.*)?$/;
  const HR = /^[ \t]{0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/;
  const QUOTE = /^([ \t]{0,3}(?:>[ \t]?)+)(.*)$/;
  const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
  const TASK = /^(\[[ xX]\])([ \t]+)(.*)$/;
  const SETEXT = /^[ \t]{0,3}(=+|-+)[ \t]*$/;
  const REFDEF = /^([ \t]{0,3}\[[^\]]+\]:)([ \t]*)(.*)$/;

  class Highlighter {
    constructor() {
      this.slots = [];
    }

    stash(html) {
      this.slots.push(html);
      return `${PH_OPEN}${this.slots.length - 1}${PH_CLOSE}`;
    }

    restore(text) {
      let out = text;
      for (let pass = 0; pass < 6 && out.includes(PH_OPEN); pass += 1) {
        out = out.replace(
          new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, "g"),
          (whole, index) => this.slots[Number(index)] ?? whole
        );
      }
      return out;
    }

    /** Wrap already-escaped content in a token span. */
    token(cls, content) {
      return this.stash(`<span class="tok-${cls}">${content}</span>`);
    }

    /**
     * Inline constructs, innermost first.
     *
     * Code spans go first because their contents are literal; the markers themselves are
     * dimmed separately so the eye can see the structure without it shouting.
     */
    inline(escaped) {
      let out = escaped;

      // Code spans: `x`, ``x``
      out = out.replace(/(`+)([^`\n]+?)\1/g, (whole, ticks, body) =>
        this.token("marker", ticks) + this.token("code", body) + this.token("marker", ticks)
      );

      // Images and links: ![alt](src) and [text](url)
      out = out.replace(
        /(!?)(\[)([^\]\n]*)(\]\()([^)\n]*)(\))/g,
        (whole, bang, open, label, middle, target, close) =>
          this.token("marker", bang + open) +
          this.token(bang ? "alt" : "link", label) +
          this.token("marker", middle) +
          this.token("url", target) +
          this.token("marker", close)
      );

      // Autolinks: <https://...>
      out = out.replace(/(&lt;)((?:https?:\/\/|mailto:)[^\s&]+)(&gt;)/g, (whole, open, url, close) =>
        this.token("marker", open) + this.token("url", url) + this.token("marker", close)
      );

      // Raw HTML tags
      out = out.replace(/&lt;\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^&]*?)?\/?&gt;/g, (tag) =>
        this.token("tag", tag)
      );

      // Emphasis. Triple first, so *** does not get split by the ** pass.
      out = out.replace(/(\*\*\*)(?=\S)([\s\S]*?\S)(\*\*\*)/g, (whole, a, body, b) =>
        this.token("marker", a) + this.token("strong-em", body) + this.token("marker", b)
      );
      out = out.replace(/(\*\*)(?=\S)([^*\n]*?\S)(\*\*)/g, (whole, a, body, b) =>
        this.token("marker", a) + this.token("strong", body) + this.token("marker", b)
      );
      out = out.replace(
        /(^|[^A-Za-z0-9_])(__)(?=\S)([^_\n]*?\S)(__)(?![A-Za-z0-9_])/g,
        (whole, lead, a, body, b) =>
          lead + this.token("marker", a) + this.token("strong", body) + this.token("marker", b)
      );
      out = out.replace(/(~~)(?=\S)([^~\n]*?\S)(~~)/g, (whole, a, body, b) =>
        this.token("marker", a) + this.token("strike", body) + this.token("marker", b)
      );
      out = out.replace(/(\*)(?=\S)([^*\n]*?\S)(\*)/g, (whole, a, body, b) =>
        this.token("marker", a) + this.token("em", body) + this.token("marker", b)
      );
      out = out.replace(
        /(^|[^A-Za-z0-9_])(_)(?=\S)([^_\n]*?\S)(_)(?![A-Za-z0-9_])/g,
        (whole, lead, a, body, b) =>
          lead + this.token("marker", a) + this.token("em", body) + this.token("marker", b)
      );

      return out;
    }

    /** Highlight one line that is not inside a fenced code block. */
    line(raw, previousWasText) {
      const escaped = escapeHtml(raw);

      if (!raw.trim()) return escaped;

      const atx = ATX.exec(raw);
      if (atx) {
        const [, indent, hashes, rest] = atx;
        return (
          escapeHtml(indent) +
          this.token("marker", escapeHtml(hashes)) +
          this.token("heading", this.inline(escapeHtml(rest || "")))
        );
      }

      if (HR.test(raw)) return this.token("marker", escaped);

      if (previousWasText && SETEXT.test(raw)) return this.token("marker", escaped);

      const refdef = REFDEF.exec(raw);
      if (refdef) {
        const [, label, space, target] = refdef;
        return (
          this.token("link", escapeHtml(label)) + escapeHtml(space) + this.token("url", escapeHtml(target))
        );
      }

      const quote = QUOTE.exec(raw);
      if (quote) {
        const [, markers, rest] = quote;
        return this.token("marker", escapeHtml(markers)) + this.token("quote", this.inline(escapeHtml(rest)));
      }

      const list = LIST.exec(raw);
      if (list) {
        const [, indent, bullet, space, rest] = list;
        const task = TASK.exec(rest);
        const body = task
          ? this.token("task", escapeHtml(task[1])) + escapeHtml(task[2]) + this.inline(escapeHtml(task[3]))
          : this.inline(escapeHtml(rest));
        return escapeHtml(indent) + this.token("marker", escapeHtml(bullet)) + escapeHtml(space) + body;
      }

      // Table rows: colour the pipes so columns are easy to line up by eye.
      if (raw.includes("|") && /^[ \t]{0,3}\|?.*\|/.test(raw)) {
        if (/^[ \t]{0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(raw)) {
          return this.token("marker", escaped);
        }
        return this.inline(escaped).replace(/\|/g, () => this.token("marker", "|"));
      }

      return this.inline(escaped);
    }

    run(text) {
      const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
      const out = [];
      let fence = null; // the marker that opened the current block
      let previousWasText = false;

      for (const raw of lines) {
        const fenceMatch = FENCE.exec(raw);
        if (fence) {
          if (fenceMatch && fenceMatch[2][0] === fence[0] && fenceMatch[2].length >= fence.length) {
            out.push(this.token("marker", escapeHtml(raw)));
            fence = null;
          } else {
            out.push(this.token("code", escapeHtml(raw)));
          }
          previousWasText = false;
          continue;
        }
        if (fenceMatch) {
          fence = fenceMatch[2];
          out.push(
            escapeHtml(fenceMatch[1]) +
              this.token("marker", escapeHtml(fenceMatch[2])) +
              this.token("lang", escapeHtml(fenceMatch[3]))
          );
          previousWasText = false;
          continue;
        }
        out.push(this.line(raw, previousWasText));
        previousWasText = Boolean(raw.trim());
      }

      // The trailing newline keeps the last line's height, so the layer matches the textarea
      // when the document ends with a newline.
      return this.restore(out.join("\n")) + "\n";
    }
  }

  /** Highlight Markdown, returning HTML whose text content equals the input exactly. */
  function markdown(text) {
    return new Highlighter().run(text);
  }

  global.RKF = Object.assign(global.RKF || {}, {
    highlight: { markdown, escapeHtml },
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
