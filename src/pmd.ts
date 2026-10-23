// Acrobat's paper forms barcode (2srz.4): the /PMD ("paper metadata")
// dictionary on a barcode field, and the tab-delimited calculation script
// Acrobat generates to fill it. Neither is in ISO 32000. A pure leaf over
// types.js and metadata.js -- no Document -- so every rule is testable from
// strings and hand-built dicts.
//
// The script is RECOGNISED, never executed (6t2v.2): it is Acrobat's template
// with its three blanks read out, or it is nothing. Anything that could compute
// a different value is not the template.
import { isName, isString, name, type PdfDict, type PdfObject } from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';

export type PmdSymbology = 'PDF417' | 'QRCode' | 'DataMatrix';
const SYMBOLOGIES: readonly PmdSymbology[] = ['PDF417', 'QRCode', 'DataMatrix'];

/** A barcode field's /PMD. Keys are Acrobat's, as PDFlib and DynaPDF also
 *  write them; only what is stated is present. */
export interface PaperMetadata {
  symbology: PmdSymbology;
  /** /ECC: PDF417 0..8, QR 0..3 (L, M, Q, H); Data Matrix ECC 200 has one level, 0. */
  ecc?: number;
  /** /XSymWidth: module width, in pixels at /Resolution. */
  xSymWidth?: number;
  /** /XSymHeight: module height, in pixels at /Resolution. */
  xSymHeight?: number;
  /** /YSymHeight: PDF417 row height, in pixels at /Resolution. */
  ySymHeight?: number;
  /** /nCodeWordRow: PDF417 rows. */
  nCodeWordRow?: number;
  /** /nCodeWordCol: PDF417 data columns. */
  nCodeWordCol?: number;
  /** /Resolution: dots per inch the module sizes are stated at. */
  resolution?: number;
  /** /DataPrep: 0 encodes the value as it is, 1 Flate-compresses it first. */
  dataPrep?: 0 | 1;
  /** /Caption: text a viewer may show with the symbol. */
  caption?: string;
}

const NUMERIC: readonly [keyof PaperMetadata, string][] = [
  ['xSymWidth', 'XSymWidth'], ['xSymHeight', 'XSymHeight'], ['ySymHeight', 'YSymHeight'],
  ['nCodeWordRow', 'nCodeWordRow'], ['nCodeWordCol', 'nCodeWordCol'], ['resolution', 'Resolution'],
];
const MAX_ECC: Record<PmdSymbology, number> = { PDF417: 8, QRCode: 3, DataMatrix: 0 };
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
/** PDF417's own bounds on a row and column count (ISO/IEC 15438): an integer
 *  1..30 data columns, 3..90 rows. Outside them no symbol exists, so a stated
 *  count there would refuse every content as though it were too large. */
const COUNT_RANGE: Partial<Record<keyof PaperMetadata, readonly [number, number]>> = {
  nCodeWordCol: [1, 30], nCodeWordRow: [3, 90],
};
const inRange = (k: keyof PaperMetadata, v: number): boolean => {
  const r = COUNT_RANGE[k];
  return r === undefined || (Number.isInteger(v) && v >= r[0] && v <= r[1]);
};

/** Read a /PMD leniently: an unknown symbology is no barcode; an entry of the
 *  wrong type or outside its range is dropped. */
export function readPmd(
  dict: PdfDict | undefined, resolve: (o: PdfObject | undefined) => PdfObject,
): PaperMetadata | undefined {
  if (dict === undefined) return undefined;
  const sym = resolve(dict.get('Symbology'));
  if (!isName(sym) || !(SYMBOLOGIES as readonly string[]).includes(sym.name)) return undefined;
  const out: PaperMetadata = { symbology: sym.name as PmdSymbology };
  const ecc = resolve(dict.get('ECC'));
  if (typeof ecc === 'number' && Number.isInteger(ecc) && ecc >= 0 && ecc <= MAX_ECC[out.symbology]) out.ecc = ecc;
  for (const [k, key] of NUMERIC) {
    const v = resolve(dict.get(key));
    if (positive(v) && inRange(k, v)) (out as unknown as Record<string, number>)[k] = v;
  }
  const dp = resolve(dict.get('DataPrep'));
  if (dp === 0 || dp === 1) out.dataPrep = dp;
  const cap = resolve(dict.get('Caption'));
  if (isString(cap)) out.caption = decodePdfText(cap.bytes);
  return out;
}

/** Write a /PMD, validating every entry: TypeError for the wrong kind of
 *  value, RangeError for one outside its set. */
export function encodePmd(pmd: PaperMetadata): PdfDict {
  if (!(SYMBOLOGIES as readonly string[]).includes(pmd.symbology))
    throw new RangeError(`/PMD symbology must be one of ${SYMBOLOGIES.join(', ')}`);
  const d: PdfDict = new Map<string, PdfObject>([['Symbology', name(pmd.symbology)]]);
  if (pmd.ecc !== undefined) {
    if (typeof pmd.ecc !== 'number') throw new TypeError('/PMD ecc must be a number');
    const max = MAX_ECC[pmd.symbology];
    if (!Number.isInteger(pmd.ecc) || pmd.ecc < 0 || pmd.ecc > max)
      throw new RangeError(`/PMD ecc for ${pmd.symbology} must be an integer 0..${max}`);
    d.set('ECC', pmd.ecc);
  }
  for (const [k, key] of NUMERIC) {
    const v = pmd[k];
    if (v === undefined) continue;
    if (typeof v !== 'number') throw new TypeError(`/PMD ${k} must be a number`);
    if (!positive(v)) throw new RangeError(`/PMD ${k} must be a positive finite number`);
    if (!inRange(k, v)) throw new RangeError(`/PMD ${k} must be an integer ${COUNT_RANGE[k]!.join('..')}`);
    d.set(key, v);
  }
  if (pmd.dataPrep !== undefined) {
    if (pmd.dataPrep !== 0 && pmd.dataPrep !== 1) throw new RangeError('/PMD dataPrep must be 0 or 1');
    d.set('DataPrep', pmd.dataPrep);
  }
  if (pmd.caption !== undefined) {
    if (typeof pmd.caption !== 'string') throw new TypeError('/PMD caption must be a string');
    d.set('Caption', { kind: 'string', bytes: encodePdfText(pmd.caption) });
  }
  return d;
}

// --- The tab-delimited script ---------------------------------------------------

/** The three blanks of Acrobat's tab-delimited script. */
export interface TabScript {
  /** `aFields`: the names carried, or `null` for every field. */
  fields: readonly string[] | null;
  /** `bFieldNames`: prefix a tab-joined header row and a newline. */
  fieldNames: boolean;
  /** `strXclField`: a field name skipped. Acrobat's own scripts omit it. */
  exclude?: string;
}

/** Acrobat's generated helpers, verbatim from users' pastes on the Adobe
 *  community forum (bMemberOf from the "barcode generator variable order"
 *  thread, strTabDelimited from td-p/8664920), in the paste's own layout. */
const HELPERS = `function bMemberOf(strName, aStrNames)
{
    for (var nMembIdx in aStrNames)
    {
        if (strName == aStrNames[nMembIdx])
            return true;
    }
    return false;
}
function strTabDelimited(oParam)
{
    var bNeedTab = false;
    var strNames = "";
    var strValues = "";
    for (var i = 0; i < oParam.oDoc.numFields; ++i)
    {
        var strFieldName = oParam.oDoc.getNthFieldName(i);
        if ((null == oParam.aFields || bMemberOf(strFieldName, oParam.aFields))
            && (null == oParam.strXclField || strFieldName != oParam.strXclField)
            && (oParam.oDoc.getField(strFieldName).type != "button"))
        {
            if (bNeedTab)
            {
                if (oParam.bFieldNames)
                    strNames += "\\t";
                strValues += "\\t";
            }
            if (oParam.bFieldNames)
                strNames += strFieldName;
            strValues += oParam.oDoc.getField(strFieldName).value;
            bNeedTab = true;
        }
    }
    if (oParam.bFieldNames)
        return strNames + "\\n" + strValues;
    else
        return strValues;
}


try
{
    if ( app.viewerVersion >= ADBE.PMD_Need_Version )
        event.value = strTabDelimited({oDoc: this, aFields: `;
// `${'catch'}`: test/limits-catch.test.ts scans src/ for catch clauses by
// text, and this one is the DOCUMENT's JavaScript, not ours.
const TAIL = `});
    else event.value = " ";
}
${'catch'} (e)
{
    event.value = " ";
}`;

/** Acrobat's tab-delimited script with `params` in its blanks. */
export function buildTabScript(params: TabScript): string {
  const list = params.fields === null ? 'null' : `[${params.fields.map((f) => JSON.stringify(f)).join(', ')}]`;
  const excl = params.exclude === undefined ? '' : `, strXclField: ${JSON.stringify(params.exclude)}`;
  return `${HELPERS}${list}, bFieldNames: ${params.fieldNames}${excl}${TAIL}`;
}

const PUNCT = new Set('{}()[];,=<>!&|+.:?-*/'.split(''));

/** The script with whitespace outside string literals collapsed, and dropped
 *  beside punctuation, so layout cannot decide recognition. String literals
 *  are kept as written. `undefined` for an unterminated literal. */
function normalize(src: string): string | undefined {
  let out = '';
  let pendingSpace = false;
  let pendingNewline = false;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (/\s/.test(c)) { pendingSpace = true; if (c === '\n' || c === '\r') pendingNewline = true; i++; continue; }
    // Two spellings that differ only in layout and still mean something else
    // in JavaScript: a line break after `return` ends the statement (ASI), so
    // `return\n x` returns undefined; and `+ +i` is not `++i`. Both keep a
    // separator, so neither normalizes onto the template.
    const last = out[out.length - 1];
    if (pendingNewline && /(?:^|[^\w$])return$/.test(out)) out += '\n';
    else if (pendingSpace && (c === '+' || c === '-') && last === c) out += ' ';
    else if (pendingSpace && out !== '' && !PUNCT.has(last) && !PUNCT.has(c)) out += ' ';
    pendingSpace = false;
    pendingNewline = false;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\n') return undefined;
        j += src[j] === '\\' ? 2 : 1;
      }
      if (j >= src.length) return undefined;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** One JavaScript string literal at `at` in `s`: its value and the index past
 *  it, or undefined. */
function readJsString(s: string, at: number): { value: string; end: number } | undefined {
  const q = s[at];
  if (q !== '"' && q !== "'") return undefined;
  let v = '';
  for (let i = at + 1; i < s.length;) {
    const c = s[i];
    if (c === q) return { value: v, end: i + 1 };
    if (c !== '\\') { v += c; i++; continue; }
    const e = s[i + 1];
    const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
    if (e !== undefined && Object.hasOwn(simple, e) && !(e === '0' && /\d/.test(s[i + 2] ?? ''))) {
      v += simple[e]; i += 2; continue;
    }
    if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) {
      v += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16)); i += 4; continue;
    }
    if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
      v += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 6; continue;
    }
    if (e === '\\' || e === '"' || e === "'" || e === '/') { v += e; i += 2; continue; }
    return undefined; // anything else is not worth guessing at
  }
  return undefined;
}

const N_HEAD = normalize(HELPERS)!;
const N_TAIL = normalize(TAIL)!;

/** Which of Acrobat's barcode scripts `script` is: the tab-delimited template
 *  with its blanks, the XML one (recognised, not recomputed), or neither.
 *  Never throws. */
export function parseBarcodeScript(script: string): { encoding: 'tab'; params: TabScript } | { encoding: 'xml' } | undefined {
  const tab = parseTab(script);
  if (tab !== undefined) return { encoding: 'tab', params: tab };
  if (/\bstrXMLData\s*\(/i.test(script)) return { encoding: 'xml' };
  return undefined;
}

function parseTab(script: string): TabScript | undefined {
  const s = normalize(script);
  if (s === undefined || !s.startsWith(N_HEAD) || !s.endsWith(N_TAIL)) return undefined;
  let i = N_HEAD.length;
  const body = s.slice(0, s.length - N_TAIL.length);
  let fields: string[] | null;
  if (body.startsWith('null', i)) { fields = null; i += 4; }
  else if (body[i] === '[') {
    fields = [];
    i++;
    if (body[i] !== ']') {
      for (;;) {
        const lit = readJsString(body, i);
        if (lit === undefined) return undefined;
        fields.push(lit.value);
        i = lit.end;
        if (body[i] === ',') { i++; continue; }
        break;
      }
    }
    if (body[i] !== ']') return undefined;
    i++;
  } else return undefined;
  const m = /^,bFieldNames:(true|false)/.exec(body.slice(i));
  if (m === null) return undefined;
  i += m[0].length;
  const out: TabScript = { fields, fieldNames: m[1] === 'true' };
  if (i === body.length) return out;
  if (!body.startsWith(',strXclField:', i)) return undefined;
  const lit = readJsString(body, i + ',strXclField:'.length);
  if (lit === undefined || lit.end !== body.length) return undefined;
  return { ...out, exclude: lit.value };
}

/** The template's own join: values separated by tabs, and with `fieldNames`
 *  a tab-joined header row and a newline before them. */
export function joinTabDelimited(entries: readonly { name: string; value: string }[], fieldNames: boolean): string {
  const values = entries.map((e) => e.value).join('\t');
  return fieldNames ? `${entries.map((e) => e.name).join('\t')}\n${values}` : values;
}
