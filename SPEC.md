# RK Format (`.rkf`) — Specification v1.0

A single-file compound document: **Markdown text + its embedded binary assets**, in one
shareable file. Send the `.rkf` and the images travel with it — no broken links, no
separate image folder.

## 1. Design goals

1. **Self-contained.** One file carries text and every image it references.
2. **No size penalty.** Images are stored as raw bytes, not base64. File size grows by
   roughly the true size of the assets.
3. **Graceful degradation.** The text payload is *unmodified CommonMark*. Rename the file
   to `.zip`, extract it, and `content.md` opens in any Markdown editor with working
   relative image links.
4. **Legible with no tooling.** The body is stored uncompressed and placed first, so the
   prose appears in the clear within the first few hundred bytes. Opened in Notepad, `less`,
   or a mail-client preview, a `.rkf` shows readable Markdown after a short header.
5. **Random access.** A viewer can read one image without parsing the whole document.
6. **Forward compatible.** Readers preserve entries they don't understand on round-trip.

## 2. Physical layout

An `.rkf` file is a **ZIP archive** (PKZIP, deflate). The extension `.rk` is an accepted
alias. Media type: `application/vnd.rkformat+zip`.

```
document.rkf
├── mimetype              # FIRST entry, STORED (uncompressed), no extra field
├── content.md            # SECOND entry, STORED — CommonMark body, the text payload
├── manifest.json         # document metadata + asset table
├── assets/               # binary payloads
│   ├── diagram.png
│   └── photo.jpg
└── meta/                 # OPTIONAL free-form sidecar data
```

Writers **should** emit members in that order, and **should** store the body uncompressed.
That is what makes design goal 4 hold: the prose lands within the first few hundred bytes
of the file, in the clear, so a plain text editor shows something readable. It costs a
little size on the text, which is negligible beside the images. Readers **must not** rely
on the ordering — a conforming document may list members in any order.

### 2.1 `mimetype`

Byte-for-byte `application/vnd.rkformat+zip`, no trailing newline. It **must** be the
first archive member and **must** be stored uncompressed. This places the literal string
at byte offset 38 of the file, so `file(1)`-style magic detection works without unzipping
(the same trick EPUB uses).

Detection rule:

```
bytes 0..3   == "PK\x03\x04"
bytes 30..37 == "mimetype"
bytes 38..   startswith "application/vnd.rkformat+zip"
```

### 2.2 `manifest.json`

UTF-8 JSON object.

```json
{
  "rkf_version": "1.0",
  "generator": "rkformat-py/0.1.0",
  "title": "Quarterly Review",
  "authors": ["rajatk0506@gmail.com"],
  "created": "2026-08-23T10:04:11Z",
  "modified": "2026-08-23T10:31:52Z",
  "content": "content.md",
  "assets": [
    {
      "id": "a1",
      "path": "assets/diagram.png",
      "media_type": "image/png",
      "bytes": 48213,
      "sha256": "9f86d0…",
      "width": 1280,
      "height": 720,
      "alt": "System diagram"
    }
  ],
  "extra": {}
}
```

| Field | Req | Meaning |
|---|---|---|
| `rkf_version` | yes | Spec version. `MAJOR.MINOR`. Readers reject unknown MAJOR. |
| `generator` | no | Tool that last wrote the file. |
| `title` | no | Display title. Falls back to filename. |
| `authors` | no | Array of strings. |
| `created` / `modified` | no | RFC 3339 UTC. |
| `content` | yes | Archive path of the Markdown body. Default `content.md`. |
| `assets` | yes | Array of asset records (may be empty). |
| `extra` | no | Reserved for application-specific keys. |

Asset record: `id` (unique, opaque), `path` (archive path, must live under `assets/`),
`media_type`, `bytes`, `sha256` (hex, of the raw bytes) are required. `width`, `height`,
`alt` are optional hints. Readers **must** treat the manifest as authoritative for
ordering and metadata, but the archive as authoritative for bytes.

### 2.3 `content.md`

CommonMark. Images are referenced by **archive-relative path**:

```markdown
![System diagram](assets/diagram.png)
```

This is the canonical form because it is what makes an extracted `.rkf` work as an
ordinary Markdown folder. An alternate, ID-based form is also valid and is resolved
against `manifest.assets[].id`:

```markdown
![System diagram](rkf:a1)
```

References that resolve to neither a manifest asset nor an archive member are **dangling**
and must be reported by `rk check`, not silently dropped.

### 2.4 Raw HTML in the body

CommonMark permits raw HTML, and documents use it - most often to size an image:

```html
<img src="assets/diagram.png" alt="drawing" width="200"/>
```

Renderers **must** treat an `<img>` in raw HTML exactly like Markdown image syntax: its
`src` is resolved against the asset table by the rules in section 2.3, and a `src` that
resolves to nothing is dangling.

Because a `.rkf` arrives from someone else, renderers **must not** pass author HTML through
untouched by default. The required default is to rebuild it from an allowlist of tags and
attributes, dropping anything else - script-bearing elements together with their contents,
event-handler attributes, and URL schemes other than `http`, `https`, `mailto`, `tel`,
`blob`, `data:image/*` and relative paths. A renderer may offer escaping (show the markup
as text) or pass-through as explicit opt-ins. `rkformat.sanitize` and
`docs/assets/sanitize.js` are the reference implementations.

## 3. Integrity rules

A document is **valid** when all of the following hold:

- `mimetype`, `manifest.json` and the `content` file all exist.
- Every `assets[]` record has a corresponding archive member.
- Every asset's actual byte length and SHA-256 match its record.
- No two assets share an `id` or a `path`.
- Every asset `path` is under `assets/`, is normalised (no `..`, no absolute paths, no
  backslashes), and is unique case-insensitively.
- Every image reference in `content.md` resolves.

Orphan assets (present in the archive but unreferenced by `content.md`) are **legal** — a
draft may hold images not yet placed. `rk check` reports them as informational.

## 4. Security requirements

Readers **must**:

- Reject archive member names that are absolute, contain `..` segments, or contain
  backslashes (zip-slip).
- Enforce a decompression ratio ceiling and an absolute uncompressed-size ceiling before
  extracting (zip bomb). Reference limits: 100× ratio, 512 MiB total.
- Sniff asset content and refuse a mismatch between magic bytes and declared
  `media_type`. Never trust the extension.
- Treat `content.md` as untrusted text. Renderers must not execute embedded HTML/script
  by default.

## 5. Compression policy

Writers choose per member:

- `mimetype` is always **stored** (required by section 2.1).
- The content file is **stored**, so the body is readable without decompression
  (section 2, design goal 4).
- `manifest.json` is **deflated**.
- Assets whose media type is already entropy-coded — `image/jpeg`, `image/webp`,
  `image/avif`, `image/heic`, `image/gif` — are **stored**. Deflating them costs CPU on
  every save and returns under 1%.
- Any other asset is **probed**: deflate the first 128 KiB and keep compression only if it
  saves at least 5%. PNG needs this rather than a fixed rule — its IDAT stream is already
  deflated, but with a 32 KiB window, so a large flat image still has long-range
  redundancy an outer pass catches. Measured range on real files: 1% (photographic) to 66%
  (flat gradient).

Readers must handle any valid ZIP compression method regardless of what a writer chose.
This policy affects file size and write cost only, never correctness.

## 6. Determinism

Writers should emit reproducible archives: fixed ZIP timestamps (`1980-01-01 00:00:00`),
stable member ordering (`mimetype`, `manifest.json`, content, then assets sorted by path),
and sorted JSON keys. Two documents with identical content then produce byte-identical
files, which makes checksums and content-addressed storage useful. Wall-clock time lives
in `manifest.modified`, not in ZIP headers.

## 7. Versioning

- MINOR bump: additive, optional fields. Old readers must ignore unknown JSON keys and
  preserve unknown archive members when re-saving.
- MAJOR bump: breaking. Readers must refuse a MAJOR they don't implement.

## 8. Not in v1.0

Deliberately deferred: revision history, encryption, non-image assets with rich typing
(video/audio work today, they're just assets), rich-text styling beyond Markdown,
comments/annotations, and the flat single-file text-safe variant (base64 MIME multipart)
for text-only channels.
