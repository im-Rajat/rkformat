/* GENERATED COPY - do not edit.
 *
 * Source of truth: docs/assets/rkf.js. Re-run docs/build.py after changing it.
 * Inlined into the output of `rk share`.
 */
/**
 * Client-side .rkf reader.
 *
 * A .rkf is a ZIP, and a browser can open one unaided: the central directory gives random
 * access, DecompressionStream('deflate-raw') handles deflated members, and WebCrypto
 * verifies the SHA-256 in the manifest. So the viewer needs no server and no dependencies.
 *
 * Mirrors the rules in SPEC.md — sections 3 (integrity) and 4 (security) in particular.
 */

(function (global) {
  "use strict";

  const MIMETYPE = "application/vnd.rkformat+zip";
  const MANIFEST = "manifest.json";
  const MIMETYPE_MEMBER = "mimetype";
  const ASSET_DIR = "assets";
  const SPEC_MAJOR = "1";

  // SPEC.md section 4 ceilings.
  const MAX_TOTAL_UNCOMPRESSED = 512 * 1024 * 1024;
  const MAX_COMPRESSION_RATIO = 100;
  const RATIO_FLOOR = 64 * 1024;

  const utf8 = new TextDecoder("utf-8");

  class RkfError extends Error {}

  // ------------------------------------------------------------------ ZIP layer

  function findEndOfCentralDirectory(view) {
    // The EOCD sits at the end, possibly behind a comment of up to 65535 bytes.
    const limit = Math.min(view.byteLength, 65557);
    for (let i = view.byteLength - 22; i >= view.byteLength - limit; i -= 1) {
      if (i < 0) break;
      if (view.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  }

  function readCentralDirectory(buffer) {
    const view = new DataView(buffer);
    const eocd = findEndOfCentralDirectory(view);
    if (eocd < 0) {
      throw new RkfError("not a ZIP archive - no end-of-central-directory record found");
    }
    const count = view.getUint16(eocd + 10, true);
    const size = view.getUint32(eocd + 12, true);
    let offset = view.getUint32(eocd + 16, true);
    if (offset === 0xffffffff || size === 0xffffffff || count === 0xffff) {
      throw new RkfError("ZIP64 archives are not supported by this viewer");
    }

    const entries = [];
    for (let i = 0; i < count; i += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) {
        throw new RkfError(`corrupt central directory at entry ${i + 1} of ${count}`);
      }
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      entries.push({
        name: utf8.decode(new Uint8Array(buffer, offset + 46, nameLength)),
        method: view.getUint16(offset + 10, true),
        compressedSize: view.getUint32(offset + 20, true),
        size: view.getUint32(offset + 24, true),
        localOffset: view.getUint32(offset + 42, true),
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== "function") {
      throw new RkfError(
        "this browser cannot decompress ZIP members (DecompressionStream is unavailable)"
      );
    }
    const stream = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readMember(buffer, entry) {
    const view = new DataView(buffer);
    if (view.getUint32(entry.localOffset, true) !== 0x04034b50) {
      throw new RkfError(`corrupt local header for ${entry.name}`);
    }
    const nameLength = view.getUint16(entry.localOffset + 26, true);
    const extraLength = view.getUint16(entry.localOffset + 28, true);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const raw = new Uint8Array(buffer, start, entry.compressedSize);
    if (entry.method === 0) return raw.slice();
    if (entry.method === 8) return inflateRaw(raw);
    throw new RkfError(`unsupported compression method ${entry.method} for ${entry.name}`);
  }

  function enforceLimits(entries) {
    let total = 0;
    for (const entry of entries) {
      total += entry.size;
      if (total > MAX_TOTAL_UNCOMPRESSED) {
        throw new RkfError(
          `uncompressed size exceeds the ${Math.round(
            MAX_TOTAL_UNCOMPRESSED / 1048576
          )} MiB limit`
        );
      }
      if (
        entry.size > RATIO_FLOOR &&
        entry.compressedSize > 0 &&
        entry.size / entry.compressedSize > MAX_COMPRESSION_RATIO
      ) {
        throw new RkfError(
          `member ${entry.name} has a ${Math.round(
            entry.size / entry.compressedSize
          )}x compression ratio (limit ${MAX_COMPRESSION_RATIO}x)`
        );
      }
    }
  }

  /** SPEC.md section 4: reject traversal instead of sanitising it. */
  function isSafeMemberName(name) {
    if (!name || name !== name.trim()) return false;
    if (name.includes("\\")) return false;
    if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
    return !name.split("/").some((part) => part === "" || part === "." || part === "..");
  }

  // -------------------------------------------------------------- image sniffing

  /** Media type from magic bytes. Ported from rkformat/imageinfo.py. */
  function sniffMediaType(bytes) {
    const at = (offset, ...signature) =>
      signature.every((byte, i) => bytes[offset + i] === byte);
    const ascii = (offset, text) =>
      [...text].every((ch, i) => bytes[offset + i] === ch.charCodeAt(0));

    if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
    if (at(0, 0xff, 0xd8)) return "image/jpeg";
    if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
    if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
    if (at(0, 0x42, 0x4d)) return "image/bmp";
    // TIFF: "II" + 0x2a 0x00 (little-endian) or "MM" + 0x00 0x2a (big-endian).
    if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return "image/tiff";
    if (ascii(4, "ftyp")) {
      const brand = utf8.decode(bytes.subarray(8, 12));
      if (brand === "avif" || brand === "avis") return "image/avif";
      if (["heic", "heix", "heim", "heis", "hevc", "mif1", "msf1"].includes(brand)) {
        return "image/heic";
      }
    }
    const head = utf8.decode(bytes.subarray(0, 512)).trimStart();
    if (head.startsWith("<?xml") || head.startsWith("<svg") || head.includes("<svg")) {
      return "image/svg+xml";
    }
    return null;
  }

  /**
   * Pixel dimensions from the magic bytes. Ported from rkformat/imageinfo.py.
   *
   * Done by hand rather than via createImageBitmap so it stays synchronous and testable
   * outside a browser, and so it agrees with what the Python library records.
   */
  function imageSize(bytes, mediaType) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const none = { width: null, height: null };
    try {
      if (mediaType === "image/png") {
        if (bytes.byteLength >= 24 && utf8.decode(bytes.subarray(12, 16)) === "IHDR") {
          return { width: view.getUint32(16), height: view.getUint32(20) };
        }
        return none;
      }
      if (mediaType === "image/jpeg") {
        // Walk the segment chain to the start-of-frame marker, which carries the size.
        const SOF = new Set([
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
        ]);
        let pos = 2;
        while (pos + 3 < bytes.byteLength) {
          if (bytes[pos] !== 0xff) {
            pos += 1; // resync past padding
            continue;
          }
          const marker = bytes[pos + 1];
          if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            pos += 2;
            continue;
          }
          if (marker === 0xd9 || marker === 0xda) break;
          const length = view.getUint16(pos + 2);
          if (SOF.has(marker) && pos + 9 <= bytes.byteLength) {
            return { height: view.getUint16(pos + 5), width: view.getUint16(pos + 7) };
          }
          if (length < 2) break;
          pos += 2 + length;
        }
        return none;
      }
      if (mediaType === "image/gif") {
        if (bytes.byteLength >= 10) {
          return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
        }
        return none;
      }
      if (mediaType === "image/webp") {
        const chunk = utf8.decode(bytes.subarray(12, 16));
        if (chunk === "VP8 " && bytes.byteLength >= 30) {
          return {
            width: view.getUint16(26, true) & 0x3fff,
            height: view.getUint16(28, true) & 0x3fff,
          };
        }
        if (chunk === "VP8L" && bytes.byteLength >= 25) {
          const bits = view.getUint32(21, true);
          return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        }
        if (chunk === "VP8X" && bytes.byteLength >= 30) {
          const read24 = (offset) =>
            bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
          return { width: read24(24) + 1, height: read24(27) + 1 };
        }
        return none;
      }
      if (mediaType === "image/bmp") {
        if (bytes.byteLength >= 26) {
          return {
            width: Math.abs(view.getInt32(18, true)),
            height: Math.abs(view.getInt32(22, true)),
          };
        }
        return none;
      }
      if (mediaType === "image/svg+xml") {
        const head = utf8.decode(bytes.subarray(0, 4096));
        const dimensions = {};
        for (const match of head.matchAll(/(width|height)\s*=\s*["']\s*([0-9.]+)/gi)) {
          const name = match[1].toLowerCase();
          if (dimensions[name] === undefined) dimensions[name] = parseFloat(match[2]);
        }
        if (dimensions.width !== undefined && dimensions.height !== undefined) {
          return { width: Math.trunc(dimensions.width), height: Math.trunc(dimensions.height) };
        }
        const box = /viewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i.exec(head);
        if (box) {
          return { width: Math.trunc(parseFloat(box[1])), height: Math.trunc(parseFloat(box[2])) };
        }
        return none;
      }
    } catch (err) {
      return none; // truncated or malformed header; the manifest simply omits the size
    }
    return none; // TIFF, AVIF and HEIC need a real decoder
  }

  // ------------------------------------------------------------------ references

  /** Blank out code spans and fences, preserving offsets. Mirrors container._mask_code. */
  function maskCode(text) {
    let out = text.replace(
      /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[^\S\n]*$/gm,
      (block) => block.replace(/[^\n]/g, " ")
    );
    out = out.replace(/`+[^`\n]+`+/g, (span) => " ".repeat(span.length));
    return out;
  }

  const INLINE_IMAGE = /!\[(?:[^\]\\]|\\.)*\]\(\s*([^)\s]+)/g;
  const REFERENCE_DEF = /^[ \t]{0,3}\[[^\]]+\]:\s*(\S+)/gm;
  const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

  function isExternal(target) {
    return /^(https?:|data:|mailto:|\/\/)/i.test(String(target).trim());
  }

  function findReferences(markdown) {
    const masked = maskCode(markdown);
    const found = [];
    for (const pattern of [INLINE_IMAGE, REFERENCE_DEF, HTML_IMAGE]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(masked)) !== null) {
        found.push({ target: match[1], index: match.index });
      }
    }
    return found.sort((a, b) => a.index - b.index);
  }

  // -------------------------------------------------------------------- document

  class RkfDocument {
    constructor(bytes) {
      this.bytes = bytes;
      this.fileSize = bytes.byteLength;
      this.markdown = "";
      this.manifest = null;
      this.assets = [];
      this.problems = [];
      // Findings that describe the container rather than the text; see revalidate().
      this.integrityProblems = [];
      this.extras = [];
      this.storedSizes = new Map();
      this._blobs = new Map(); // archive path -> Uint8Array
      this._urls = new Map(); // archive path -> blob: URL
    }

    get title() {
      if (this.manifest && this.manifest.title) return this.manifest.title;
      const heading = /^#\s+(.+?)\s*$/m.exec(this.markdown);
      return heading ? heading[1] : "Untitled";
    }

    get assetBytesTotal() {
      return this.assets.reduce((sum, asset) => sum + asset.bytes, 0);
    }

    get assetStoredTotal() {
      return this.assets.reduce(
        (sum, asset) => sum + (this.storedSizes.get(asset.path) || asset.bytes),
        0
      );
    }

    get storedTotal() {
      let total = 0;
      for (const size of this.storedSizes.values()) total += size;
      return total;
    }

    /** Resolve a Markdown link target onto an embedded asset, or null. */
    resolve(target) {
      let candidate = String(target || "")
        .trim()
        .replace(/^</, "")
        .replace(/>$/, "");
      if (!candidate || isExternal(candidate)) return null;
      candidate = candidate.split("#")[0].split("?")[0];
      if (/^rkf:/i.test(candidate)) {
        const id = candidate.slice(4);
        return this.assets.find((asset) => asset.id === id) || null;
      }
      for (const form of [candidate, safeDecode(candidate)]) {
        const cleaned = form.replace(/^\.?\//, "");
        const direct = this.assets.find((asset) => asset.path === cleaned);
        if (direct) return direct;
        if (!cleaned.includes("/")) {
          const inDir = this.assets.find((asset) => asset.path === `${ASSET_DIR}/${cleaned}`);
          if (inDir) return inDir;
        }
      }
      return null;
    }

    assetBytes(asset) {
      return this._blobs.get(asset.path) || null;
    }

    /** A blob: URL for an asset, created once and reused. */
    assetUrl(asset) {
      if (this._urls.has(asset.path)) return this._urls.get(asset.path);
      const payload = this.assetBytes(asset);
      if (!payload) return null;
      const url = URL.createObjectURL(new Blob([payload], { type: asset.media_type }));
      this._urls.set(asset.path, url);
      return url;
    }

    async assetDataUri(asset) {
      const payload = this.assetBytes(asset);
      if (!payload) return null;
      let binary = "";
      const chunk = 0x8000; // chunked, or String.fromCharCode blows the stack on big images
      for (let i = 0; i < payload.length; i += chunk) {
        binary += String.fromCharCode.apply(null, payload.subarray(i, i + chunk));
      }
      return `data:${asset.media_type};base64,${btoa(binary)}`;
    }

    orphanAssets() {
      const used = new Set();
      for (const reference of findReferences(this.markdown)) {
        const asset = this.resolve(reference.target);
        if (asset) used.add(asset.id);
      }
      return this.assets.filter((asset) => !used.has(asset.id));
    }

    // ---------------------------------------------------------------- mutation

    /** Lowest unused `aN` identifier. Mirrors Manifest.next_id in manifest.py. */
    nextId() {
      const used = new Set(this.assets.map((asset) => asset.id));
      let n = 1;
      while (used.has(`a${n}`)) n += 1;
      return `a${n}`;
    }

    /** An `assets/<name>` path that collides with nothing, case-insensitively. */
    uniquePath(filename) {
      const dot = String(filename).lastIndexOf(".");
      let stem = dot > 0 ? filename.slice(0, dot) : filename;
      let extension = dot > 0 ? filename.slice(dot + 1) : "";
      stem = stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "image";
      extension = extension.replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
      const taken = new Set(this.assets.map((asset) => asset.path.toLowerCase()));
      for (let n = 0; ; n += 1) {
        const suffix = n === 0 ? "" : `-${n}`;
        const candidate = `${ASSET_DIR}/${stem}${suffix}${extension ? `.${extension}` : ""}`;
        if (!taken.has(candidate.toLowerCase())) return candidate;
      }
    }

    /**
     * Embed image bytes, returning the asset record.
     *
     * Identical bytes are stored once: assets are keyed by SHA-256, same as the Python
     * library, so pasting the same screenshot twice does not double the file size.
     */
    async addImageBytes(bytes, filename, alt) {
      const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (!payload.length) throw new RkfError(`${filename}: empty image payload`);
      const mediaType = sniffMediaType(payload);
      if (mediaType === null) {
        throw new RkfError(`${filename}: not a recognised image`);
      }
      const digest = await sha256Hex(payload);
      const existing = this.assets.find((asset) => digest && asset.sha256 === digest);
      if (existing) return existing;

      const info = imageSize(payload, mediaType);
      const asset = {
        id: this.nextId(),
        path: this.uniquePath(filename || "image.png"),
        media_type: mediaType,
        bytes: payload.length,
        sha256: digest || "",
        width: info.width,
        height: info.height,
        alt: alt || null,
        verified: true,
      };
      this._blobs.set(asset.path, payload);
      this.assets.push(asset);
      return asset;
    }

    /** Drop an asset by id, path, or filename. Optionally strip its references too. */
    removeAsset(ref, options = {}) {
      const asset =
        this.assets.find((a) => a.id === ref) ||
        this.assets.find((a) => a.path === ref) ||
        this.assets.find((a) => a.path === `${ASSET_DIR}/${ref}`) ||
        this.assets.find((a) => a.path.split("/").pop() === ref);
      if (!asset) throw new RkfError(`no such asset: ${ref}`);
      this.assets = this.assets.filter((a) => a !== asset);
      this._blobs.delete(asset.path);
      const url = this._urls.get(asset.path);
      if (url) {
        URL.revokeObjectURL(url);
        this._urls.delete(asset.path);
      }
      if (options.pruneRefs) {
        const targets = [asset.path, asset.path.split("/").pop(), `rkf:${asset.id}`]
          .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|");
        this.markdown = this.markdown.replace(
          new RegExp(`[ \\t]*!\\[(?:[^\\]\\\\]|\\\\.)*\\]\\(\\s*(?:${targets})[^)]*\\)[ \\t]*\\n?`, "g"),
          ""
        );
      }
      return asset;
    }

    /**
     * Recompute the problems that depend on the body text.
     *
     * Integrity findings - a bad checksum, a missing payload, a media type that does not
     * match the bytes - are established once when the file is read and cannot change by
     * editing prose, so they are kept aside and merged back in here. Rebuilding the whole
     * list from scratch would silently drop them.
     */
    revalidate() {
      this.problems = (this.integrityProblems || []).slice();
      for (const reference of findReferences(this.markdown)) {
        if (isExternal(reference.target)) continue;
        if (!this.resolve(reference.target)) {
          this.problems.push({
            severity: "error",
            message: `dangling image reference: ${reference.target}`,
          });
        }
      }
      for (const asset of this.orphanAssets()) {
        this.problems.push({
          severity: "info",
          message: `asset ${asset.id} (${asset.path}) is never referenced`,
        });
      }
      return this.problems;
    }

    /** Release blob: URLs. Call before dropping a document. */
    dispose() {
      for (const url of this._urls.values()) URL.revokeObjectURL(url);
      this._urls.clear();
    }
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (err) {
      return value;
    }
  }

  async function sha256Hex(bytes) {
    if (!global.crypto || !global.crypto.subtle) return null; // insecure context
    const digest = await global.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Parse a .rkf from an ArrayBuffer.
   *
   * Reads leniently and reports problems rather than refusing outright: someone opening a
   * file in a viewer wants to see what is wrong with it, not a blank page. Only structural
   * failures - not a ZIP, no manifest, wrong major version - throw.
   */
  async function open(buffer) {
    const entries = readCentralDirectory(buffer);
    enforceLimits(entries);

    for (const entry of entries) {
      if (!isSafeMemberName(entry.name)) {
        throw new RkfError(`unsafe archive member name: ${JSON.stringify(entry.name)}`);
      }
    }

    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const doc = new RkfDocument(new Uint8Array(buffer));
    for (const entry of entries) doc.storedSizes.set(entry.name, entry.compressedSize);

    // Section 2.1: the mimetype member must come first and be stored uncompressed.
    const first = entries[0];
    if (!first || first.name !== MIMETYPE_MEMBER) {
      doc.problems.push({
        severity: "warning",
        message: `the first archive member should be "${MIMETYPE_MEMBER}"`,
      });
    }
    const mimetypeEntry = byName.get(MIMETYPE_MEMBER);
    if (!mimetypeEntry) {
      doc.problems.push({ severity: "warning", message: "no mimetype member" });
    } else {
      const declared = utf8.decode(await readMember(buffer, mimetypeEntry)).trim();
      if (declared !== MIMETYPE) {
        doc.problems.push({
          severity: "warning",
          message: `mimetype is ${JSON.stringify(declared)}, expected ${JSON.stringify(
            MIMETYPE
          )}`,
        });
      }
    }

    const manifestEntry = byName.get(MANIFEST);
    if (!manifestEntry) throw new RkfError(`not a .rkf document - no ${MANIFEST}`);
    let manifest;
    try {
      manifest = JSON.parse(utf8.decode(await readMember(buffer, manifestEntry)));
    } catch (err) {
      throw new RkfError(`${MANIFEST} is not valid JSON: ${err.message}`);
    }
    const version = String(manifest.rkf_version || "");
    if (!version) throw new RkfError(`${MANIFEST} is missing rkf_version`);
    if (version.split(".")[0] !== SPEC_MAJOR) {
      throw new RkfError(
        `this document declares .rkf version ${version}; this viewer implements ${SPEC_MAJOR}.x`
      );
    }
    doc.manifest = manifest;

    const contentName = String(manifest.content || "content.md");
    const contentEntry = byName.get(contentName);
    if (!contentEntry) {
      throw new RkfError(
        `the manifest points at content ${JSON.stringify(contentName)}, which is missing`
      );
    }
    doc.markdown = utf8.decode(await readMember(buffer, contentEntry));

    const known = new Set([MIMETYPE_MEMBER, MANIFEST, contentName]);
    const records = Array.isArray(manifest.assets) ? manifest.assets : [];
    const seenIds = new Set();
    const seenPaths = new Set();

    for (const record of records) {
      const asset = {
        id: String(record.id),
        path: String(record.path),
        media_type: String(record.media_type || ""),
        bytes: Number(record.bytes) || 0,
        sha256: String(record.sha256 || ""),
        width: record.width == null ? null : Number(record.width),
        height: record.height == null ? null : Number(record.height),
        alt: record.alt == null ? null : String(record.alt),
        verified: null,
      };
      known.add(asset.path);

      if (seenIds.has(asset.id)) {
        doc.problems.push({ severity: "error", message: `duplicate asset id ${asset.id}` });
      }
      seenIds.add(asset.id);
      if (seenPaths.has(asset.path.toLowerCase())) {
        doc.problems.push({
          severity: "error",
          message: `duplicate asset path ${asset.path}`,
        });
      }
      seenPaths.add(asset.path.toLowerCase());

      const entry = byName.get(asset.path);
      if (!entry) {
        doc.problems.push({
          severity: "error",
          message: `asset ${asset.id} (${asset.path}) has no bytes in the archive`,
        });
        doc.assets.push(asset);
        continue;
      }

      const payload = await readMember(buffer, entry);
      doc._blobs.set(asset.path, payload);

      if (payload.byteLength !== asset.bytes) {
        doc.problems.push({
          severity: "error",
          message: `asset ${asset.id}: manifest says ${asset.bytes} bytes, archive holds ${payload.byteLength}`,
        });
      }
      const digest = await sha256Hex(payload);
      if (digest === null) {
        asset.verified = null; // no WebCrypto in this context
      } else if (digest !== asset.sha256) {
        asset.verified = false;
        doc.problems.push({
          severity: "error",
          message: `asset ${asset.id}: sha256 mismatch (corrupt payload)`,
        });
      } else {
        asset.verified = true;
      }

      const sniffed = sniffMediaType(payload);
      if (sniffed === null) {
        doc.problems.push({
          severity: "error",
          message: `asset ${asset.id}: payload is not a recognised image`,
        });
      } else if (sniffed !== asset.media_type) {
        doc.problems.push({
          severity: "error",
          message: `asset ${asset.id}: declared ${asset.media_type}, bytes are ${sniffed}`,
        });
      }
      doc.assets.push(asset);
    }

    for (const entry of entries) {
      if (known.has(entry.name) || entry.name.endsWith("/")) continue;
      doc.extras.push(entry.name);
      // Keep the bytes, not just the name: SPEC.md section 2 requires a reader to preserve
      // members it does not understand when it writes the document back out.
      doc._blobs.set(entry.name, await readMember(buffer, entry));
      if (entry.name.startsWith(`${ASSET_DIR}/`)) {
        doc.problems.push({
          severity: "warning",
          message: `${entry.name} is in the archive but not in manifest.assets`,
        });
      }
    }

    // Everything found so far describes the container itself. Snapshot it, so that editing
    // the body later cannot make a corrupt asset look clean.
    doc.integrityProblems = doc.problems.slice();

    for (const reference of findReferences(doc.markdown)) {
      if (isExternal(reference.target)) continue;
      if (!doc.resolve(reference.target)) {
        doc.problems.push({
          severity: "error",
          message: `dangling image reference: ${reference.target}`,
        });
      }
    }
    for (const asset of doc.orphanAssets()) {
      doc.problems.push({
        severity: "info",
        message: `asset ${asset.id} (${asset.path}) is never referenced`,
      });
    }

    return doc;
  }

  /** Start an empty document, for "new file" in an editor. */
  function create(options = {}) {
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const doc = new RkfDocument(new Uint8Array(0));
    doc.manifest = {
      rkf_version: "1.0",
      generator: "rkformat-web/0.1.0",
      title: options.title || null,
      authors: options.authors || [],
      created: now,
      modified: now,
      content: "content.md",
      assets: [],
    };
    doc.markdown = options.markdown || "";
    return doc;
  }

  /** Magic-byte probe, per SPEC.md section 2.1 - cheap enough to run before parsing. */
  function looksLikeRkf(bytes) {
    const head = utf8.decode(bytes.subarray(0, 38 + MIMETYPE.length));
    return (
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      bytes[2] === 0x03 &&
      bytes[3] === 0x04 &&
      head.slice(30, 38) === MIMETYPE_MEMBER &&
      head.slice(38).startsWith(MIMETYPE)
    );
  }

  global.RKF = Object.assign(global.RKF || {}, {
    open,
    create,
    RkfDocument,
    sha256Hex,
    looksLikeRkf,
    findReferences,
    sniffMediaType,
    imageSize,
    isExternal,
    RkfError,
    MIMETYPE,
    SPEC_MAJOR,
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
