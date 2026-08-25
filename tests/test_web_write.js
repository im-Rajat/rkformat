/**
 * Cross-implementation test for the browser's .rkf writer.
 *
 *     node tests/test_web_write.js
 *
 * Writing a container is where two implementations quietly diverge, so this does not check
 * the JavaScript against itself. It writes documents with docs/assets/rkfwrite.js and hands
 * them to the Python `rk` CLI - if `rk check` verifies every checksum and `rk cat` returns
 * the body, the two agree on the format.
 *
 * Needs `rk` on PATH, or RK_COMMAND set (e.g. RK_COMMAND="python3 -m rkformat").
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
require(path.join(root, "docs/assets/rkf.js"));
require(path.join(root, "docs/assets/rkfwrite.js"));

const RK = (process.env.RK_COMMAND || "rk").split(" ");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "rkf-web-write-"));

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : `  :: ${detail}`}`);
  }
}

function rk(args, options = {}) {
  return execFileSync(RK[0], [...RK.slice(1), ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

/** A deterministic PNG, built the same way the Python fixtures are. */
function png(width, height, rgb = [40, 90, 160]) {
  const zlib = require("zlib");
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = rgb[0];
      row[2 + x * 3] = rgb[1];
      row[3 + x * 3] = rgb[2];
    }
    rows.push(row);
  }
  const chunk = (tag, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(tag), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32Fallback(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ])
  );
}

function crc32Fallback(buffer) {
  return RKF.writeInternals.crc32(new Uint8Array(buffer));
}

/** Bytes -> a file the CLI can open. */
function writeFile(name, bytes) {
  const target = path.join(work, name);
  fs.writeFileSync(target, Buffer.from(bytes));
  return target;
}

(async () => {
  console.log("--- a document written in the browser, verified by the Python CLI ---");
  {
    const doc = RKF.create({ title: "Written in a browser", authors: ["web"] });
    const gradient = await doc.addImageBytes(png(320, 180), "gradient.png", "A gradient");
    const chart = await doc.addImageBytes(png(200, 120, [200, 120, 60]), "chart.png");
    doc.markdown =
      "# Written in a browser\n\n" +
      "Body text with **bold** and a [link](https://example.com).\n\n" +
      `![A gradient](${gradient.path})\n\n` +
      "- [x] task done\n- [ ] task open\n\n" +
      `<img src="${chart.path}" alt="sized" width="120"/>\n`;

    const file = writeFile("browser.rkf", await RKF.serialize(doc));

    let checkOutput = "";
    let checkFailed = false;
    try {
      checkOutput = rk(["check", file]);
    } catch (error) {
      checkFailed = true;
      checkOutput = String(error.stdout || "") + String(error.stderr || "");
    }
    check("`rk check` accepts it", !checkFailed && /^OK/m.test(checkOutput), checkOutput.trim());
    check(
      "both assets verified by the Python reader",
      /2 asset\(s\) verified/.test(checkOutput),
      checkOutput.trim()
    );

    const body = rk(["cat", file]);
    check("the body survives byte for byte", body === doc.markdown, JSON.stringify(body.slice(0, 80)));

    const listed = JSON.parse(rk(["ls", file, "--json"]));
    check("both assets are listed", listed.length === 2, listed.length);
    check(
      "dimensions were recorded correctly",
      listed.some((a) => a.width === 320 && a.height === 180) &&
        listed.some((a) => a.width === 200 && a.height === 120),
      JSON.stringify(listed.map((a) => [a.path, a.width, a.height]))
    );

    const info = rk(["info", file]);
    check("the title round-trips", /Written in a browser/.test(info), info);

    const rendered = JSON.parse(rk(["export-json", file]));
    check(
      "the Python renderer resolves the images",
      (rendered.html.match(/data:image\/png;base64,/g) || []).length >= 2,
      (rendered.html.match(/data:image/g) || []).length
    );
    check("task list rendered by Python", /type="checkbox"/.test(rendered.html));
    check('the HTML <img width="120"> survived', /width="120"/.test(rendered.html));
  }

  console.log("--- spec conformance of the bytes ---");
  {
    const doc = RKF.create({ title: "Layout" });
    await doc.addImageBytes(png(64, 64), "a.png");
    doc.markdown = "# Layout\n\nA distinctive sentence.\n";
    const bytes = await RKF.serialize(doc);
    const file = writeFile("layout.rkf", bytes);

    const raw = Buffer.from(bytes);
    check(
      "magic bytes identify it as .rkf (section 2.1)",
      raw.subarray(0, 4).toString("binary") === "PK\x03\x04" &&
        raw.subarray(30, 38).toString() === "mimetype" &&
        raw.subarray(38, 38 + 28).toString() === "application/vnd.rkformat+zip",
      raw.subarray(30, 70).toString()
    );
    check(
      "the body is legible in a plain text editor (design goal 4)",
      raw.includes(Buffer.from("A distinctive sentence.")) &&
        raw.indexOf(Buffer.from("A distinctive sentence.")) < 512,
      raw.indexOf(Buffer.from("A distinctive sentence."))
    );

    const members = rk(["unpack", file, "-d", path.join(work, "unpacked"), "--force"]);
    check("`rk unpack` explodes it to a folder", /unpacked into/.test(members), members.trim());
    check(
      "the unpacked folder is ordinary Markdown",
      fs.existsSync(path.join(work, "unpacked", "content.md")) &&
        fs.existsSync(path.join(work, "unpacked", "assets", "a.png")),
      fs.readdirSync(path.join(work, "unpacked")).join(",")
    );

    // Identical content must give identical bytes. `modified` is wall-clock and deliberately
    // outside that guarantee, so it is pinned rather than stripped: the manifest is deflated,
    // so a timestamp cannot be edited out of the finished archive - an earlier version of
    // this check tried, and failed only when the two calls straddled a second boundary.
    const pinned = { ...doc, manifest: { ...doc.manifest } };
    Object.setPrototypeOf(pinned, Object.getPrototypeOf(doc));
    const first = await RKF.serialize(pinned, { touch: false });
    const second = await RKF.serialize(pinned, { touch: false });
    check(
      "serialisation is reproducible (section 6)",
      Buffer.from(first).equals(Buffer.from(second)),
      `${first.length} vs ${second.length} bytes`
    );
    check(
      "touch:false leaves the recorded timestamp alone",
      pinned.manifest.modified === doc.manifest.modified,
      `${pinned.manifest.modified} vs ${doc.manifest.modified}`
    );
  }

  console.log("--- reading back what we wrote ---");
  {
    const doc = RKF.create({ title: "Round trip" });
    const asset = await doc.addImageBytes(png(48, 24), "img.png", "Alt text");
    doc.markdown = `# Round trip\n\n![Alt text](${asset.path})\n`;
    const bytes = await RKF.serialize(doc);

    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const reopened = await RKF.open(buffer);
    check("the JS reader accepts the JS writer's output", reopened.assets.length === 1);
    check("the body matches", reopened.markdown === doc.markdown);
    check("the title matches", reopened.title === "Round trip", reopened.title);
    check("checksums verify", reopened.assets[0].verified === true);
    check("no validation problems", reopened.problems.length === 0, JSON.stringify(reopened.problems));
    check("alt text survived", reopened.assets[0].alt === "Alt text", reopened.assets[0].alt);
  }

  console.log("--- duplicate images are stored once ---");
  {
    const doc = RKF.create({});
    const bytes = png(32, 32);
    const first = await doc.addImageBytes(bytes, "one.png");
    const second = await doc.addImageBytes(bytes, "two.png");
    check("identical bytes reuse the same asset", first === second, `${first.path} vs ${second.path}`);
    check("only one asset recorded", doc.assets.length === 1, doc.assets.length);
  }

  console.log("--- unknown members survive a save ---");
  {
    const doc = RKF.create({ title: "Extras" });
    doc.markdown = "# Extras\n";
    const original = await RKF.serialize(doc);
    const file = writeFile("extras.rkf", original);
    // Add a member the reader does not understand, using Python's zipfile.
    execFileSync("python3", [
      "-c",
      "import sys, zipfile\n"
        + "with zipfile.ZipFile(sys.argv[1], 'a') as z: z.writestr('meta/future.json', '{\"from\":\"a newer writer\"}')",
      file,
    ]);
    const reloaded = await RKF.open(
      (() => {
        const raw = fs.readFileSync(file);
        return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      })()
    );
    check("the unknown member was noticed", reloaded.extras.includes("meta/future.json"), reloaded.extras);
    const resaved = writeFile("extras2.rkf", await RKF.serialize(reloaded));
    const listing = execFileSync("python3", [
      "-c",
      "import sys, zipfile; print(' '.join(zipfile.ZipFile(sys.argv[1]).namelist()))",
      resaved,
    ]).toString();
    check("and it is still there after saving", listing.includes("meta/future.json"), listing.trim());
  }

  console.log("--- removing an asset ---");
  {
    const doc = RKF.create({});
    const asset = await doc.addImageBytes(png(16, 16), "gone.png");
    doc.markdown = `Before\n\n![x](${asset.path})\n\nAfter\n`;
    doc.removeAsset(asset.id, { pruneRefs: true });
    check("the asset is gone", doc.assets.length === 0);
    check("its reference is gone too", !doc.markdown.includes(asset.path), doc.markdown);
    check("surrounding text is intact", /Before/.test(doc.markdown) && /After/.test(doc.markdown));
    const file = writeFile("removed.rkf", await RKF.serialize(doc));
    let ok = true;
    try {
      rk(["check", file]);
    } catch (error) {
      ok = false;
    }
    check("the result still validates", ok);
  }

  fs.rmSync(work, { recursive: true, force: true });
  console.log(
    `\n${failures === 0 ? "all" : failures} web-writer check(s) ${failures ? "FAILED" : "passed"}`
  );
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error("harness error:", error);
  process.exit(2);
});
