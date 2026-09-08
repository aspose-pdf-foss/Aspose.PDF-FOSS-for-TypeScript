import { deflateSync } from 'node:zlib';
import { PdfObject, PdfDict, PdfRef, PdfStream, isRef, isDict, isArray, isStream, isString, isName, name, ref } from './types.js';
import { enc, serializeObject, serializeValue, serializeDict } from './serialize.js';
import { PdfParseError, UnsupportedFeatureError } from './errors.js';
import { buildEncryptor, Encryptor, EncryptOptions, PubSecEncryptOptions } from './encrypt.js';
import { buildPubSecEncryptor } from './pubsec.js';
import { randomBytes } from './crypto.js';
import {
  DEFAULT_PLACEHOLDER_BYTES, SignatureLayout,
  buildSigDictPlaceholder, finalizePlaceholder,
} from './sigplaceholder.js';
import { serializeLinearized } from './linearize.js';
import { applyStreamFilter, StreamFilterName } from './streamfilter.js';

export interface SerializeOptions {
  /** Emit a cross-reference stream + compressed object streams (ObjStm) instead
   *  of a classic xref table. Smaller for multi-object docs. Default: false. */
  compressed?: boolean;
  /** Encrypt the output: password-based standard handler ({@link EncryptOptions})
   *  or certificate-based PubSec ({@link PubSecEncryptOptions}). Default: plaintext. */
  encrypt?: EncryptOptions | PubSecEncryptOptions | false;
  /** Emit a linearized ("Fast Web View") layout (classic xref, plaintext only).
   *  Throws if combined with `compressed` or `encrypt`. Default: false. */
  linearized?: boolean;
  /** Re-encode eligible data streams with this byte-filter on Save. ASCII
   *  targets armor over existing compression (7-bit-clean output); LZW /
   *  RunLength replace it. Image-codec, XMP-metadata, and structural streams
   *  are left untouched. Not supported with `linearized`. */
  streamFilter?: StreamFilterName;
  /** Append an incremental update to the bytes the document was opened from,
   *  rather than rewriting it. Only the objects that changed are written, the
   *  original bytes are preserved verbatim, and object numbers are NOT
   *  renumbered. Requires a document opened from bytes; throws if combined
   *  with `compressed`, `encrypt`, `linearized` or `streamFilter`.
   *  Default: false. */
  incremental?: boolean;
}

/** Collect every PdfRef contained directly in `o` (dict values, array elements, stream-dict values). */
export function refsIn(o: PdfObject, out: PdfRef[]): void {
  if (isRef(o)) out.push(o);
  else if (isArray(o)) for (const v of o) refsIn(v, out);
  else if (isDict(o)) for (const v of o.values()) refsIn(v, out);
  else if (isStream(o)) for (const v of o.dict.values()) refsIn(v, out);
}

/** Deep-copy `o`, rewriting every ref's object number through `map` (gen reset to 0). */
function remap(o: PdfObject, map: Map<number, number>): PdfObject {
  if (isRef(o)) return ref(map.get(o.num) ?? o.num, 0);
  if (isArray(o)) return o.map((v) => remap(v, map));
  if (isDict(o)) {
    const d: PdfDict = new Map();
    for (const [k, v] of o) d.set(k, remap(v, map));
    return d;
  }
  if (isStream(o)) {
    const d: PdfDict = new Map();
    for (const [k, v] of o.dict) d.set(k, remap(v, map));
    return { kind: 'stream', dict: d, raw: o.raw };
  }
  return o;
}

export interface Plan {
  rootRef: PdfRef;
  infoRef: PdfObject;
  oldToNew: Map<number, number>;
  /** Remapped objects indexed by (newNumber - 1); length N. */
  objs: PdfObject[];
}

/** Mark reachable-from-/Root(+/Info), assign compact numbers 1..N (root first,
 *  then discovery order), and return the remapped object graph. */
export function planDocument(objects: Map<number, PdfObject>, trailer: PdfDict): Plan {
  const rootRef = trailer.get('Root');
  if (!isRef(rootRef)) throw new PdfParseError('cannot serialize: /Root is not an indirect reference');
  const infoRef = trailer.get('Info');

  const oldToNew = new Map<number, number>();
  const order: number[] = []; // old numbers, indexed by (newNumber - 1)
  const queue: number[] = [];
  const enqueue = (num: number): void => {
    if (oldToNew.has(num)) return;
    oldToNew.set(num, oldToNew.size + 1);
    order.push(num);
    queue.push(num);
  };
  enqueue(rootRef.num);
  if (isRef(infoRef)) enqueue(infoRef.num);
  while (queue.length) {
    const obj = objects.get(queue.shift()!);
    if (obj === undefined) continue;
    const refs: PdfRef[] = [];
    refsIn(obj, refs);
    for (const r of refs) if (objects.has(r.num)) enqueue(r.num);
  }

  const objs = order.map((old) => remap(objects.get(old)!, oldToNew));
  return { rootRef, infoRef: infoRef ?? null, oldToNew, objs };
}

/** Append `/Info`, `/ID` entries (if present) onto a trailer-like dict builder. */
function trailerExtras(plan: Plan, trailer: PdfDict, add: (key: string, value: string) => void): void {
  const { infoRef, oldToNew } = plan;
  if (isRef(infoRef) && oldToNew.has(infoRef.num)) add('Info', `${oldToNew.get(infoRef.num)} 0 R`);
  const id = trailer.get('ID');
  if (id !== undefined) add('ID', serializeValue(id));
}

/** Serialize the live object map to bytes. Default emits a classic xref table;
 *  `{ compressed: true }` emits a cross-reference stream + object streams.
 *  Does not mutate `objects` or `trailer` (remapping produces copies). */
export function serializeDocument(
  objects: Map<number, PdfObject>, trailer: PdfDict, options: SerializeOptions = {},
  /** The document's own encryptor, when it was opened encrypted: used when no
   *  explicit `encrypt` option is given, so encryption survives a rewrite
   *  instead of the file being written silently in the clear. */
  preserved?: Encryptor,
): Uint8Array {
  if (options.streamFilter && options.linearized)
    throw new UnsupportedFeatureError('streamFilter is not supported with linearized output');
  if (options.linearized) {
    if (options.compressed) throw new UnsupportedFeatureError('compressed linearization is not supported');
    if (options.encrypt) throw new UnsupportedFeatureError('encrypted linearization is not supported');
    return serializeLinearized(objects, trailer, headerVersion(objects, trailer));
  }
  const plan = planDocument(objects, trailer);
  if (options.streamFilter) applyStreamFilter(plan.objs, options.streamFilter);
  const ver = headerVersion(objects, trailer);
  // Precedence: an explicit `encrypt` wins; else the document's own retained
  // encryption; else plaintext. `encrypt: false` is how a caller asks for
  // plaintext from a document that was opened encrypted.
  const { id0, id1 } = resolveIds(trailer);
  const chosen: Encryptor | undefined = options.encrypt === false
    ? undefined
    : options.encrypt
      ? ('recipients' in options.encrypt
        ? buildPubSecEncryptor(options.encrypt)
        : buildEncryptor(options.encrypt, id0))
      : preserved;
  if (!chosen) {
    return options.compressed ? serializeCompressed(plan, trailer, ver) : serializeClassic(plan, trailer, ver);
  }
  return options.compressed
    ? serializeCompressedEncrypted(plan, trailer, chosen, id0, id1, ver)
    : serializeClassicEncrypted(plan, chosen, id0, id1, ver);
}

/** The header version to emit: catalog /Version when present, else 1.7. */
function headerVersion(objects: Map<number, PdfObject>, trailer: PdfDict): string {
  const root = trailer.get('Root');
  const cat = isRef(root) ? objects.get(root.num) : undefined;
  if (isDict(cat)) {
    const v = cat.get('Version');
    if (isName(v)) return v.name;
  }
  return '1.7';
}

export interface SignSerializeOptions {
  /** Object number (in the live `objects` map) of the signature value dictionary
   *  whose `/Contents`/`/ByteRange` must be emitted as a patchable placeholder. */
  signatureObj: number;
  /** Reserved capacity for the detached CMS, in bytes. Default 8192. */
  placeholderBytes?: number;
}

/** Sign-on-save (full-rewrite) serialization: emit a classic-xref document in
 *  which the signature value dictionary carries a fixed-size `/Contents`
 *  placeholder and a computed `/ByteRange`, ready to digest and fill. Used for
 *  the first signature on a new / authored / mutated document (no prior signed
 *  byte image to preserve). Compressed and encrypted output are unsupported —
 *  the signature `/Contents` must be a direct, unencrypted object. Does not
 *  mutate `objects` or `trailer` (remapping produces copies). */
export function serializeSignedDocument(
  objects: Map<number, PdfObject>, trailer: PdfDict, options: SignSerializeOptions & SerializeOptions,
): SignatureLayout {
  if (options.compressed)
    throw new UnsupportedFeatureError('sign-on-save does not support compressed output');
  if (options.encrypt)
    throw new UnsupportedFeatureError('sign-on-save does not support encrypted output');
  if (options.streamFilter)
    throw new UnsupportedFeatureError('sign-on-save does not support streamFilter');

  const plan = planDocument(objects, trailer);
  const sigNew = plan.oldToNew.get(options.signatureObj);
  if (sigNew === undefined)
    throw new PdfParseError('cannot sign: signature object is not reachable from /Root');
  const sigObj = plan.objs[sigNew - 1];
  if (!isDict(sigObj))
    throw new PdfParseError('cannot sign: signature object is not a dictionary');

  const placeholderBytes = options.placeholderBytes ?? DEFAULT_PLACEHOLDER_BYTES;
  const ph = buildSigDictPlaceholder(sigObj, placeholderBytes);
  return serializeClassicSigned(
    plan, trailer, sigNew, ph, placeholderBytes, headerVersion(objects, trailer));
}

/** Classic-xref serialization that emits object `sigNew` as a placeholder body. */
function serializeClassicSigned(
  plan: Plan, trailer: PdfDict, sigNew: number,
  ph: ReturnType<typeof buildSigDictPlaceholder>, placeholderBytes: number, ver = '1.7',
): SignatureLayout {
  const { rootRef, oldToNew, objs } = plan;
  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (b: Uint8Array): void => { chunks.push(b); length += b.length; };

  // The catalog /Version, exactly as every other write path emits it (909q).
  // This one hardcoded 1.7, so signing a converted document breached the very
  // version rule the conversion had just satisfied — a PDF/A-4 file demands
  // 2.n and a PDF/A-1 file forbids anything above 1.4. The header sits inside
  // the signed byte range, so it must be chosen HERE rather than patched after.
  push(enc(`%PDF-${ver}\n%âãÏÓ\n`));
  const n = objs.length;
  const offsets: number[] = new Array(n + 1).fill(0);
  let bodyStart = 0;
  for (let i = 0; i < n; i++) {
    const newNum = i + 1;
    offsets[newNum] = length;
    if (newNum === sigNew) {
      push(enc(`${newNum} 0 obj\n`));
      bodyStart = length;               // the dict body begins here
      push(enc(ph.body));
      push(enc('\nendobj\n'));
    } else {
      push(enc(`${newNum} 0 obj\n`));
      push(serializeObject(objs[i]));
      push(enc('\nendobj\n'));
    }
  }

  const xrefStart = length;
  let xref = `xref\n0 ${n + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= n; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(enc(xref));

  let tr = `trailer\n<< /Size ${n + 1} /Root ${oldToNew.get(rootRef.num)} 0 R`;
  trailerExtras(plan, trailer, (k, v) => { tr += ` /${k} ${v}`; });
  tr += ` >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  push(enc(tr));

  return finalizePlaceholder(concat(chunks), bodyStart, ph, placeholderBytes);
}

/** First/second /ID elements, generating random 16-byte values when absent. */
function resolveIds(trailer: PdfDict): { id0: Uint8Array; id1: Uint8Array } {
  const id = trailer.get('ID');
  const at = (i: number): Uint8Array | undefined => {
    if (isArray(id) && isString(id[i])) return (id[i] as { bytes: Uint8Array }).bytes;
    return undefined;
  };
  return { id0: at(0) ?? randomBytes(16), id1: at(1) ?? randomBytes(16) };
}

const pdfStr = (bytes: Uint8Array): PdfObject => ({ kind: 'string', bytes });

function concat(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Uint8Array(length);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

function serializeClassic(plan: Plan, trailer: PdfDict, ver = '1.7'): Uint8Array {
  const { rootRef, oldToNew, objs } = plan;
  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (b: Uint8Array): void => { chunks.push(b); length += b.length; };

  push(enc(`%PDF-${ver}\n%âãÏÓ\n`));
  const n = objs.length;
  const offsets: number[] = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) {
    const newNum = i + 1;
    offsets[newNum] = length;
    push(enc(`${newNum} 0 obj\n`));
    push(serializeObject(objs[i]));
    push(enc('\nendobj\n'));
  }

  const xrefStart = length;
  let xref = `xref\n0 ${n + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= n; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(enc(xref));

  let tr = `trailer\n<< /Size ${n + 1} /Root ${oldToNew.get(rootRef.num)} 0 R`;
  trailerExtras(plan, trailer, (k, v) => { tr += ` /${k} ${v}`; });
  tr += ` >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  push(enc(tr));

  return concat(chunks);
}

function serializeClassicEncrypted(
  plan: Plan, encryptor: Encryptor, id0: Uint8Array, id1: Uint8Array, ver = '1.7',
): Uint8Array {
  const { rootRef, oldToNew, objs } = plan;
  const n = objs.length;
  const encNum = n + 1;
  const encObjs = objs.map((o, i) => encryptor.encryptObject(o, i + 1, 0));

  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (b: Uint8Array): void => { chunks.push(b); length += b.length; };

  push(enc(`%PDF-${ver}\n%âãÏÓ\n`));
  const offsets = new Array(encNum + 1).fill(0);
  for (let i = 0; i < n; i++) {
    const num = i + 1;
    offsets[num] = length;
    push(enc(`${num} 0 obj\n`));
    push(serializeObject(encObjs[i]));
    push(enc('\nendobj\n'));
  }
  // /Encrypt dict — written verbatim, never encrypted
  offsets[encNum] = length;
  push(enc(`${encNum} 0 obj\n`));
  push(serializeObject(encryptor.encryptDict));
  push(enc('\nendobj\n'));

  const xrefStart = length;
  let xref = `xref\n0 ${encNum + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= encNum; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(enc(xref));

  let tr = `trailer\n<< /Size ${encNum + 1} /Root ${oldToNew.get(rootRef.num)} 0 R`;
  tr += ` /Encrypt ${encNum} 0 R /ID ${serializeValue([pdfStr(id0), pdfStr(id1)])}`;
  const infoRef = plan.infoRef;
  if (isRef(infoRef) && oldToNew.has(infoRef.num)) tr += ` /Info ${oldToNew.get(infoRef.num)} 0 R`;
  tr += ` >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  push(enc(tr));

  return concat(chunks);
}

function serializeCompressedEncrypted(
  plan: Plan, _trailer: PdfDict, encryptor: Encryptor, id0: Uint8Array, id1: Uint8Array, ver = '1.7',
): Uint8Array {
  const { rootRef, oldToNew, objs } = plan;
  const n = objs.length;
  const objStmNum = n + 1;
  const encNum = n + 2;
  const xrefStmNum = n + 3;
  const size = n + 4;

  // Partition: streams stay direct (and are individually encrypted); everything
  // else packs into the ObjStm and is left PLAINTEXT (protected by ObjStm crypto).
  const compressedNums: number[] = [];
  const directNums: number[] = [];
  for (let i = 0; i < n; i++) (isStream(objs[i]) ? directNums : compressedNums).push(i + 1);

  // Build the plaintext ObjStm payload from the packed objects.
  let header = '';
  const bodies: string[] = [];
  let bodyLen = 0;
  compressedNums.forEach((num, idx) => {
    header += `${num} ${bodyLen} `;
    const body = serializeValue(objs[num - 1]) + (idx === compressedNums.length - 1 ? '' : '\n');
    bodies.push(body);
    bodyLen += enc(body).length;
  });
  const headerBytes = enc(header);
  const objStmPlain = concat([headerBytes, enc(bodies.join(''))]);
  // Deflate THEN encrypt the whole ObjStm stream by its own object number.
  const objStmRaw = encryptor.encryptStreamRaw(
    new Uint8Array(deflateSync(Buffer.from(objStmPlain))), objStmNum, 0,
  );
  const objStm: PdfStream = {
    kind: 'stream',
    dict: new Map<string, PdfObject>([
      ['Type', name('ObjStm')],
      ['N', compressedNums.length],
      ['First', headerBytes.length],
      ['Filter', name('FlateDecode')],
    ]),
    raw: objStmRaw,
  };

  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (b: Uint8Array): void => { chunks.push(b); length += b.length; };
  const offsets = new Map<number, number>();

  push(enc(`%PDF-${ver}\n%âãÏÓ\n`));
  for (const num of directNums) {
    offsets.set(num, length);
    const encObj = encryptor.encryptObject(objs[num - 1], num, 0); // stream: dict strings + raw
    push(enc(`${num} 0 obj\n`));
    push(serializeObject(encObj));
    push(enc('\nendobj\n'));
  }
  const objStmOffset = length;
  push(enc(`${objStmNum} 0 obj\n`));
  push(serializeObject(objStm));
  push(enc('\nendobj\n'));

  // /Encrypt as a direct object (never packed, never encrypted).
  const encOffset = length;
  push(enc(`${encNum} 0 obj\n`));
  push(serializeObject(encryptor.encryptDict));
  push(enc('\nendobj\n'));

  const xrefOffset = length;

  type Row = [number, number, number];
  const rows: Row[] = new Array(size);
  rows[0] = [0, 0, 0xffff];
  const indexInObjStm = new Map<number, number>();
  compressedNums.forEach((num, idx) => indexInObjStm.set(num, idx));
  for (let num = 1; num <= n; num++) {
    if (indexInObjStm.has(num)) rows[num] = [2, objStmNum, indexInObjStm.get(num)!];
    else rows[num] = [1, offsets.get(num)!, 0];
  }
  rows[objStmNum] = [1, objStmOffset, 0];
  rows[encNum] = [1, encOffset, 0];
  rows[xrefStmNum] = [1, xrefOffset, 0];

  let maxF1 = 0, maxF2 = 0;
  for (const [, f1, f2] of rows) { if (f1 > maxF1) maxF1 = f1; if (f2 > maxF2) maxF2 = f2; }
  const w = [1, byteWidth(maxF1), byteWidth(maxF2)];
  const rowLen = w[0] + w[1] + w[2];
  const table = new Uint8Array(size * rowLen);
  let tp = 0;
  for (const [f0, f1, f2] of rows) {
    tp = putBE(table, tp, f0, w[0]);
    tp = putBE(table, tp, f1, w[1]);
    tp = putBE(table, tp, f2, w[2]);
  }
  const xrefRaw = new Uint8Array(deflateSync(Buffer.from(table))); // XRef stream never encrypted

  const xrefDict: PdfDict = new Map<string, PdfObject>();
  xrefDict.set('Type', name('XRef'));
  xrefDict.set('Size', size);
  xrefDict.set('Root', ref(oldToNew.get(rootRef.num)!, 0));
  const infoRef = plan.infoRef;
  if (isRef(infoRef) && oldToNew.has(infoRef.num)) xrefDict.set('Info', ref(oldToNew.get(infoRef.num)!, 0));
  xrefDict.set('Encrypt', ref(encNum, 0));
  xrefDict.set('ID', [pdfStr(id0), pdfStr(id1)]);
  xrefDict.set('W', w);
  xrefDict.set('Filter', name('FlateDecode'));
  xrefDict.set('Length', xrefRaw.length);

  push(enc(`${xrefStmNum} 0 obj\n`));
  push(enc(serializeDict(xrefDict) + '\nstream\n'));
  push(xrefRaw);
  push(enc('\nendstream\nendobj\n'));
  push(enc(`startxref\n${xrefOffset}\n%%EOF\n`));

  return concat(chunks);
}

/** Bytes needed to hold `max` big-endian (at least 1). */
function byteWidth(max: number): number {
  let w = 1;
  while (max >= 2 ** (8 * w)) w++;
  return w;
}

/** Write `value` as `width` big-endian bytes into `out` at `p`; return next p. */
function putBE(out: Uint8Array, p: number, value: number, width: number): number {
  for (let i = width - 1; i >= 0; i--) { out[p + i] = value & 0xff; value = Math.floor(value / 256); }
  return p + width;
}

function serializeCompressed(plan: Plan, trailer: PdfDict, ver = '1.7'): Uint8Array {
  const { rootRef, oldToNew, objs } = plan;
  const n = objs.length;
  const objStmNum = n + 1;
  const xrefStmNum = n + 2;
  const size = xrefStmNum + 1;

  // Partition: streams must stay as direct objects; everything else packs into
  // one object stream. Object number for slot i is (i + 1).
  const compressedNums: number[] = [];
  const directNums: number[] = [];
  for (let i = 0; i < n; i++) (isStream(objs[i]) ? directNums : compressedNums).push(i + 1);

  // Build the ObjStm payload: "num off num off ... <bodies>". Offsets are
  // relative to /First (start of the body section).
  let header = '';
  const bodies: string[] = [];
  let bodyLen = 0;
  compressedNums.forEach((num, idx) => {
    header += `${num} ${bodyLen} `;
    const body = serializeValue(objs[num - 1]) + (idx === compressedNums.length - 1 ? '' : '\n');
    bodies.push(body);
    bodyLen += enc(body).length;
  });
  const headerBytes = enc(header);
  const objStmPlain = concat([headerBytes, enc(bodies.join(''))]);
  const objStmRaw = new Uint8Array(deflateSync(Buffer.from(objStmPlain)));
  const objStm: PdfStream = {
    kind: 'stream',
    dict: new Map<string, PdfObject>([
      ['Type', name('ObjStm')],
      ['N', compressedNums.length],
      ['First', headerBytes.length],
      ['Filter', name('FlateDecode')],
    ]),
    raw: objStmRaw,
  };

  // Lay out the file: header, direct (stream) objects, the ObjStm, then the XRef
  // stream. Record byte offsets as we go.
  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (b: Uint8Array): void => { chunks.push(b); length += b.length; };
  const offsets = new Map<number, number>(); // newNum -> file offset (direct objects only)

  push(enc(`%PDF-${ver}\n%âãÏÓ\n`));
  for (const num of directNums) {
    offsets.set(num, length);
    push(enc(`${num} 0 obj\n`));
    push(serializeObject(objs[num - 1]));
    push(enc('\nendobj\n'));
  }
  const objStmOffset = length;
  push(enc(`${objStmNum} 0 obj\n`));
  push(serializeObject(objStm));
  push(enc('\nendobj\n'));

  const xrefOffset = length;

  // Cross-reference rows for object numbers 0..size-1.
  type Row = [number, number, number];
  const rows: Row[] = new Array(size);
  rows[0] = [0, 0, 0xffff]; // free head
  const indexInObjStm = new Map<number, number>();
  compressedNums.forEach((num, idx) => indexInObjStm.set(num, idx));
  for (let num = 1; num <= n; num++) {
    if (indexInObjStm.has(num)) rows[num] = [2, objStmNum, indexInObjStm.get(num)!];
    else rows[num] = [1, offsets.get(num)!, 0];
  }
  rows[objStmNum] = [1, objStmOffset, 0];
  rows[xrefStmNum] = [1, xrefOffset, 0];

  let maxF1 = 0, maxF2 = 0;
  for (const [, f1, f2] of rows) { if (f1 > maxF1) maxF1 = f1; if (f2 > maxF2) maxF2 = f2; }
  const w = [1, byteWidth(maxF1), byteWidth(maxF2)];
  const rowLen = w[0] + w[1] + w[2];
  const table = new Uint8Array(size * rowLen);
  let tp = 0;
  for (const [f0, f1, f2] of rows) {
    tp = putBE(table, tp, f0, w[0]);
    tp = putBE(table, tp, f1, w[1]);
    tp = putBE(table, tp, f2, w[2]);
  }
  const xrefRaw = new Uint8Array(deflateSync(Buffer.from(table)));

  const xrefDict: PdfDict = new Map<string, PdfObject>();
  xrefDict.set('Type', name('XRef'));
  xrefDict.set('Size', size);
  xrefDict.set('Root', ref(oldToNew.get(rootRef.num)!, 0));
  const infoRef = plan.infoRef;
  if (isRef(infoRef) && oldToNew.has(infoRef.num)) xrefDict.set('Info', ref(oldToNew.get(infoRef.num)!, 0));
  const id = trailer.get('ID');
  if (id !== undefined) xrefDict.set('ID', id);
  xrefDict.set('W', w);
  xrefDict.set('Filter', name('FlateDecode'));
  xrefDict.set('Length', xrefRaw.length);

  push(enc(`${xrefStmNum} 0 obj\n`));
  push(enc(serializeDict(xrefDict) + '\nstream\n'));
  push(xrefRaw);
  push(enc('\nendstream\nendobj\n'));
  push(enc(`startxref\n${xrefOffset}\n%%EOF\n`));

  return concat(chunks);
}
