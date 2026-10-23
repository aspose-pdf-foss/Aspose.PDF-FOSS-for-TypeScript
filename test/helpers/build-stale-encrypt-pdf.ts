// An encrypted document carrying a SECOND encryption dictionary: a plaintext
// copy of the real /Encrypt dict, in the xref, referenced by nothing -- the
// shape Adobe LiveCycle Designer 11.0 wrote into the 2021-03 DD 3019 (e8y8).
//
// Built from our own encrypted Save plus one appended revision holding the
// copy byte for byte, so its /O and /U are exactly the real dict's.
import { Document } from '../../src/document.js';
import { PageFormat } from '../../src/pageformat.js';
import { ObjectParser } from '../../src/object-parser.js';
import { Lexer } from '../../src/lexer.js';
import { isDict, isString, type PdfDict } from '../../src/types.js';

export interface StaleEncryptPdf {
  bytes: Uint8Array;
  /** Object number of the unreferenced plaintext copy. */
  staleNum: number;
  /** The real dict's /O and /U, as the file states them. */
  O: Uint8Array;
  U: Uint8Array;
}

export function buildStaleEncryptPdf(algorithm: 'rc4' | 'aes128' | 'aes256'): StaleEncryptPdf {
  const doc = Document.New();
  doc.AddPage(PageFormat.custom(200, 200));
  doc.Pages[0].AddText('stale', 20, 100);
  const base = doc.Save({ encrypt: { userPassword: '', ownerPassword: 'owner', algorithm } });
  const s = Buffer.from(base).toString('latin1');

  const tStart = s.lastIndexOf('trailer');
  const trailer = s.slice(tStart, s.indexOf('startxref', tStart));
  const encNum = Number(/\/Encrypt\s+(\d+)\s+0\s+R/.exec(trailer)![1]);
  const size = Number(/\/Size\s+(\d+)/.exec(trailer)![1]);
  const prev = Number(/startxref\s+(\d+)/.exec(s.slice(s.lastIndexOf('startxref')))![1]);

  const objStart = s.search(new RegExp(`(^|[\\r\\n])${encNum} 0 obj`));
  const body = s.slice(s.indexOf('obj', objStart) + 3, s.indexOf('endobj', objStart));
  const real = new ObjectParser(new Lexer(base, s.indexOf(`${encNum} 0 obj`, objStart))).parseIndirectObject().value;
  if (!isDict(real)) throw new Error('no /Encrypt dict');
  const O = (real as PdfDict).get('O'), U = (real as PdfDict).get('U');
  if (!isString(O) || !isString(U)) throw new Error('/O or /U missing');

  const objOff = s.length + 1;
  let tail = `\n${size} 0 obj${body}endobj\n`;
  const xrefOff = s.length + tail.length;
  const dict = /<<([\s\S]*)>>/.exec(trailer)![1]
    .replace(/\/Size\s+\d+/, `/Size ${size + 1}`)
    .replace(/\/Prev\s+\d+/, '');
  tail += `xref\n${size} 1\n${String(objOff).padStart(10, '0')} 00000 n \n`
    + `trailer\n<<${dict} /Prev ${prev}>>\nstartxref\n${xrefOff}\n%%EOF\n`;
  return { bytes: Buffer.from(s + tail, 'latin1'), staleNum: size, O: O.bytes, U: U.bytes };
}
