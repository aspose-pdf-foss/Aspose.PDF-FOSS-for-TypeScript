// A rich-text field (/Ff bit 26) draws its /RV markup rather than the plain
// /V string (v0tz.5), through richlayout.ts — the same engine a FreeText's /RC
// goes through, so the two cannot disagree about what `<b>` means.
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { isDict, isStream, PdfDict, PdfObject } from '../src/types.js';
import { FF_COMB, FF_PASSWORD, FF_RICHTEXT } from '../src/fieldflags.js';

/** A PDF string object. */
const str = (v: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(v) });

const RV = '<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml">'
  + '<p>Plain <b>BOLD</b> <span style="font-size:20pt">Big</span></p></body>';

/** A document with one text field carrying `rv` as its rich value, `ff` added
 *  to its flags, and appearances generated. */
function richField(
  opts: { rv?: string; ff?: number; value?: string; maxLen?: number; da?: string; q?: number } = {},
): { doc: Document; dict: PdfDict } {
  const doc = Document.Open(buildBlankPage());
  const field = doc.Form.AddTextField({
    page: 1, rect: [20, 100, 320, 160], name: 'rich', value: opts.value ?? 'Plain BOLD Big',
  });
  const dict = field.Dict;
  const ff = (typeof doc.resolve(dict.get('Ff')) === 'number' ? doc.resolve(dict.get('Ff')) as number : 0);
  dict.set('Ff', ff | (opts.ff ?? FF_RICHTEXT));
  if (opts.rv !== undefined) dict.set('RV', str(opts.rv));
  if (opts.maxLen !== undefined) dict.set('MaxLen', opts.maxLen);
  if (opts.da !== undefined) dict.set('DA', str(opts.da));
  if (opts.q !== undefined) dict.set('Q', opts.q);
  doc.Form.GenerateAppearances();
  return { doc, dict };
}

/** The decoded /AP /N content stream of a widget. */
function apBody(doc: Document, dict: PdfDict): string {
  const ap = doc.resolve(dict.get('AP'));
  if (!isDict(ap)) return '';
  const n = doc.resolve((ap as PdfDict).get('N'));
  return isStream(n) ? new TextDecoder('latin1').decode(n.raw) : '';
}

describe('rich-text form fields (v0tz.5)', () => {
  it('draws each run in its own face and size', () => {
    const { doc, dict } = richField({ rv: RV });
    doc.FlattenForm();
    const frags = Document.Open(doc.Save()).Pages[0].GetTextFragments();
    const of = (t: string) => frags.find((f) => f.text.includes(t));
    expect(of('BOLD')?.fontName).toMatch(/Helvetica-Bold/);
    expect(of('Big')?.fontSize).toBe(20);
    expect(apBody(doc, dict)).not.toBe('');
  });

  it('never lets a password field draw its value as rich text', () => {
    // CLAUDE.md records that a password's value must never reach a content
    // stream: flattening bakes it into permanent page content, where no viewer
    // will ever mask it again. Rich text must not become a second route past
    // maskIfPassword.
    const secret = 'hunter2';
    const rv = `<?xml version="1.0"?><body><p><b>${secret}</b></p></body>`;
    const { doc, dict } = richField({
      rv, value: secret, ff: FF_RICHTEXT | FF_PASSWORD,
    });
    const body = apBody(doc, dict);
    expect(body).not.toContain(secret);
    // And it is still DRAWN, masked — byte for byte what the same password
    // field draws with no /RV at all. Asserting only the absence above would
    // pass for a field that drew nothing whatever.
    const plain = richField({ value: secret, ff: FF_PASSWORD });
    expect(body).toBe(apBody(plain.doc, plain.dict));
    expect(body).toContain('Tj');
  });

  it('leaves a comb field to its per-character cells', () => {
    // A comb lays one character per cell and cannot express styled runs.
    // Note a Tj COUNT cannot separate the two: RV has three runs and the comb
    // has fourteen cells, so both exceed one. Byte-identity to the same comb
    // with no /RV is the precise statement.
    const a = richField({ rv: RV, ff: FF_RICHTEXT | FF_COMB, maxLen: 14 });
    const b = richField({ ff: FF_COMB, maxLen: 14 });
    expect(apBody(a.doc, a.dict)).toBe(apBody(b.doc, b.dict));
    expect(apBody(a.doc, a.dict)).toContain('Tj');
  });

  it('falls back when /RV parses but holds no text', () => {
    const a = richField({ rv: '<body><p></p></body>' });
    const b = richField({ ff: 0 });
    expect(apBody(a.doc, a.dict)).toBe(apBody(b.doc, b.dict));
  });

  /** The x of the body's first text-matrix operator. */
  function firstTmX(body: string): number {
    const m = /1 0 0 1 ([\d.-]+) [\d.-]+ Tm/.exec(body);
    return m === null ? NaN : Number(m[1]);
  }

  it('insets the text by the appearance PAD', () => {
    // richTextBody takes the WHOLE inset since the PAD inversion, so the
    // caller adds it; miss that and the text starts hard against the box.
    const { doc, dict } = richField({ rv: RV });
    expect(firstTmX(apBody(doc, dict))).toBe(2);
  });

  it('honours /Q alignment', () => {
    const left = richField({ rv: RV });
    const centre = richField({ rv: RV, q: 1 });
    expect(firstTmX(apBody(centre.doc, centre.dict)))
      .toBeGreaterThan(firstTmX(apBody(left.doc, left.dict)) + 50);
  });

  it('seeds the base colour from /DA', () => {
    // An unstyled run inherits the field's own /DA colour, not black — every
    // other fixture here uses the default, where the two agree.
    const { doc, dict } = richField({
      rv: '<body><p>plain</p></body>', da: '/Helv 12 Tf 1 0 0 rg',
    });
    expect(apBody(doc, dict)).toContain('1 0 0 rg');
  });

  it('seeds the base family from /DA', () => {
    // /DA names the face and richlayout derives bold/italic from its family,
    // so a Times field's bold run is Times-Bold rather than Helvetica-Bold.
    const { doc } = richField({ rv: RV, da: '/Times-Roman 12 Tf 0 g' });
    doc.FlattenForm();
    const frags = Document.Open(doc.Save()).Pages[0].GetTextFragments();
    expect(frags.find((f) => f.text.includes('BOLD'))?.fontName).toMatch(/Times-Bold/);
  });

  it('draws at 12pt when /DA asks for auto-size', () => {
    // /DA size 0 means shrink-to-fit, which is ill-defined once runs carry
    // their own sizes; the FreeText path's answer is a fixed 12.
    const { doc, dict } = richField({ rv: RV, da: '/Helv 0 Tf 0 g' });
    expect(apBody(doc, dict)).toContain('12 Tf');
  });

  // Each of these draws the plain value, byte for byte as before.
  it('leaves a field without bit 26 byte-identical', () => {
    const a = richField({ rv: RV, ff: 0 });
    const b = richField({ ff: 0 });
    expect(apBody(a.doc, a.dict)).toBe(apBody(b.doc, b.dict));
  });

  it('leaves a rich-text field with no /RV byte-identical', () => {
    const a = richField({});
    const b = richField({ ff: 0 });
    expect(apBody(a.doc, a.dict)).toBe(apBody(b.doc, b.dict));
  });

  it('falls back to the plain value when /RV will not parse', () => {
    // xml.ts throws PdfParseError on a mismatched end tag; a field is never
    // drawn emptier than its plain value.
    const a = richField({ rv: '<body><p>unclosed</b></body>' });
    const b = richField({ ff: 0 });
    expect(apBody(a.doc, a.dict)).toBe(apBody(b.doc, b.dict));
  });
});
