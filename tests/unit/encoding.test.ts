import assert from "node:assert/strict";
import test from "node:test";
import iconv from "iconv-lite";
import { detectSource, encodeForEdit, encodeSource, sourceFile, EDITABLE_FILE_BYTES } from "../../src/project-reader/encoding.js";

const roundTrip = (name: string, bytes: Buffer, encoding: string, text: string) => test(`${name} is detected and re-encodes byte-identically`, () => {
  const detected = detectSource(bytes);
  assert.equal(detected.encoding, encoding, name);
  assert.equal(detected.text, text, name);
  assert.equal(encodeSource(detected.text!, detected.encoding!).equals(bytes), true, `${name} round trip`);
});
test("UTF-8 without BOM round trips", () => roundTrip("plain UTF-8", Buffer.from("const 值 = 1;\n", "utf8"), "utf8", "const 值 = 1;\n"));
test("UTF-8 with BOM round trips and keeps the BOM", () => roundTrip("UTF-8 BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("bom 文本\n", "utf8")]), "utf8-bom", "bom 文本\n"));
test("UTF-16LE with BOM round trips", () => roundTrip("UTF-16LE", iconv.encode("\uFEFFle 文本\n", "utf16le"), "utf16le", "le 文本\n"));
test("UTF-16BE with BOM round trips", () => roundTrip("UTF-16BE", iconv.encode("\uFEFFbe 文本\n", "utf16be"), "utf16be", "be 文本\n"));
test("UTF-16 without BOM is detected from the code-unit layout", () => {
  const le = detectSource(Buffer.from("no bom here\n", "utf16le"));
  assert.equal(le.encoding, "utf16le");
  assert.equal(le.text, "no bom here\n");
  const be = detectSource(iconv.encode("no bom here\n", "utf16be"));
  assert.equal(be.encoding, "utf16be");
  assert.equal(be.text, "no bom here\n");
});
test("GB18030 round trips", () => roundTrip("GB18030", iconv.encode("{\"键\": \"中文值\"}\n", "gb18030"), "gb18030", "{\"键\": \"中文值\"}\n"));
test("legacy code page text is readable and editable in its own encoding", () => {
  const original = iconv.encode("第一行\n第二行\n", "gb18030");
  const file = sourceFile("config.json", original);
  assert.equal(file.encoding, "gb18030");
  const edited = encodeForEdit("config.json", "第一行\n改过的第二行\n", file.encoding!);
  assert.equal(iconv.decode(edited, "gb18030"), "第一行\n改过的第二行\n");
  assert.equal(detectSource(edited).encoding, "gb18030", "an edit must not silently migrate the file to UTF-8");
  assert.equal(edited.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false, "no BOM is invented");
});
test("BOM-less UTF-16 that is byte-ambiguous with GB18030 stays opaque", () => {
  // Every code unit is a CJK ideograph, so both code pages decode losslessly and
  // re-encode identically. Being wrong here silently rewrites every character.
  const cjk = Buffer.from("814e824e834e844e854e864e874e884e894e8a4e", "hex");
  assert.equal(iconv.decode(cjk, "utf16le"), "亁亂亃亄亅了亇予争亊");
  assert.equal(iconv.encode("亁亂亃亄亅了亇予争亊", "utf16le").equals(cjk), true, "the bytes are valid nonsense-free UTF-16");
  const detected = detectSource(cjk);
  assert.equal(detected.encoding, null, `ambiguous bytes must not be labelled ${String(detected.encoding)}`);
  assert.equal(detected.text, null);
  assert.equal(detected.bytes.equals(cjk), true, "the bytes are preserved exactly");
  assert.throws(() => encodeForEdit("ambiguous.txt", "亁亂亃亄亅了亇予争亊", "gb18030"), /original encoding|unrecognized|not decodable/i);
  // A no-BOM UTF-16 file with ASCII content keeps its unambiguous ASCII layout.
  const mixed = Buffer.from("le 你好\n", "utf16le");
  assert.equal(detectSource(mixed).encoding, "utf16le");
});
test("real GB18030 JSON from a Windows tool is still read as GB18030", () => {
  const source = "{\n  \"ok\": true,\n  \"引擎\": \"本地 ASR\",\n  \"结果\": [1, 2, 3]\n}\n";
  const bytes = iconv.encode(source, "gb18030");
  const detected = detectSource(bytes);
  assert.equal(detected.encoding, "gb18030");
  assert.equal(detected.text, source);
  assert.equal(encodeSource(detected.text!, "gb18030").equals(bytes), true);
});
test("text the original encoding cannot represent is rejected before any write", () => {
  const file = sourceFile("only-latin.json", Buffer.from("{\"a\": 1}\n", "utf8"));
  // U+1F600 exists in GB18030, so use an encoding-specific case: UTF-16BE text is
  // representable everywhere, but a lone surrogate is not valid text at all.
  assert.throws(() => encodeForEdit("only-latin.json", "text with \u0000 nul", file.encoding!), /Binary content/);
  assert.throws(() => encodeForEdit("only-latin.json", "text with \ud800 lone surrogate", file.encoding!), /original encoding/);
});
test("opaque bytes are preserved and never treated as UTF-8", () => {
  const blobs: Record<string, Buffer> = {
    PNG: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
    ZIP: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x21, 0x00, 0x8a, 0x9c, 0x2a, 0x5f]),
    "GZIP with GB18030-looking header": Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x07]),
    "NUL-dense data": Buffer.from([0x41, 0x00, 0x42, 0x00, 0x00, 0x00, 0x00, 0x00, 0x43, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x80, 0x81])
  };
  for (const [name, bytes] of Object.entries(blobs)) {
    const detected = detectSource(bytes);
    assert.equal(detected.encoding, null, name);
    assert.equal(detected.text, null, name);
    assert.equal(detected.bytes.equals(bytes), true, `${name} bytes stay untouched`);
    assert.equal(detected.bytes.length, bytes.length, `${name} length is preserved`);
  }
});
test("the editable-file budget matches the snapshot's per-file budget instead of being smaller", () => {
  // A file the snapshot can copy but the editor refuses to touch is a limit nobody
  // chose, so these two numbers must move together: 32 MiB per file by default.
  assert.equal(EDITABLE_FILE_BYTES, 32 * 1024 * 1024);
});
