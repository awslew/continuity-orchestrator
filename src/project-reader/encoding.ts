import { createHash } from "node:crypto";
import iconv from "iconv-lite";
import { ReaderError } from "./service.js";

/** Windows projects are not always UTF-8. Older tooling writes GB18030 (Chinese
 * ANSI code page) or UTF-16 with or without a BOM. Treating every byte sequence
 * as UTF-8 made whole snapshots fail, so decode decisions are explicit here and
 * the original bytes always remain the unit of comparison and of truth. */
export type SourceEncoding = "utf8" | "utf8-bom" | "utf16le" | "utf16be" | "gb18030";
/** null means opaque bytes: preserved exactly, never edited as text. */
export type DetectedEncoding = SourceEncoding | null;

export type SourceBytes = { bytes: Buffer; encoding: DetectedEncoding; text: string | null };
export type SourceFile = SourceBytes & { path: string; sha256: string };

/** The largest text file this service will read or edit. It matches the default
 * snapshot per-file budget on purpose: a file the snapshot can copy but the editor
 * refuses to touch would be a limit nobody chose, and the honest ceiling for editing
 * a file is the size of the file, not a number picked to keep payloads small.
 * Everything here is a memory budget, never a policy on how much work one round
 * may do. The READER's own read limit is deliberately smaller and separate: it bounds
 * one read's allocation and keeps a search page from being consumed by one huge
 * generated file, so raising it is not the same decision as raising this one. */
export const EDITABLE_FILE_BYTES = 32 * 1024 * 1024;
const GB = "gb18030";

const BOMS: { encoding: SourceEncoding; bytes: Buffer }[] = [
  { encoding: "utf8-bom", bytes: Buffer.from([0xef, 0xbb, 0xbf]) },
  { encoding: "utf16le", bytes: Buffer.from([0xff, 0xfe]) },
  { encoding: "utf16be", bytes: Buffer.from([0xfe, 0xff]) }
];
const startsWith = (bytes: Buffer, prefix: Buffer) => bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix);

/** Binary containers must never be interpreted as legacy text code pages, even
 * when their header happens to decode. */
const MAGIC: Buffer[] = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("GIF87a", "latin1"), Buffer.from("GIF89a", "latin1"),
  Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.from([0x1f, 0x8b]), Buffer.from([0x42, 0x5a, 0x68]),
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf]), Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a]), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("MZ", "latin1"), Buffer.from([0xca, 0xfe, 0xba, 0xbe]), Buffer.from([0x00, 0x61, 0x73, 0x6d]),
  Buffer.from("%PDF-", "latin1"), Buffer.from("SQLite format 3\u0000", "latin1"), Buffer.from("RIFF", "latin1"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0]),
  Buffer.from([0x4f, 0x67, 0x67, 0x53]), Buffer.from("ID3", "latin1"), Buffer.from("OggS", "latin1"), Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
];
const isBinaryMagic = (bytes: Buffer) => MAGIC.some(magic => startsWith(bytes, magic));

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf16le = new TextDecoder("utf-16le", { fatal: false });
const utf16be = new TextDecoder("utf-16be", { fatal: false });
const REPLACEMENT = "\uFFFD";
/** Legacy code pages can decode arbitrary bytes into replacement characters.
 * Anything that poor is binary data wearing a text code page, not source text. */
const MAX_REPLACEMENT_RATIO = 0.02;

const countReplacements = (text: string) => {
  let total = 0;
  for (const character of text) if (character === REPLACEMENT) total++;
  return total;
};
const nullRatio = (text: string) => text.length === 0 ? 1 : [...text].filter(character => character === "\u0000").length / text.length;
/** Real UTF-16 text carries at most a stray NUL; NUL-dense output is binary data
 * that happens to satisfy the byte-pattern heuristic. */
const MAX_NULL_RATIO = 0.35;
const MAX_NULLS = 1;
const textLike = (text: string, minimum: number) => text.length >= minimum && nullRatio(text) <= MAX_NULL_RATIO && [...text].filter(c => c === "\u0000").length <= MAX_NULLS;

/** iconv-lite round trip: decoding is only trusted when re-encoding reproduces
 * the exact original bytes. This separates real GB18030 text from binary data
 * that merely happens to decode, without guessing from file extensions. */
function viaCodePage(bytes: Buffer, encoding: "gb18030" | "utf16le" | "utf16be"): { text: string; lossless: boolean } | null {
  try {
    const text = iconv.decode(bytes, encoding);
    return { text, lossless: iconv.encode(text, encoding).equals(bytes) };
  } catch { return null; }
}
function utf8Decode(bytes: Buffer): string | null {
  try { return utf8.decode(bytes); } catch { return null; }
}
/** Classic no-BOM UTF-16 heuristic: ASCII-heavy content puts zero bytes on one
 * side of every code unit. Requires a strong majority and a lossless round trip. */
function utf16WithoutBom(bytes: Buffer): SourceEncoding | null {
  if (bytes.length < 4 || bytes.length % 2 !== 0) return null;
  const units = bytes.length / 2;
  let oddZero = 0, evenZero = 0;
  for (let index = 0; index < bytes.length; index += 2) {
    if (bytes[index] === 0) evenZero++;
    if (bytes[index + 1] === 0) oddZero++;
  }
  const order = oddZero / units >= 0.6 ? "utf16le" : evenZero / units >= 0.6 ? "utf16be" : null;
  if (!order) return null;
  const decoded = viaCodePage(bytes, order);
  if (!decoded || !decoded.lossless || !textLike(decoded.text, 2)) return null;
  return order;
}
/** A no-BOM UTF-16 file whose every code unit is a CJK ideograph is byte-ambiguous
 * with GB18030: both decode losslessly and re-encode identically. Nothing can
 * recover the author's intent from the bytes alone, so such a file must stay
 * opaque instead of being served under a code page that silently misreads it. */
function cjkUtf16Candidate(bytes: Buffer): SourceEncoding | null {
  if (bytes.length < 8 || bytes.length % 2 !== 0) return null;
  const units = bytes.length / 2;
  let le = 0, be = 0;
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    const little = bytes[index]! | bytes[index + 1]! << 8;
    const big = bytes[index]! << 8 | bytes[index + 1]!;
    if (little >= 0x3400 && little <= 0x9fff) le++;
    if (big >= 0x3400 && big <= 0x9fff) be++;
  }
  if (le / units >= 0.7) return "utf16le";
  if (be / units >= 0.7) return "utf16be";
  return null;
}

/** Detection order: BOM, then strict UTF-8, then no-BOM UTF-16, then GB18030.
 * Everything else stays opaque bytes and is preserved byte for byte. */
export function detectSource(bytes: Buffer): SourceBytes {
  for (const bom of BOMS) if (startsWith(bytes, bom.bytes)) {
    if (bom.encoding === "utf8-bom") {
      const text = utf8Decode(bytes.subarray(bom.bytes.length));
      if (text !== null) return { bytes, encoding: "utf8-bom", text };
      continue;
    }
    const decoded = viaCodePage(bytes.subarray(bom.bytes.length), bom.encoding === "utf16le" ? "utf16le" : "utf16be");
    if (decoded && textLike(decoded.text, 1)) return { bytes, encoding: bom.encoding, text: decoded.text };
  }
  const direct = utf8Decode(bytes);
  if (direct !== null && !direct.includes("\u0000")) return { bytes, encoding: "utf8", text: direct };
  if (isBinaryMagic(bytes)) return { bytes, encoding: null, text: null };
  const noBom = utf16WithoutBom(bytes);
  if (noBom) {
    const decoded = viaCodePage(bytes, noBom === "utf16le" ? "utf16le" : "utf16be")!;
    return { bytes, encoding: noBom, text: decoded.text };
  }
  // Pure ASCII never reaches the legacy branch: strict UTF-8 already accepted it,
  // so encoding decisions for plain files stay stable across runs.
  if (bytes.some(byte => byte >= 0x80)) {
    const legacy = viaCodePage(bytes, GB);
    if (legacy && legacy.lossless && countReplacements(legacy.text) / Math.max(1, legacy.text.length) <= MAX_REPLACEMENT_RATIO) {
      // Refuse the code page when the same bytes read as UTF-16 are an unbroken run
      // of CJK text: editing under this label would replace every character.
      if (cjkUtf16Candidate(bytes)) return { bytes, encoding: null, text: null };
      return { bytes, encoding: GB, text: legacy.text };
    }
  }
  return { bytes, encoding: null, text: null };
}

/** Re-encoding is the only place a modification may choose a code page, and it
 * always reuses the encoding the file arrived with. */
export function encodeSource(text: string, encoding: SourceEncoding): Buffer {
  switch (encoding) {
    case "utf8": return Buffer.from(text, "utf8");
    case "utf8-bom": return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
    case "utf16le": return withBom(text, "utf16le");
    case "utf16be": return withBom(text, "utf16be");
    case "gb18030": return iconv.encode(text, GB);
  }
}
/** Decoding strips the BOM into the encoding label, so re-encoding must add it
 * back explicitly and exactly once. */
function withBom(text: string, encoding: "utf16le" | "utf16be"): Buffer {
  const mark = encoding === "utf16le" ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xfe, 0xff]);
  return Buffer.concat([mark, iconv.encode(text, encoding)]);
}
export const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export const sourceFile = (path: string, bytes: Buffer): SourceFile => ({ path, ...detectSource(bytes), sha256: sha256(bytes) });
export const textSource = (file: SourceFile) => file.encoding !== null && file.text !== null;
/** Editing requires decodable text; opaque bytes stay readable only as bytes. */
export function requireTextSource(path: string, file: SourceFile, action: string): { text: string; encoding: SourceEncoding } {
  if (!textSource(file)) throw new ReaderError("FILE_TYPE", `${action} requires decodable text; ${path} is binary or an unrecognized encoding and is preserved byte for byte`);
  return { text: file.text!, encoding: file.encoding! };
}
export function encodeForEdit(path: string, text: string, encoding: SourceEncoding): Buffer {
  if (text.includes("\u0000")) throw new ReaderError("FILE_TYPE", "Binary content is excluded");
  const bytes = encodeSource(text, encoding);
  const roundTrip = detectSource(bytes);
  if (roundTrip.encoding !== encoding || roundTrip.text !== text) {
    throw new ReaderError("FILE_ENCODING", `${path} cannot be represented in its original encoding (${encoding})`);
  }
  return bytes;
}
