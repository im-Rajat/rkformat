/**
 * Tests for the Markdown source highlighter.
 *
 *     node tests/test_highlight.js
 *
 * The editors show colour by putting a highlighted layer behind a transparent textarea. That
 * only holds together if the layer's text is character-for-character identical to the
 * textarea's - one missing `#` and a line wraps differently, after which every line below is
 * offset. So the invariant under test is not "does it look right" but:
 *
 *     textContent(highlight(x)) === x
 *
 * Colour is checked too, but loosely: a mis-coloured emphasis run is cosmetic, losing a
 * character is not.
 */

"use strict";

const path = require("path");
require(path.join(path.resolve(__dirname, ".."), "docs/assets/highlight.js"));

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : `  :: ${detail}`}`);
  }
}

/** The text a browser would show for this HTML: tags removed, entities decoded. */
function textContent(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const SAMPLES = [
  ["heading", "# Title\n## Sub\n###### Six\n"],
  ["heading no text", "#\n##\n"],
  ["emphasis", "*em* **strong** ***both*** ~~struck~~ _u_ __b__\n"],
  ["intraword underscore", "snake_case_name and a_b_c\n"],
  ["code span", "Use `rk info` and ``a ` b`` here.\n"],
  ["link", "[text](https://example.com) and ![alt](assets/x.png)\n"],
  ["autolink", "See <https://example.com> now.\n"],
  ["reference definition", "[label]: https://example.com\n"],
  ["bullet list", "- one\n* two\n+ three\n"],
  ["ordered list", "1. one\n2) two\n"],
  ["task list", "- [ ] open\n- [x] done\n- [X] upper\n"],
  ["nested list", "- outer\n  - inner\n    - deeper\n"],
  ["blockquote", "> quoted\n>> nested\n> - list in quote\n"],
  ["fenced code", "```python\nprint('hi')\n# not a heading\n```\n"],
  ["tilde fence", "~~~\nplain\n~~~\n"],
  ["unclosed fence", "```\nstill code\n"],
  ["indented code", "    indented\n"],
  ["hr", "---\n***\n___\n"],
  ["setext", "Title\n=====\n\nOther\n-----\n"],
  ["table", "| a | b |\n| --- | --: |\n| 1 | 2 |\n"],
  ["html", '<div align="center">x</div>\n<img src="a.png" width="20"/>\n'],
  ["entities", "AT&T and 5 < 6 and > that\n"],
  ["angle brackets", "a <b> c </b> d\n"],
  ["backslash", "\\*not emphasis\\* and \\\\ literal\n"],
  ["long url", "- Go: https://dta.example.com/job/DT-SFI/job/dr-devops/job/master/build?delay=0sec\n"],
  ["bold label", "- **DEPLOYMENT_TYPE**: nr_dashboards\n"],
  ["unicode", "café 你好 🚀 — em dash\n"],
  ["tabs", "\tindented with tab\n- \ttab after bullet\n"],
  ["trailing spaces", "line one  \nline two\n"],
  ["blank lines", "a\n\n\n\nb\n"],
  ["empty", ""],
  ["only newlines", "\n\n\n"],
  ["asterisk soup", "*** ** * *** ** *\n"],
  ["unbalanced", "**bold with no close\n*em with no close\n`code with no close\n"],
  ["pipes in text", "a | b | c without a table\n"],
  ["deployment doc",
    "# temp\n\n# Deployment & Logs\n\n## Deployment Dashboard Deployment :\n\n" +
    "- Go DT-SFI/dr-devops -> master: https://dta.example.com/job/x/build?delay=0sec\n" +
    "- **DEPLOYMENT_TYPE**: nr_dashboards\n- **APPLICATION**: payment_services\n" +
    "- **DESTROY**: NO\n\n## Splunk Queries\n\n" +
    "- General : `index=\"aws\" source=\"aws_firehose\" log_group=\"/ecs/x\"`\n\n" +
    "**Note: Logs only go back 90 days**\n"],
];

console.log("--- text is preserved exactly (the alignment invariant) ---");
//
// The output carries exactly one newline more than the input. That is deliberate: a trailing
// newline in a block does not produce a final empty line on its own, so the layer would come
// out one line shorter than the textarea. Asserting the exact relationship rather than
// trimming both sides keeps the check honest about trailing blank lines, which matter for
// alignment just as much as the rest.
for (const [name, source] of SAMPLES) {
  const html = RKF.highlight.markdown(source);
  const recovered = textContent(html);
  const expected = source.replace(/\r\n?/g, "\n") + "\n";
  const same = recovered === expected;
  check(
    name,
    same,
    same ? "" : `\n      want: ${JSON.stringify(expected)}\n      got:  ${JSON.stringify(recovered)}`
  );
}

console.log("--- no sentinel characters leak into the output ---");
for (const [name, source] of SAMPLES) {
  const html = RKF.highlight.markdown(source);
  check(`${name}: clean`, !/[\uE000\uE001]/.test(html), JSON.stringify(html.slice(0, 80)));
}

console.log("--- markup is escaped, never executable ---");
{
  const html = RKF.highlight.markdown('<script>alert(1)</script>\n<img src=x onerror=y>\n');
  check("no live script tag", !/<script/i.test(html.replace(/<span[^>]*>/g, "")), html.slice(0, 120));
  check("angle brackets escaped", html.includes("&lt;script&gt;"), html.slice(0, 120));
  const quoted = RKF.highlight.markdown('a "b" c\n');
  check("quotes are left alone", textContent(quoted).includes('"b"'));
}

console.log("--- tokens actually get applied ---");
const EXPECT = [
  ["# Title\n", "tok-heading"],
  ["**bold**\n", "tok-strong"],
  ["*em*\n", "tok-em"],
  ["~~struck~~\n", "tok-strike"],
  ["`code`\n", "tok-code"],
  ["[t](u)\n", "tok-link"],
  ["[t](u)\n", "tok-url"],
  ["![a](u)\n", "tok-alt"],
  ["- item\n", "tok-marker"],
  ["- [ ] task\n", "tok-task"],
  ["> quote\n", "tok-quote"],
  ["```js\nx\n```\n", "tok-lang"],
  ["```js\nx\n```\n", "tok-code"],
  ["<div>x</div>\n", "tok-tag"],
  ["| a | b |\n", "tok-marker"],
];
for (const [source, cls] of EXPECT) {
  const html = RKF.highlight.markdown(source);
  check(`${JSON.stringify(source.split("\n")[0])} -> ${cls}`, html.includes(cls), html.slice(0, 100));
}

console.log("--- a heading inside a fence is not a heading ---");
{
  const html = RKF.highlight.markdown("```\n# not a heading\n```\n");
  check("fenced content stays code", !html.includes("tok-heading"), html);
  const after = RKF.highlight.markdown("```\nx\n```\n# real heading\n");
  check("headings resume after the fence", after.includes("tok-heading"), after);
}

console.log("--- size ---");
{
  const big = "# Heading\n\nSome **text** with `code`.\n\n".repeat(2000);
  const started = process.hrtime.bigint();
  const html = RKF.highlight.markdown(big);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  check(`a ${Math.round(big.length / 1024)} KB document highlights in ${ms.toFixed(0)} ms`, ms < 2000, ms);
  check("and is still character-exact", textContent(html) === big + "\n");
}

console.log(`\n${failures === 0 ? "all" : failures} highlighter check(s) ${failures ? "FAILED" : "passed"}`);
process.exit(failures ? 1 : 0);
