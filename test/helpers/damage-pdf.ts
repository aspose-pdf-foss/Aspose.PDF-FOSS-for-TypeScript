// Programmatic damage applied to builder-made PDFs. Every function here must
// produce a file that Document.Open rejects today — see damage-helpers.test.ts.

// Byte <-> string round-tripping for these helpers must be exactly 1:1 over all
// 256 byte values, because a damaged fixture may contain DEFLATE data.
//
// Two traps, both hit during development:
//   - TextEncoder emits UTF-8, so any byte above 127 inflates to two bytes.
//   - TextDecoder('latin1') is a WHATWG alias for **windows-1252**, not
//     ISO-8859-1. Bytes 0x80-0x9F decode to characters like U+20AC, and mapping
//     back with `& 0xff` yields a different byte. Length is preserved, so the
//     corruption is silent.
// String.fromCharCode / charCodeAt is the mapping that actually is 1:1.
const asText = (pdf: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < pdf.length; i += 8192) {
    s += String.fromCharCode(...pdf.subarray(i, i + 8192));
  }
  return s;
};
const asBytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const enc = asBytes;

/** Point startxref at an offset past the end of the file. */
export function corruptStartxref(pdf: Uint8Array): Uint8Array {
  const text = asText(pdf);
  const i = text.lastIndexOf('startxref');
  if (i < 0) throw new Error('fixture has no startxref');
  const replaced = text.slice(0, i)
    + text.slice(i).replace(/startxref\s+\d+/, `startxref\n${pdf.length + 5000}`);
  return asBytes(replaced);
}

/** Overwrite the `trailer` keyword so the classic table reader never finds it. */
export function destroyTrailer(pdf: Uint8Array): Uint8Array {
  const text = asText(pdf);
  const i = text.lastIndexOf('trailer');
  if (i < 0) throw new Error('fixture has no trailer keyword');
  return asBytes(text.slice(0, i) + '#######' + text.slice(i + 7));
}

/** Overwrite the `xref` keyword that starts the classic table, leaving the
 *  `trailer` keyword and its dict intact. readXref cannot read the table, but a
 *  trailer still exists in the file for recovery to find. */
export function destroyXrefTable(pdf: Uint8Array): Uint8Array {
  const text = asText(pdf);
  const i = text.lastIndexOf('\nxref\n');
  if (i < 0) throw new Error('fixture has no classic xref table');
  return asBytes(`${text.slice(0, i + 1)}####${text.slice(i + 5)}`);
}

/** Prepend bytes, shifting every offset in the file by text.length.
 *  With { fixStartxref: true } the startxref value is corrected, so the xref
 *  still parses and only the object offsets are stale. */
export function prependBytes(
  pdf: Uint8Array, text: string, opts: { fixStartxref?: boolean } = {},
): Uint8Array {
  const shift = enc(text).length;
  let body = asText(pdf);
  if (opts.fixStartxref) {
    body = body.replace(/startxref\s+(\d+)/, (_m, n: string) =>
      `startxref\n${parseInt(n, 10) + shift}`);
  }
  return asBytes(text + body);
}

/** Overwrite an object's body in place with filler, preserving byte length so
 *  the xref stays valid and only that object fails to parse. */
export function corruptObjectBody(pdf: Uint8Array, objNum: number): Uint8Array {
  const text = asText(pdf);
  const start = text.search(new RegExp(`(^|\\s)${objNum} 0 obj`));
  if (start < 0) throw new Error(`fixture has no object ${objNum}`);
  const headerEnd = text.indexOf('obj', start) + 3;
  const end = text.indexOf('endobj', headerEnd);
  if (end < 0) throw new Error(`object ${objNum} has no endobj`);
  return asBytes(text.slice(0, headerEnd) + '#'.repeat(end - headerEnd) + text.slice(end));
}

/** Append a second, truncated copy of an object after %%EOF. The sweep finds
 *  both; the later one does not parse. */
export function appendTruncatedCopy(pdf: Uint8Array, objNum: number): Uint8Array {
  return asBytes(asText(pdf) + `\n${objNum} 0 obj\n<< /Type /Page /Parent `);
}

/** Cut bytes off the end, destroying the xref, the trailer and the last object. */
export function truncateTail(pdf: Uint8Array, bytes: number): Uint8Array {
  return pdf.subarray(0, Math.max(0, pdf.length - bytes));
}

/** Overwrite the tail of the first /ObjStm payload in place. Byte length is
 *  preserved, so every xref offset stays valid and the container is the only
 *  damage in the file — which is what makes an assertion about it an assertion
 *  about /ObjStm recovery rather than about the sweep. `keepFraction` is the
 *  share of the payload left intact. */
export function corruptObjStmPayload(pdf: Uint8Array, keepFraction = 0.6): Uint8Array {
  const text = asText(pdf);
  const t = text.indexOf('/ObjStm');
  if (t < 0) throw new Error('fixture has no /ObjStm');
  const kw = text.indexOf('stream', t);
  if (kw < 0) throw new Error('/ObjStm has no stream keyword');
  let start = kw + 'stream'.length;
  if (text[start] === '\r') start++;
  if (text[start] === '\n') start++;
  const end = text.indexOf('endstream', start);
  if (end < 0) throw new Error('/ObjStm has no endstream');
  const len = end - start;
  const keep = Math.max(1, Math.floor(len * keepFraction));
  return asBytes(text.slice(0, start + keep) + 'Z'.repeat(len - keep) + text.slice(end));
}

/** Append a second, complete catalog after %%EOF, as an incremental update
 *  would. The sweep finds both; `pagesNum` decides whether the new one has a
 *  walkable page tree. */
export function appendCatalog(
  pdf: Uint8Array, objNum: number, pagesNum: number,
): Uint8Array {
  return asBytes(
    `${asText(pdf)}\n${objNum} 0 obj\n<< /Type /Catalog /Pages ${pagesNum} 0 R >>\nendobj\n`,
  );
}
