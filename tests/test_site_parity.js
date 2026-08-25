/**
 * Parity test: the browser renderer vs. the canonical Python one.
 *
 * The website cannot call `rk render` (GitHub Pages is static), so docs/assets/markdown.js
 * is a second Markdown implementation. This renders the same fixtures through both and
 * diffs the HTML, so divergence shows up here rather than in someone's browser.
 *
 *   node tests/test_site_parity.js
 *
 * Requires the `rk` CLI on PATH (or RK_COMMAND set, e.g. RK_COMMAND="python3 -m rkformat").
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
require(path.join(root, "docs/assets/rkf.js"));
require(path.join(root, "docs/assets/sanitize.js"));
require(path.join(root, "docs/assets/markdown.js"));

const RK = (process.env.RK_COMMAND || "rk").split(" ");
const HOST_DOCUMENT = path.join(root, "examples/welcome.rkf");

/** Render candidate Markdown through the Python renderer, against a document's assets. */
function renderWithPython(markdown) {
  const stdout = execFileSync(RK[0], [...RK.slice(1), "preview", HOST_DOCUMENT], {
    input: JSON.stringify({ markdown }),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout).html;
}

async function loadHost() {
  const buffer = fs.readFileSync(HOST_DOCUMENT);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const doc = await RKF.open(arrayBuffer);
  const dataUris = new Map();
  for (const asset of doc.assets) dataUris.set(asset.path, await doc.assetDataUri(asset));
  return { doc, dataUris };
}

/** Ignore differences that cannot affect rendering: inter-tag whitespace only. */
function normalise(html) {
  return html
    .replace(/\r\n?/g, "\n")
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .trim();
}

const FIXTURES = [
  ["headings", "# One\n\n## Two\n\n### Three\n\nSetext\n======\n\nOther\n-----\n"],
  ["paragraphs", "First para\nsecond line.\n\nSecond para.\n"],
  ["emphasis", "*em* **strong** ***both*** _em_ __strong__ ~~struck~~ and snake_case_word.\n"],
  ["code-span", "Use `rk info` and ``a ` b`` here.\n"],
  ["fenced-code", "```python\nprint('hi')\n# ![not an image](x.png)\n```\n"],
  ["fenced-no-lang", "```\nplain text\n```\n"],
  ["tilde-fence", "~~~\ntilde fenced\n~~~\n"],
  ["indented-code", "    indented code\n    second line\n"],
  ["bullet-list", "- one\n- two\n- three\n"],
  ["ordered-list", "1. one\n2. two\n3. three\n"],
  ["ordered-start", "5. five\n6. six\n"],
  ["loose-list", "- one\n\n- two\n"],
  ["nested-list", "- outer\n  - inner\n  - inner two\n- outer two\n"],
  ["blockquote", "> quoted text\n> more quote\n"],
  ["blockquote-nested", "> outer\n>\n> > inner\n"],
  ["hr", "text\n\n---\n\nmore\n\n***\n"],
  ["table", "| a | b |\n|---|---|\n| 1 | 2 |\n"],
  ["table-align", "| l | c | r |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n"],
  ["links", "[text](https://example.com) and [titled](https://example.com \"Title\").\n"],
  ["autolink", "Visit <https://example.com> now.\n"],
  ["bare-url-stays-plain", "See https://example.com/page for details.\n"],
  ["reference-link", "[label][ref]\n\n[ref]: https://example.com \"T\"\n"],
  ["image-embedded", "![A gradient](assets/gradient.png)\n"],
  ["image-inline-text", "Text with ![chart](assets/chart.png) inline.\n"],
  ["image-dangling", "![gone](assets/missing.png)\n"],
  ["image-external", "![remote](https://example.com/x.png)\n"],
  ["image-rkf-id", "![by id](rkf:a2)\n"],
  ["image-no-alt", "![](assets/chart.png)\n"],
  ["html-escaped", "<script>alert(1)</script>\n\n<b>bold?</b>\n"],
  ["escapes", "Not \\*emphasis\\* and a literal \\| pipe.\n"],
  ["entities", "AT&T and 5 < 6 and \"quotes\".\n"],
  ["hard-break", "line one  \nline two\n"],
  ["nested-emphasis", "**bold with *em* inside** and *em with **bold** inside*.\n"],
  ["emphasis-across-words", "a*b*c and a_b_c and **a**b.\n"],
  ["link-in-emphasis", "*see [here](https://example.com) now*\n"],
  ["image-in-link", "[![alt](assets/chart.png)](https://example.com)\n"],
  ["deep-list", "- a\n  - b\n    - c\n      - d\n"],
  ["list-with-code", "- item\n\n  ```\n  code\n  ```\n\n- next\n"],
  ["list-paragraphs", "- first para\n\n  second para\n\n- next item\n"],
  ["table-escaped-pipe", "| a | b |\n|---|---|\n| x \\| y | z |\n"],
  ["table-inline", "| **a** | `b` |\n|---|---|\n| [l](https://e.com) | *i* |\n"],
  ["heading-with-inline", "## A **bold** heading with `code`\n"],
  ["empty-doc", ""],
  ["only-whitespace", "\n\n   \n\n"],
  ["unicode", "Emoji and accents: cafe\u0301, \u4f60\u597d, \ud83d\ude80\n"],
  ["long-paragraph", `${"word ".repeat(400)}\n`],
  ["consecutive-images", "![a](assets/chart.png)\n\n![b](assets/rings.png)\n"],
  ["blockquote-with-list", "> - one\n> - two\n"],
  ["code-fence-in-quote", "> ```\n> fenced\n> ```\n"],
  ["xss-link-scheme", "[click](javascript:alert)\n"],
  ["xss-link-mixed-case", "[c](JaVaScRiPt:alert)\n"],
  ["xss-image-scheme", "![x](javascript:evil)\n"],
  ["xss-vbscript", "[a](vbscript:msgbox)\n"],
  ["xss-raw-html", "<img src=x onerror=alert(1)>\n"],
  ["xss-data-html", "[b](data:text/html,evil)\n"],
  ["xss-reference", "[r][bad]\n\n[bad]: javascript:alert\n"],
  // Raw HTML in the body: sanitised, not escaped (SPEC.md section 4).
  ["html-img-sized", '<img src="assets/gradient.png" alt="drawing" width="200"/>\n'],
  ["html-img-plain", '<img src="assets/chart.png">\n'],
  ["html-img-dangling", '<img src="assets/nope.png" alt="x">\n'],
  ["html-img-external", '<img src="https://example.com/a.png">\n'],
  ["html-div-align", '<div align="center">centred <b>bold</b></div>\n'],
  ["html-inline-mix", "Press <kbd>Ctrl</kbd>+<kbd>V</kbd> for <b>bold</b> and <i>italic</i>.\n"],
  ["html-sub-sup", "H<sub>2</sub>O and x<sup>2</sup>\n"],
  ["html-details", "<details><summary>More</summary>\n\nhidden text\n\n</details>\n"],
  ["html-table", '<table><tr><th scope="col">h</th><td colspan="2">c</td></tr></table>\n'],
  ["html-style-attr", '<span style="color:#f00;text-align:center">styled</span>\n'],
  ["html-style-blocked", '<span style="background:url(http://evil/x)">bg</span>\n'],
  ["html-anchor-blank", '<a href="https://example.com" target="_blank">out</a>\n'],
  ["html-entities", "<p>&amp; &lt; &copy; &#39;</p>\n"],
  ["html-in-list", "- item with <b>bold</b>\n- <img src=\"assets/chart.png\" width=\"50\">\n"],
  ["html-in-quote", "> quoted <b>bold</b>\n"],
  ["html-br", "line one<br>line two\n"],
  ["html-comment", "before<!-- hidden -->after\n"],
  ["html-unclosed", "<div>never closed\n"],
  ["html-stray-close", "</div>stray\n"],
  ["html-not-a-tag", "5 < 6 and a <notatag> here\n"],
  ["html-in-code-fence", "```\n<script>alert(1)</script>\n```\n"],
  ["html-in-code-span", "`<script>alert(1)</script>`\n"],
  ["xss-html-script", "<script>alert(1)</script>visible\n"],
  ["xss-html-onerror", "<img src=x onerror=alert(1)>\n"],
  ["xss-html-iframe", '<iframe src="https://evil"></iframe>after\n'],
  ["xss-html-svg", "<svg onload=alert(1)></svg>after\n"],
  ["xss-html-base", '<base href="https://evil/">after\n'],
  ["xss-html-form", '<form><input value="x"></form>after\n'],
  ["xss-html-entity-scheme", '<a href="&#106;avascript:alert(1)">e</a>\n'],
  ["xss-html-style-tag", "<style>body{display:none}</style>after\n"],
  // CommonMark resolves entity references in text - this was a real divergence once.
  ["entity-lt-gt", "Entity: &lt;tag&gt; here\n"],
  ["entity-named", "Copyright &copy; 2026 and &hellip; and &mdash;\n"],
  ["entity-amp", "Amp &amp; more\n"],
  ["entity-numeric", "Numeric &#65; and hex &#x42;\n"],
  ["entity-accented", "Caf&eacute; and &Uuml;ber\n"],
  ["entity-unknown", "Not an entity &notreal; here\n"],
  ["entity-bare-amp", "Bare & ampersand\n"],
  ["entity-in-code", "`&lt;kept literal&gt;`\n"],
  ["entity-in-heading", "# Heading with &amp; and &lt;\n"],
  ["entity-in-link", "[&copy; text](https://example.com)\n"],
  ["entity-in-alt", "![&copy; alt](assets/chart.png)\n"],
  ["entity-in-table", "| &lt;a&gt; | &copy; |\n|---|---|\n| &amp; | x |\n"],
  ["entity-in-title", '[x](https://e.com "&copy; title")\n'],
  ["entity-in-img-title", '![a](assets/chart.png "&copy; t")\n'],
  ["entity-html-block", '<div>&lt;shown as text&gt; &copy;</div>\n'],
  ["mixed", fs.readFileSync(path.join(root, "docs/fixtures/mixed.md"), "utf8")],
];

(async () => {
  const { doc, dataUris } = await loadHost();
  const options = {
    resolveImage(src) {
      const asset = doc.resolve(src);
      if (!asset) return null;
      return { url: dataUris.get(asset.path), width: asset.width, height: asset.height };
    },
  };

  let failures = 0;
  for (const [name, markdown] of FIXTURES) {
    const expected = renderWithPython(markdown);
    const actual = RKF.markdown.render(markdown, options);
    if (normalise(expected) === normalise(actual)) {
      console.log(`  ok    ${name}`);
      continue;
    }
    failures += 1;
    console.log(`  FAIL  ${name}`);
    const shorten = (html) => normalise(html).replace(/data:image\/[^"]{40,}/g, "data:image/...");
    console.log(`        python: ${shorten(expected)}`);
    console.log(`        browser: ${shorten(actual)}`);
  }
  console.log(`\n${FIXTURES.length - failures}/${FIXTURES.length} fixtures match`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error("harness error:", err);
  process.exit(2);
});
