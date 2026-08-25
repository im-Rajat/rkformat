/* GENERATED COPY - do not edit.
 *
 * Source of truth: docs/assets/sanitize.js. Re-run docs/build.py after changing it.
 * Inlined into the output of `rk share`.
 */
/**
 * HTML sanitiser for the browser viewer.
 *
 * A port of `src/rkformat/sanitize.py`, kept deliberately line-for-line comparable: the
 * allowlists, the URL rules, the sorted attribute output and the escaping all have to match,
 * because `tests/test_site_parity.js` diffs the two implementations over the same inputs.
 *
 * Note the escaping asymmetry, which mirrors Python's html.escape():
 *   text nodes       -> & < >           are escaped
 *   attribute values -> & < > " '       are escaped (single quote as &#x27;)
 */

(function (global) {
  "use strict";

  const ALLOWED_TAGS = new Set([
    "a", "abbr", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code",
    "col", "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt", "em",
    "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img",
    "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "rp", "rt", "ruby", "s",
    "samp", "section", "small", "span", "strong", "sub", "summary", "sup", "table",
    "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr",
  ]);

  const VOID_TAGS = new Set(["br", "col", "hr", "img", "wbr"]);

  // Every void element in HTML. A discarded void element has no closing tag, so it must be
  // dropped outright rather than opening a skip-until-closed region.
  const HTML_VOID = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
    "source", "track", "wbr",
  ]);

  const DISCARD_WITH_CONTENT = new Set([
    "script", "style", "iframe", "object", "embed", "applet", "noscript", "template",
    "form", "input", "button", "select", "option", "textarea", "link", "meta",
    "base", "title", "head", "svg", "math", "frame", "frameset", "audio", "video",
    "source", "track", "canvas", "map", "area", "portal", "slot",
  ]);

  const GLOBAL_ATTRIBUTES = new Set(["class", "dir", "id", "lang", "title", "translate"]);

  const ALIGN_TAGS = new Set([
    "col", "colgroup", "div", "h1", "h2", "h3", "h4", "h5", "h6", "img", "p", "table",
    "tbody", "td", "tfoot", "th", "thead", "tr",
  ]);

  const ALLOWED_ATTRIBUTES = {
    a: ["href", "rel", "target"],
    col: ["span"],
    colgroup: ["span"],
    del: ["cite", "datetime"],
    details: ["open"],
    img: [
      "alt", "data-rkf-dangling", "data-rkf-md", "data-rkf-src", "height", "loading",
      "src", "width",
    ],
    ins: ["cite", "datetime"],
    li: ["value"],
    ol: ["reversed", "start", "type"],
    q: ["cite"],
    td: ["colspan", "headers", "rowspan"],
    th: ["abbr", "colspan", "headers", "rowspan", "scope"],
    time: ["datetime"],
  };

  const ALLOWED_STYLE_PROPERTIES = new Set([
    "background-color", "border", "border-bottom", "border-collapse", "border-color",
    "border-left", "border-radius", "border-right", "border-style", "border-top",
    "border-width", "color", "float", "font-family", "font-size", "font-style",
    "font-variant", "font-weight", "height", "letter-spacing", "line-height",
    "list-style-type", "margin", "margin-bottom", "margin-left", "margin-right",
    "margin-top", "max-height", "max-width", "min-height", "min-width", "opacity",
    "padding", "padding-bottom", "padding-left", "padding-right", "padding-top",
    "text-align", "text-decoration", "text-indent", "text-transform",
    "vertical-align", "white-space", "width", "word-break",
  ]);

  const SAFE_STYLE_VALUE = /^[A-Za-z0-9 ,.%#()/_-]*$/;
  const STYLE_FORBIDDEN = /url\s*\(|expression|javascript:|@import|\/\*|\\/i;

  const NUMERIC_ATTRIBUTES = new Set([
    "colspan", "height", "rowspan", "span", "start", "value", "width",
  ]);
  const BOOLEAN_ATTRIBUTES = new Set(["open", "reversed"]);
  const ALIGN_KEYWORDS = new Set([
    "left", "right", "center", "justify", "top", "middle", "bottom",
  ]);

  const SAFE_URL = /^(?:https?:|mailto:|tel:|blob:|#|\/|\.\/|\.\.\/)/i;
  const SAFE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp|bmp|svg\+xml|avif|heic);/i;
  const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

  // HTML named entities, decoded wherever an HTML parser would: attribute values, and
  // Markdown text (CommonMark resolves entity references too). Python reaches the full HTML5
  // set via html.unescape; this covers what documents realistically contain. Numeric
  // references are handled generically, and an unknown name is left as literal text.
  const NAMED_ENTITIES = {
    quot: "\"", amp: "&", apos: "'", lt: "<", gt: ">", nbsp: " ", iexcl: "¡", cent: "¢",
    pound: "£", curren: "¤", yen: "¥", brvbar: "¦", sect: "§", uml: "¨", copy: "©", ordf: "ª",
    laquo: "«", not: "¬", shy: "­", reg: "®", macr: "¯", deg: "°", plusmn: "±", sup2: "²",
    sup3: "³", acute: "´", micro: "µ", para: "¶", middot: "·", cedil: "¸", sup1: "¹",
    ordm: "º", raquo: "»", frac14: "¼", frac12: "½", frac34: "¾", iquest: "¿", Agrave: "À",
    Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ", Ccedil: "Ç",
    Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë", Igrave: "Ì", Iacute: "Í", Icirc: "Î",
    Iuml: "Ï", ETH: "Ð", Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ",
    Ouml: "Ö", times: "×", Oslash: "Ø", Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü",
    Yacute: "Ý", THORN: "Þ", szlig: "ß", agrave: "à", aacute: "á", acirc: "â", atilde: "ã",
    auml: "ä", aring: "å", aelig: "æ", ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê",
    euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï", eth: "ð", ntilde: "ñ",
    ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", divide: "÷", oslash: "ø",
    ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", thorn: "þ", yuml: "ÿ",
    OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š", Yuml: "Ÿ", fnof: "ƒ", ensp: " ",
    emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍", lrm: "‎", rlm: "‏", ndash: "–", mdash: "—",
    lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„", dagger: "†",
    Dagger: "‡", bull: "•", hellip: "…", permil: "‰", prime: "′", Prime: "″", lsaquo: "‹",
    rsaquo: "›", oline: "‾", frasl: "⁄", euro: "€", trade: "™", larr: "←", uarr: "↑",
    rarr: "→", darr: "↓", harr: "↔", crarr: "↵", lceil: "⌈", rceil: "⌉", lfloor: "⌊",
    rfloor: "⌋", loz: "◊", spades: "♠", clubs: "♣", hearts: "♥", diams: "♦", forall: "∀",
    part: "∂", exist: "∃", empty: "∅", nabla: "∇", isin: "∈", notin: "∉", ni: "∋", prod: "∏",
    sum: "∑", minus: "−", lowast: "∗", radic: "√", prop: "∝", infin: "∞", ang: "∠", and: "∧",
    or: "∨", cap: "∩", cup: "∪", int: "∫", there4: "∴", sim: "∼", cong: "≅", asymp: "≈",
    ne: "≠", equiv: "≡", le: "≤", ge: "≥", sub: "⊂", sup: "⊃", nsub: "⊄", sube: "⊆", supe: "⊇",
    oplus: "⊕", otimes: "⊗", perp: "⊥", sdot: "⋅", alpha: "α", beta: "β", gamma: "γ",
    delta: "δ", epsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", iota: "ι", kappa: "κ",
    lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π", rho: "ρ", sigma: "σ",
    tau: "τ", upsilon: "υ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω", Alpha: "Α", Beta: "Β",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Omega: "Ω",
  };

  function escapeText(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function escapeAttribute(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  }

  /** Decode entity references the way an HTML parser does for attribute values. */
  function decodeEntities(value) {
    return String(value).replace(/&(#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g,
      (whole, body) => {
        if (body[0] === "#") {
          const code = body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
          if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return whole;
          try {
            return String.fromCodePoint(code);
          } catch (err) {
            return whole;
          }
        }
        const named = NAMED_ENTITIES[body];
        return named === undefined ? whole : named;
      });
  }

  function safeUrl(value) {
    const candidate = String(value).trim().replace(/\0/g, "");
    if (!candidate) return null;
    // A scheme broken up by whitespace or control characters still parses in some browsers.
    const collapsed = candidate.replace(/[\s\u0000-\u001f]/g, "").toLowerCase();
    if (/^(javascript|vbscript|livescript|mocha):/.test(collapsed)) return null;
    if (SAFE_URL.test(candidate) || SAFE_DATA_URL.test(candidate)) return candidate;
    if (HAS_SCHEME.test(candidate)) return null;
    return candidate;
  }

  function cleanStyle(value) {
    if (STYLE_FORBIDDEN.test(value)) return null;
    const kept = [];
    for (const declaration of value.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const setting = declaration.slice(colon + 1).trim();
      if (!ALLOWED_STYLE_PROPERTIES.has(property)) continue;
      if (!setting || !SAFE_STYLE_VALUE.test(setting)) continue;
      kept.push(`${property}:${setting}`);
    }
    return kept.length ? kept.join(";") : null;
  }

  function cleanAttributes(tag, attrs) {
    const allowed = new Set(GLOBAL_ATTRIBUTES);
    allowed.add("style");
    for (const name of ALLOWED_ATTRIBUTES[tag] || []) allowed.add(name);
    if (ALIGN_TAGS.has(tag)) {
      allowed.add("align");
      allowed.add("valign");
    }

    const out = new Map();
    for (const [rawName, rawValue] of attrs) {
      const name = rawName.toLowerCase().trim();
      if (name.startsWith("on")) continue;
      if (!allowed.has(name)) continue;
      if (BOOLEAN_ATTRIBUTES.has(name)) {
        out.set(name, null);
        continue;
      }
      let value = rawValue === null ? "" : decodeEntities(rawValue);
      if (name === "href" || name === "src") {
        const safe = safeUrl(value);
        if (safe === null) continue;
        value = safe;
      } else if (name === "style") {
        const cleaned = cleanStyle(value);
        if (cleaned === null) continue;
        value = cleaned;
      } else if (NUMERIC_ATTRIBUTES.has(name)) {
        const digits = value.trim();
        if (!/^\d{1,6}$/.test(digits)) continue;
        value = digits;
      } else if (name === "align" || name === "valign") {
        const keyword = value.trim().toLowerCase();
        if (!ALIGN_KEYWORDS.has(keyword)) continue;
        value = keyword;
      } else if (name === "target") {
        if (value.trim().toLowerCase() !== "_blank") continue;
        value = "_blank";
      } else if (name === "loading") {
        const keyword = value.trim().toLowerCase();
        if (keyword !== "lazy" && keyword !== "eager") continue;
        value = keyword;
      }
      out.set(name, value);
    }
    if (tag === "a" && out.get("target") === "_blank") {
      out.set("rel", "noopener noreferrer");
    }
    return out;
  }

  function renderTag(tag, attributes, selfClosing) {
    const parts = [tag];
    for (const name of [...attributes.keys()].sort()) {
      const value = attributes.get(name);
      parts.push(value === null ? name : `${name}="${escapeAttribute(value)}"`);
    }
    const inner = parts.join(" ");
    return selfClosing ? `<${inner} />` : `<${inner}>`;
  }

  // ------------------------------------------------------------------ tokenizer

  const TAG_NAME = /^<(\/?)([A-Za-z][A-Za-z0-9:._-]*)/;
  const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]*))?/g;

  /** Walk the markup, handing tokens to the visitor. Mirrors html.parser's dispatch. */
  function tokenize(html, visitor) {
    let i = 0;
    const length = html.length;
    while (i < length) {
      const next = html.indexOf("<", i);
      if (next < 0) {
        visitor.text(html.slice(i));
        break;
      }
      if (next > i) visitor.text(html.slice(i, next));

      if (html.startsWith("<!--", next)) {
        const end = html.indexOf("-->", next + 4);
        i = end < 0 ? length : end + 3;
        continue;
      }
      if (html.startsWith("<!", next) || html.startsWith("<?", next)) {
        const end = html.indexOf(">", next);
        i = end < 0 ? length : end + 1;
        continue;
      }
      const match = TAG_NAME.exec(html.slice(next));
      if (!match) {
        visitor.text("<");
        i = next + 1;
        continue;
      }
      const closing = match[1] === "/";
      const tag = match[2].toLowerCase();
      let cursor = next + match[0].length;
      let end = -1;
      let inQuote = "";
      // Find the tag's closing ">", ignoring any inside a quoted attribute value.
      for (let j = cursor; j < length; j += 1) {
        const char = html[j];
        if (inQuote) {
          if (char === inQuote) inQuote = "";
        } else if (char === '"' || char === "'") {
          inQuote = char;
        } else if (char === ">") {
          end = j;
          break;
        }
      }
      if (end < 0) {
        // Unterminated tag: html.parser discards the remainder.
        break;
      }
      let body = html.slice(cursor, end);
      const selfClosing = /\/\s*$/.test(body);
      if (selfClosing) body = body.replace(/\/\s*$/, "");

      if (closing) {
        visitor.endTag(tag);
      } else {
        const attrs = [];
        ATTRIBUTE.lastIndex = 0;
        let attribute;
        while ((attribute = ATTRIBUTE.exec(body)) !== null) {
          if (!attribute[0].trim()) {
            if (ATTRIBUTE.lastIndex >= body.length) break;
            continue;
          }
          let value = attribute[2];
          if (value === undefined) {
            value = null;
          } else if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            value = value.slice(1, -1);
          }
          attrs.push([attribute[1], value]);
        }
        if (selfClosing) visitor.startEndTag(tag, attrs);
        else visitor.startTag(tag, attrs);
      }
      i = end + 1;
    }
  }

  /**
   * Rebuild `html` from allowlisted tags and attributes.
   *
   * `resolveImage(src)` may return {url, width, height} to repoint an <img> at an embedded
   * asset, exactly as Markdown image syntax is handled.
   */
  function sanitize(html, resolveImage) {
    const out = [];
    const stack = [];
    const discarding = [];

    const emit = (text) => {
      if (!discarding.length) out.push(text);
    };

    const applyImage = (attributes) => {
      if (!resolveImage) return attributes;
      const src = attributes.get("src");
      if (!src) return attributes;
      const resolved = resolveImage(src);
      const classes = (attributes.get("class") || "").split(/\s+/).filter(Boolean);
      if (!resolved) {
        if (!/^(https?:|data:|blob:)/i.test(src)) {
          attributes.set("data-rkf-dangling", src);
          if (!classes.includes("rkf-missing")) classes.push("rkf-image", "rkf-missing");
        }
      } else {
        attributes.set("data-rkf-src", src);
        attributes.set("src", String(resolved.url));
        if (!classes.includes("rkf-image")) classes.push("rkf-image");
        if (!attributes.get("width") && !attributes.get("height")) {
          if (resolved.width && resolved.height) {
            attributes.set("width", String(resolved.width));
            attributes.set("height", String(resolved.height));
          }
        }
      }
      if (classes.length) attributes.set("class", [...new Set(classes)].join(" "));
      return attributes;
    };

    tokenize(html, {
      text(data) {
        if (discarding.length) return;
        // Preserve well-formed entity references; escape everything else.
        emit(
          data.replace(
            /&(#[0-9]{1,7};|#[xX][0-9A-Fa-f]{1,6};|[A-Za-z][A-Za-z0-9]{1,31};)|[&<>]/g,
            (whole, entity) => (entity ? whole : escapeText(whole))
          )
        );
      },

      startTag(tag, attrs) {
        if (DISCARD_WITH_CONTENT.has(tag)) {
          if (!HTML_VOID.has(tag)) discarding.push(tag);
          return;
        }
        if (discarding.length || !ALLOWED_TAGS.has(tag)) return;
        let attributes = cleanAttributes(tag, attrs);
        if (tag === "img") attributes = applyImage(attributes);
        if (VOID_TAGS.has(tag)) {
          emit(renderTag(tag, attributes, true));
          return;
        }
        stack.push(tag);
        emit(renderTag(tag, attributes, false));
      },

      startEndTag(tag, attrs) {
        if (DISCARD_WITH_CONTENT.has(tag) || discarding.length || !ALLOWED_TAGS.has(tag)) {
          return;
        }
        let attributes = cleanAttributes(tag, attrs);
        if (tag === "img") attributes = applyImage(attributes);
        if (VOID_TAGS.has(tag)) {
          emit(renderTag(tag, attributes, true));
        } else {
          emit(renderTag(tag, attributes, false));
          emit(`</${tag}>`);
        }
      },

      endTag(tag) {
        if (discarding.length) {
          if (discarding.includes(tag)) {
            while (discarding.length && discarding.pop() !== tag) {
              /* unwind to the tag being closed */
            }
          }
          return;
        }
        if (!ALLOWED_TAGS.has(tag) || VOID_TAGS.has(tag)) return;
        if (!stack.includes(tag)) return; // stray close tag
        while (stack.length) {
          const open = stack.pop();
          emit(`</${open}>`);
          if (open === tag) break;
        }
      },
    });

    while (stack.length) out.push(`</${stack.pop()}>`);
    return out.join("");
  }

  global.RKF = Object.assign(global.RKF || {}, {
    sanitize,
    decodeEntities,
    sanitizeInternals: { safeUrl, cleanStyle, escapeText, escapeAttribute, ALLOWED_TAGS },
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
