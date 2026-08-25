import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { rc4, aesCbc128Encrypt, fileKeyR234, objectKeyV4, padPassword, PASSWORD_PADDING, hash2B } from '../../src/crypto.js';

const aes256Enc = (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => {
  const c = createCipheriv('aes-256-cbc', key, iv); c.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([c.update(data), c.final()]));
};

/** Build /U,/UE for R6 (Algorithm 8): random salts; the random 32-byte file key
 *  encrypted under the intermediate key. */
function buildR6User(userPw: Uint8Array): { U: Uint8Array; UE: Uint8Array; fileKey: Uint8Array } {
  const fileKey = new Uint8Array(randomBytes(32));
  const valSalt = new Uint8Array(randomBytes(8));
  const keySalt = new Uint8Array(randomBytes(8));
  const hash = hash2B(userPw, valSalt, new Uint8Array(0));
  const U = cat(hash, valSalt, keySalt); // 48 bytes
  const ik = hash2B(userPw, keySalt, new Uint8Array(0));
  const UE = aes256Enc(ik, new Uint8Array(16), fileKey);
  return { U, UE, fileKey };
}

export interface EncryptConfig {
  cipher: 'rc4' | 'aes128' | 'aes256';
  R: number;            // 3 (rc4), 4 (aes128), 6 (aes256)
  V: number;            // 2, 4, 5
  length: number;       // key bits: 128 (rc4/aes128), 256 (aes256)
  userPassword?: string;       // default ''
  encryptMetadata?: boolean;   // default true
}

export interface SimpleDoc {
  /** /Info-style metadata strings (encrypted as object strings). */
  info?: Record<string, string>;
  /** page content streams (encrypted as object streams), one per page. */
  pageContents: string[];
}

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...a: Uint8Array[]) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const md5 = (b: Uint8Array) => new Uint8Array(createHash('md5').update(b).digest());
const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Compute /O for R2-4 (Algorithm 3). Tests use ownerPassword === userPassword. */
function computeO(userPw: Uint8Array, ownerPw: Uint8Array, R: number, n: number): Uint8Array {
  let key = md5(padPassword(ownerPw));
  if (R >= 3) for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n));
  key = key.subarray(0, n);
  let data = padPassword(userPw);
  data = rc4(key, data);
  if (R >= 3) for (let i = 1; i <= 19; i++) data = rc4(key.map((b) => b ^ i), data);
  return data;
}

/** Compute /U for R3-4 (Algorithm 5). */
function computeU(fileKey: Uint8Array, id0: Uint8Array): Uint8Array {
  const h = md5(cat(PASSWORD_PADDING, id0));
  let data = rc4(fileKey, h);
  for (let i = 1; i <= 19; i++) data = rc4(fileKey.map((b) => b ^ i), data);
  return cat(data, new Uint8Array(16)); // 32 bytes (16 arbitrary trailing)
}

const P = -44; // shared permissions value

interface DerivedKeys { fileKey: Uint8Array; O: Uint8Array; U: Uint8Array; UE: Uint8Array; }

/** Derive the file key and the /O,/U,/UE strings for `cfg`. */
function deriveKeys(cfg: EncryptConfig, id0: Uint8Array, encryptMetadata: boolean): DerivedKeys {
  const userPw = enc(cfg.userPassword ?? '');
  if (cfg.cipher === 'aes256') {
    const r6 = buildR6User(userPw);
    return { fileKey: r6.fileKey, O: new Uint8Array(48), U: r6.U, UE: r6.UE };
  }
  const n = cfg.length / 8;
  const O = computeO(userPw, userPw, cfg.R, n);
  const fileKey = fileKeyR234(userPw, O, P, id0, cfg.R, cfg.length, encryptMetadata);
  return { fileKey, O, U: computeU(fileKey, id0), UE: new Uint8Array(0) };
}

/** A per-object encryptor matching `cfg` and the derived file key. */
function mkEncBytes(cfg: EncryptConfig, fileKey: Uint8Array): (num: number, data: Uint8Array) => Uint8Array {
  return (num, data) => {
    if (cfg.cipher === 'rc4') return rc4(objectKeyV4(fileKey, num, 0, false), data);
    const iv = new Uint8Array(randomBytes(16));
    const padLen = 16 - (data.length % 16); // PKCS#7 (1..16)
    const padded = cat(data, new Uint8Array(padLen).fill(padLen));
    if (cfg.cipher === 'aes256') return cat(iv, aes256Enc(fileKey, iv, padded)); // V5: file key directly
    return cat(iv, aesCbc128Encrypt(objectKeyV4(fileKey, num, 0, true), iv, padded));
  };
}

/** Serialize the /Encrypt dict body for `cfg` and the derived keys. */
function encryptDictBody(cfg: EncryptConfig, keys: DerivedKeys, encryptMetadata: boolean): string {
  const n = cfg.length / 8;
  const Ohex = hexOf(keys.O), Uhex = hexOf(keys.U);
  const em = encryptMetadata ? '' : ' /EncryptMetadata false';
  if (cfg.V === 2)
    return `<< /Filter /Standard /V 2 /R ${cfg.R} /Length ${cfg.length} /P ${P} /O <${Ohex}> /U <${Uhex}> >>`;
  if (cfg.cipher === 'aes256') // V5/R6: /O,/OE,/Perms are filler; tests authenticate via /U,/UE.
    return `<< /Filter /Standard /V 5 /R 6 /Length 256 /P ${P}`
      + ` /O <${Ohex}> /OE <${hexOf(new Uint8Array(32))}> /U <${Uhex}> /UE <${hexOf(keys.UE)}> /Perms <${hexOf(new Uint8Array(16))}>`
      + ` /CF << /StdCF << /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF${em} >>`;
  const cfm = cfg.cipher === 'aes128' ? 'AESV2' : 'V2';
  return `<< /Filter /Standard /V 4 /R ${cfg.R} /Length ${cfg.length} /P ${P} /O <${Ohex}> /U <${Uhex}>`
    + ` /CF << /StdCF << /CFM /${cfm} /Length ${n} >> >> /StmF /StdCF /StrF /StdCF${em} >>`;
}

/** Build an encrypted classic-xref PDF: 1 Catalog, 2 Pages, then per page a Page
 *  dict + Contents stream, then optional Info. Strings/streams are encrypted per
 *  `cfg`; the trailer carries /Encrypt and /ID. */
export function buildEncryptedPdf(cfg: EncryptConfig, doc: SimpleDoc): {
  bytes: Uint8Array;
  expected: { info?: Record<string, string>; pageContents: string[] };
} {
  const encryptMetadata = cfg.encryptMetadata ?? true;
  const id0 = new Uint8Array(randomBytes(16));
  const keys = deriveKeys(cfg, id0, encryptMetadata);
  const encBytes = mkEncBytes(cfg, keys.fileKey);
  const encString = (num: number, s: string): string => '<' + hexOf(encBytes(num, enc(s))) + '>';

  // --- object layout ---
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  const pageNums: number[] = [];
  const contentNums: number[] = [];
  let next = 3;
  for (let i = 0; i < doc.pageContents.length; i++) { pageNums.push(next++); contentNums.push(next++); }
  objects[2] = `<< /Type /Pages /Count ${pageNums.length} /Kids [${pageNums.map((p) => `${p} 0 R`).join(' ')}] /MediaBox [0 0 200 200] >>`;

  const streamCt = new Map<number, Uint8Array>();
  for (let i = 0; i < doc.pageContents.length; i++) {
    const pageNum = pageNums[i], contentNum = contentNums[i];
    objects[pageNum] = `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents ${contentNum} 0 R >>`;
    const ct = encBytes(contentNum, enc(doc.pageContents[i]));
    streamCt.set(contentNum, ct);
    objects[contentNum] = `<< /Length ${ct.length} >>\nstream\n{{STREAM:${contentNum}}}\nendstream`;
  }
  let maxObj = next - 1;
  let infoNum: number | undefined;
  if (doc.info) {
    infoNum = ++maxObj;
    const body = Object.entries(doc.info).map(([k, v]) => `/${k} ${encString(infoNum!, v)}`).join(' ');
    objects[infoNum] = `<< ${body} >>`;
  }
  const encNum = ++maxObj;
  objects[encNum] = encryptDictBody(cfg, keys, encryptMetadata);

  // --- serialize, tracking byte offsets ---
  const parts: Uint8Array[] = [];
  let pos = 0;
  const push = (b: Uint8Array) => { parts.push(b); pos += b.length; };
  push(enc('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'));
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let num = 1; num <= maxObj; num++) {
    if (!objects[num]) continue;
    offsets[num] = pos;
    push(enc(`${num} 0 obj\n`));
    if (streamCt.has(num)) {
      const [pre, post] = objects[num].split(`{{STREAM:${num}}}`);
      push(enc(pre)); push(streamCt.get(num)!); push(enc(post + `\nendobj\n`));
    } else {
      push(enc(`${objects[num]}\nendobj\n`));
    }
  }
  const xrefOffset = pos;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let num = 1; num <= maxObj; num++) xref += `${String(offsets[num]).padStart(10, '0')} 00000 n \n`;
  const idHex = hexOf(id0);
  const infoEntry = infoNum ? ` /Info ${infoNum} 0 R` : '';
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R /Encrypt ${encNum} 0 R${infoEntry} /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  push(enc(xref + trailer));

  return { bytes: cat(...parts), expected: { info: doc.info, pageContents: doc.pageContents } };
}

/** Build an encrypted PDF whose cross-reference is an xref STREAM and whose
 *  /Info dict lives inside an /ObjStm. The ObjStm container is encrypted as a
 *  stream; the contained Info object is NOT individually encrypted (per spec).
 *  Exercises the decrypt-once path. */
export function buildEncryptedPdfWithObjStm(cfg: EncryptConfig, doc: SimpleDoc): {
  bytes: Uint8Array;
  expected: { info?: Record<string, string>; pageContents: string[] };
} {
  const encryptMetadata = cfg.encryptMetadata ?? true;
  const id0 = new Uint8Array(randomBytes(16));
  const keys = deriveKeys(cfg, id0, encryptMetadata);
  const encBytes = mkEncBytes(cfg, keys.fileKey);

  // --- object numbering (contiguous 1..xrefNum) ---
  let next = 3;
  const pageNums: number[] = [];
  const contentNums: number[] = [];
  for (let i = 0; i < doc.pageContents.length; i++) { pageNums.push(next++); contentNums.push(next++); }
  const encNum = next++;
  const infoNum = next++;     // compressed inside the ObjStm (type-2 xref entry)
  const objStmNum = next++;
  const xrefNum = next++;

  // --- regular (offset) objects, serialized as strings; streams kept as bytes ---
  const objects: string[] = [];
  const streamCt = new Map<number, Uint8Array>();
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count ${pageNums.length} /Kids [${pageNums.map((p) => `${p} 0 R`).join(' ')}] /MediaBox [0 0 200 200] >>`;
  for (let i = 0; i < doc.pageContents.length; i++) {
    objects[pageNums[i]] = `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents ${contentNums[i]} 0 R >>`;
    const ct = encBytes(contentNums[i], enc(doc.pageContents[i]));
    streamCt.set(contentNums[i], ct);
    objects[contentNums[i]] = `<< /Length ${ct.length} >>\nstream\n{{STREAM:${contentNums[i]}}}\nendstream`;
  }
  objects[encNum] = encryptDictBody(cfg, keys, encryptMetadata);

  // --- ObjStm holding the (plaintext) Info dict ---
  const infoBody = `<< ${Object.entries(doc.info ?? {}).map(([k, v]) => `/${k} (${v.replace(/([()\\])/g, '\\$1')})`).join(' ')} >>`;
  const header = `${infoNum} 0\n`;            // one pair: objNum offset(=0)
  const objStmPlain = enc(header + infoBody);
  const firstOff = enc(header).length;
  const objStmCt = encBytes(objStmNum, objStmPlain); // encrypted as a stream (no /Filter)
  streamCt.set(objStmNum, objStmCt);
  objects[objStmNum] = `<< /Type /ObjStm /N 1 /First ${firstOff} /Length ${objStmCt.length} >>\nstream\n{{STREAM:${objStmNum}}}\nendstream`;

  // --- serialize offset objects, tracking byte offsets ---
  const parts: Uint8Array[] = [];
  let pos = 0;
  const push = (b: Uint8Array) => { parts.push(b); pos += b.length; };
  push(enc('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n'));
  const offsetOf = new Map<number, number>();
  for (let num = 1; num < xrefNum; num++) {
    if (num === infoNum || !objects[num]) continue; // infoNum is compressed (no offset)
    offsetOf.set(num, pos);
    push(enc(`${num} 0 obj\n`));
    if (streamCt.has(num)) {
      const [pre, post] = objects[num].split(`{{STREAM:${num}}}`);
      push(enc(pre)); push(streamCt.get(num)!); push(enc(post + `\nendobj\n`));
    } else {
      push(enc(`${objects[num]}\nendobj\n`));
    }
  }

  // --- cross-reference stream (W=[1 3 1]) ---
  const xrefOffset = pos;
  offsetOf.set(xrefNum, xrefOffset);
  const rowBytes: number[] = [];
  const writeRow = (t: number, f1: number, f2: number) => {
    rowBytes.push(t & 0xff);
    rowBytes.push((f1 >> 16) & 0xff, (f1 >> 8) & 0xff, f1 & 0xff);
    rowBytes.push(f2 & 0xff);
  };
  writeRow(0, 0, 0); // object 0, free
  for (let num = 1; num <= xrefNum; num++) {
    if (num === infoNum) writeRow(2, objStmNum, 0);       // compressed in ObjStm at index 0
    else writeRow(1, offsetOf.get(num)!, 0);              // type-1 offset object
  }
  const packed = new Uint8Array(deflateSync(Buffer.from(Uint8Array.from(rowBytes))));
  const idHex = hexOf(id0);
  const xrefDict = `<< /Type /XRef /Size ${xrefNum + 1} /Root 1 0 R /Encrypt ${encNum} 0 R /Info ${infoNum} 0 R`
    + ` /ID [<${idHex}> <${idHex}>] /W [1 3 1] /Index [0 ${xrefNum + 1}] /Filter /FlateDecode /Length ${packed.length} >>`;
  push(enc(`${xrefNum} 0 obj\n${xrefDict}\nstream\n`));
  push(packed);
  push(enc(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`));

  return { bytes: cat(...parts), expected: { info: doc.info, pageContents: doc.pageContents } };
}
