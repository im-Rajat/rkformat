/**
 * Client-side .rkf writer.
 *
 * The reader in rkf.js showed a browser can open a .rkf unaided; this is the other half, so
 * the web editor can create and save documents with no server involved. `CompressionStream`
 * handles deflate, and the rest is ZIP structure written by hand - a few hundred bytes of
 * headers, which is cheaper than shipping a ZIP library.
 *
 * The output follows SPEC.md deliberately, not incidentally:
 *
 *   section 2    member order - mimetype, content.md, manifest.json, assets, extras
 *   section 2.1  mimetype first and STORED, so magic-byte detection works
 *   section 5    compression policy - the body STORED for plain-text legibility, and
 *                already-compressed image formats STORED rather than pointlessly deflated
 *   section 6    fixed timestamps and sorted keys, so identical content gives identical bytes
 *
 * `tests/test_web_write.js` writes documents here and validates them with the Python
 * `rk check`, which is the only way to be sure the two implementations agree.
 */

(function (global) {
  "use strict";

  const MIMETYPE = "application/vnd.rkformat+zip";
  const MIMETYPE_MEMBER = "mimetype";
  const MANIFEST_MEMBER = "manifest.json";

  // SPEC.md section 5: deflating these returns under 1%, so it is pure cost.
  const INCOMPRESSIBLE = new Set([
    "image/jpeg", "image/webp", "image/avif", "image/heic", "image/gif",
  ]);
  const COMPRESSION_PROBE = 128 * 1024;
  const MIN_COMPRESSION_GAIN = 0.05;

  // Fixed DOS timestamp (1980-01-01 00:00:00) for reproducible archives.
  const DOS_TIME = 0;
  const DOS_DATE = (1 << 5) | 1;

  const encoder = new TextEncoder();

  // -------------------------------------------------------------------- crc32

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // ------------------------------------------------------------------ deflate

  async function deflateRaw(bytes) {
    if (typeof CompressionStream !== "function") return null;
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /**
   * Decide whether deflate earns its keep, mirroring container._worth_deflating.
   *
   * PNG is the interesting case: its IDAT is already deflated but with a 32 KiB window, so a
   * large flat image still has long-range redundancy an outer pass catches. Measured range on
   * real files is 1% (photographic) to 66% (flat gradient), so it is probed rather than assumed.
   */
  async function worthDeflating(bytes, mediaType) {
    if (mediaType && INCOMPRESSIBLE.has(mediaType)) return false;
    if (bytes.length < 512) return true;
    const sample = bytes.subarray(0, COMPRESSION_PROBE);
    const probe = await deflateRaw(sample);
    if (!probe) return false;
    return probe.length < sample.length * (1 - MIN_COMPRESSION_GAIN);
  }

  // ------------------------------------------------------------------ zip write

  class ByteSink {
    constructor() {
      this.chunks = [];
      this.length = 0;
    }
    push(bytes) {
      this.chunks.push(bytes);
      this.length += bytes.length;
    }
    u16(value) {
      const out = new Uint8Array(2);
      new DataView(out.buffer).setUint16(0, value, true);
      this.push(out);
    }
    u32(value) {
      const out = new Uint8Array(4);
      new DataView(out.buffer).setUint32(0, value >>> 0, true);
      this.push(out);
    }
    concat() {
      const out = new Uint8Array(this.length);
      let offset = 0;
      for (const chunk of this.chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    }
  }

  /**
   * Assemble a ZIP from prepared members.
   *
   * Each member is {name, data, compress, mediaType}. Sizes are known upfront, so the local
   * headers carry them directly and no data descriptors are needed.
   */
  async function buildZip(members) {
    const prepared = [];
    for (const member of members) {
      const raw = member.data;
      let stored = raw;
      let method = 0;
      if (member.compress !== false && (await worthDeflating(raw, member.mediaType))) {
        const deflated = await deflateRaw(raw);
        if (deflated && deflated.length < raw.length) {
          stored = deflated;
          method = 8;
        }
      }
      prepared.push({
        name: encoder.encode(member.name),
        raw,
        stored,
        method,
        crc: crc32(raw),
      });
    }

    const body = new ByteSink();
    const offsets = [];
    for (const entry of prepared) {
      offsets.push(body.length);
      body.u32(0x04034b50); // local file header
      body.u16(entry.method === 8 ? 20 : 10); // version needed
      body.u16(0); // flags: sizes are known, so no data descriptor
      body.u16(entry.method);
      body.u16(DOS_TIME);
      body.u16(DOS_DATE);
      body.u32(entry.crc);
      body.u32(entry.stored.length);
      body.u32(entry.raw.length);
      body.u16(entry.name.length);
      body.u16(0); // extra field length
      body.push(entry.name);
      body.push(entry.stored);
    }

    const directory = new ByteSink();
    prepared.forEach((entry, index) => {
      directory.u32(0x02014b50); // central directory header
      directory.u16(20); // version made by
      directory.u16(entry.method === 8 ? 20 : 10);
      directory.u16(0);
      directory.u16(entry.method);
      directory.u16(DOS_TIME);
      directory.u16(DOS_DATE);
      directory.u32(entry.crc);
      directory.u32(entry.stored.length);
      directory.u32(entry.raw.length);
      directory.u16(entry.name.length);
      directory.u16(0); // extra
      directory.u16(0); // comment
      directory.u16(0); // disk number
      directory.u16(0); // internal attributes
      directory.u32(0o644 << 16); // external attributes
      directory.u32(offsets[index]);
      directory.push(entry.name);
    });

    const out = new ByteSink();
    out.push(body.concat());
    const directoryOffset = out.length;
    out.push(directory.concat());
    out.u32(0x06054b50); // end of central directory
    out.u16(0);
    out.u16(0);
    out.u16(prepared.length);
    out.u16(prepared.length);
    out.u32(directory.length);
    out.u32(directoryOffset);
    out.u16(0); // comment length
    return out.concat();
  }

  // ------------------------------------------------------------------ manifest

  /** JSON with sorted keys and two-space indent, matching the Python writer. */
  function stableJson(value) {
    const order = (input) => {
      if (Array.isArray(input)) return input.map(order);
      if (input && typeof input === "object") {
        const out = {};
        for (const key of Object.keys(input).sort()) {
          if (input[key] === undefined) continue;
          out[key] = order(input[key]);
        }
        return out;
      }
      return input;
    };
    return JSON.stringify(order(value), null, 2);
  }

  function assetRecord(asset) {
    const record = {
      id: asset.id,
      path: asset.path,
      media_type: asset.media_type,
      bytes: asset.bytes,
      sha256: asset.sha256,
    };
    if (asset.width != null) record.width = asset.width;
    if (asset.height != null) record.height = asset.height;
    if (asset.alt != null && asset.alt !== "") record.alt = asset.alt;
    return record;
  }

  function manifestJson(doc) {
    const source = doc.manifest || {};
    const out = { rkf_version: source.rkf_version || "1.0" };
    out.generator = "rkformat-web/0.1.0";
    if (source.title != null) out.title = source.title;
    if (Array.isArray(source.authors) && source.authors.length) out.authors = source.authors;
    if (source.created) out.created = source.created;
    out.modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    out.content = source.content || "content.md";
    out.assets = doc.assets
      .slice()
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map(assetRecord);
    if (source.extra && Object.keys(source.extra).length) out.extra = source.extra;
    return out;
  }

  /**
   * Serialise a document to .rkf bytes.
   *
   * Mutates `doc.manifest.modified`, since that is what was written.
   */
  async function serialize(doc) {
    const manifest = manifestJson(doc);
    doc.manifest = { ...(doc.manifest || {}), ...manifest };

    const contentName = manifest.content;
    const members = [
      { name: MIMETYPE_MEMBER, data: encoder.encode(MIMETYPE), compress: false },
      // The body goes second and uncompressed so the prose is legible in a plain text
      // editor (SPEC.md section 2, design goal 4).
      { name: contentName, data: encoder.encode(doc.markdown), compress: false },
      { name: MANIFEST_MEMBER, data: encoder.encode(stableJson(manifest)) },
    ];

    for (const asset of manifest.assets) {
      const payload = doc.assetBytes(asset) || doc._blobs.get(asset.path);
      if (!payload) throw new Error(`asset ${asset.id} (${asset.path}) has no bytes`);
      members.push({ name: asset.path, data: payload, mediaType: asset.media_type });
    }
    for (const name of doc.extras || []) {
      const payload = doc._blobs.get(name);
      if (payload) members.push({ name, data: payload });
    }

    return buildZip(members);
  }

  async function toBlob(doc) {
    return new Blob([await serialize(doc)], { type: MIMETYPE });
  }

  global.RKF = Object.assign(global.RKF || {}, {
    serialize,
    toBlob,
    writeInternals: { crc32, buildZip, stableJson, worthDeflating },
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
