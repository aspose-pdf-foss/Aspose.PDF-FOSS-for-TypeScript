import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Document } from '../../src/document.js';
import { isDict, isRef, isStream, isString } from '../../src/types.js';
import { decodeStream, encodeStream } from '../../src/filters.js';

/**
 * The DYNAMIC-XFA oracle (`164g.6`): OPM Form 1644, a genuinely dynamic XFA
 * form (`/NeedsRendering true`, no AcroForm fields), laid out by pdf.js's XFA
 * engine in headless Chrome. `scripts/gen-xfa-goldens.ts` writes the goldens;
 * this module is shared by that generator and by the suite, so both derive the
 * SAME variant documents from the vendored bytes.
 *
 * See `test/fixtures/xfa-dynamic/PROVENANCE.md` for what the goldens do and do
 * not establish -- pdf.js is a reimplementation, not Adobe.
 */
export type DynamicVariant = 'published' | 'header' | 'pages';

export const DYNAMIC_VARIANTS: readonly DynamicVariant[] = ['published', 'header', 'pages'];

/** Read off the pdf.js page: `xfaSubform`, `xfaField`, `xfaDraw`, ... */
export type GoldenKind = 'subform' | 'field' | 'draw' | 'exclGroup' | 'area';

export interface GoldenNode {
  /** 1-based page pdf.js put the node on. A node split across pages appears
   *  once per page, with the same `som`. */
  page: number;
  /** SOM path with occurrence indices, the converter's naming. */
  som: string;
  kind: GoldenKind;
  /** Border box in points, top-left origin, rounded to 0.01. */
  x: number; y: number; w: number; h: number;
  /** A text field's bound value, when non-empty: evidence that a repeated
   *  instance bound to its OWN data group. */
  value?: string;
}

export interface VariantGoldens {
  /** Pages pdf.js laid the variant out on. */
  pages: number;
  /** SHA-256 of the template and datasets packet text the variant feeds
   *  pdf.js, so the suite can prove it derives the same documents. */
  template: string;
  datasets: string;
  nodes: GoldenNode[];
}

export interface DynamicGoldens {
  meta: Record<string, string>;
  variants: Record<DynamicVariant, VariantGoldens>;
}

export const DYNAMIC_FILE = 'opm1644.pdf';

const fixture = (f: string) => new URL(`../fixtures/xfa-dynamic/${f}`, import.meta.url);

export function loadDynamicPdf(): Uint8Array {
  return new Uint8Array(readFileSync(fixture(DYNAMIC_FILE)));
}

export function dynamicGoldens(): DynamicGoldens {
  return JSON.parse(readFileSync(fixture('goldens.json'), 'utf8')) as DynamicGoldens;
}

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** The /XFA array's entry for `name`: its object number and decoded text. */
function packet(doc: Document, name: string): { num: number; text: string } {
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  const xfa = isDict(acro) ? doc.resolve(acro.get('XFA')) : undefined;
  if (!Array.isArray(xfa)) throw new Error('no /XFA array');
  for (let i = 0; i + 1 < xfa.length; i += 2) {
    const n = xfa[i];
    if (!isString(n) || Buffer.from(n.bytes).toString('latin1') !== name) continue;
    const ref = xfa[i + 1];
    const s = doc.resolve(ref);
    if (!isRef(ref) || !isStream(s)) throw new Error(`${name}: not an indirect stream`);
    return { num: ref.num, text: Buffer.from(decodeStream(s)).toString('utf8') };
  }
  throw new Error(`no ${name} packet`);
}

export function packetText(doc: Document, name: string): string {
  return packet(doc, name).text;
}

/** Replace the ONE match of `re`, or throw: an edit that silently matched
 *  nothing, or two things, would yield goldens for a document nobody meant. */
function once(text: string, re: RegExp, f: (m: string) => string): string {
  const all = [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))];
  if (all.length !== 1) throw new Error(`${re}: ${String(all.length)} matches, expected 1`);
  const m = all[0];
  return text.slice(0, m.index) + f(m[0]) + text.slice(m.index + m[0].length);
}

function edit(doc: Document, name: string, f: (s: string) => string): void {
  const p = packet(doc, name);
  doc.replaceObject(p.num, encodeStream(new Uint8Array(Buffer.from(f(p.text), 'utf8')), 'FlateDecode'));
}

/** Replace the ONE match of `re` in a packet, or throw (yy09 uses it on the
 *  hybrids' datasets, which are blank as vendored). */
export function editPacket(doc: Document, name: string, re: RegExp, f: (m: string) => string): void {
  edit(doc, name, (s) => once(s, re, f));
}

/**
 * The vendored form, as published or with ONE documented edit.
 *
 * - `published`: untouched. pdf.js lays it out on TWO pages -- the `tb` root
 *   `OF1644` breaks `Page1` and `Page2`, each a page tall, onto two instances
 *   of the one `<pageArea>`.
 * - `header`: a DATASETS edit only. SectionI's `Header` row carries
 *   `<occur max="-1">` (Designer's default for a table header), and three
 *   `Header` data groups make three instances -- data-driven repetition.
 * - `pages`: a one-element TEMPLATE edit, `<occur max="-1"/>` on `Page2`, plus
 *   three `Page2` data groups whose `FieldQ1FinInst` values differ. pdf.js puts
 *   each instance on its own page: a subform repeated ACROSS page breaks, which
 *   no federal form found carries as published.
 */
export function deriveVariant(bytes: Uint8Array, v: DynamicVariant): Document {
  const doc = Document.Open(bytes);
  if (v === 'header') {
    edit(doc, 'datasets', (s) => once(s,
      /<SectionI\s*>\s*<Header xfa:dataNode="dataGroup"\s*>\s*<\/Header\s*>/,
      (m) => `${m}<Header xfa:dataNode="dataGroup"></Header><Header xfa:dataNode="dataGroup"></Header>`));
  } else if (v === 'pages') {
    edit(doc, 'template', (s) => once(s,
      /<subform h="11in" locale="en_US" name="Page2" w="215\.9mm"\s*>/,
      (m) => `${m}<occur max="-1"/>`));
    edit(doc, 'datasets', (s) => once(s, /<Page2\s*>[\s\S]*?<\/Page2\s*>/,
      // SectionV holds a FieldQ1FinInst too; the value goes in SectionIV's.
      (m) => [1, 2, 3].map((k) => once(m,
        /<SectionIV\s*>[\s\S]*?<FieldQ1FinInst\s*>\s*<\/FieldQ1FinInst\s*>/,
        (x) => x.replace(/<FieldQ1FinInst\s*>\s*<\/FieldQ1FinInst\s*>$/,
          `<FieldQ1FinInst>Bank ${String(k)}</FieldQ1FinInst>`))).join('')));
  }
  return doc;
}

/** d3mq: dynamic DoD forms with FILLABLE master-page fields, laid out by pdf.js.
 *  Their master boxes are the oracle; see PROVENANCE. */
export const MASTER_FILES = ['dod-dd2875.pdf', 'dod-dd1494.pdf'] as const;
export type MasterFile = (typeof MASTER_FILES)[number];

export interface MasterGoldens {
  meta: Record<string, string>;
  /** Per file: pages pdf.js laid out, and every node pdf.js named under a page
   *  area (`som` starts `#pageArea[<name>].`). `body` is every OTHER node
   *  pdf.js named, kept for DD 1494 only: the oracle for splitting (164g.8). */
  files: Record<MasterFile, { pages: number; sha256: string; nodes: GoldenNode[]; body?: GoldenNode[] }>;
}

export function loadMasterPdf(file: MasterFile): Uint8Array {
  return new Uint8Array(readFileSync(fixture(file)));
}

export function masterGoldens(): MasterGoldens {
  return JSON.parse(readFileSync(fixture('master-goldens.json'), 'utf8')) as MasterGoldens;
}

/** The pdf.js chrome oracle (164g.4): border boxes and draw/caption text per
 *  page, as pdf.js 6.3.289 renders them into headless Chrome. Coordinates are
 *  CSS px at scale 1, which is points, from the page's top-left. */
export interface GoldenBorder {
  page: number; x: number; y: number; w: number; h: number;
  widths: [number, number, number, number];
  styles: [string, string, string, string];
  colors: [string, string, string, string];
  radius: string;
}
export interface GoldenText { page: number; kind: 'draw' | 'caption'; x: number; y: number; w: number; h: number; text: string }
export interface ChromeGoldens {
  meta: Record<string, string>;
  files: Record<string, { pages: number; sha256: string; borders: GoldenBorder[]; texts: GoldenText[] }>;
}

export const CHROME_FILES = ['opm1644.pdf', 'dod-dd2875.pdf', 'dod-dd1494.pdf'] as const;

export function chromeGoldens(): ChromeGoldens {
  return JSON.parse(readFileSync(fixture('chrome-goldens.json'), 'utf8')) as ChromeGoldens;
}
