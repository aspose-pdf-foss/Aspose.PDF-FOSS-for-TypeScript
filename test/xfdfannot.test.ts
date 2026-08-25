import { describe, expect, it } from 'vitest';
import { writeAnnots, readAnnots, encodeAppearance, decodeAppearance } from '../src/xfdfannot.js';
import { writeXml, parseXml } from '../src/xml.js';
import type { AnnotData } from '../src/annotdata.js';
import type { SkippedAnnot } from '../src/formdata.js';
import { PdfDict, PdfName, PdfObject, PdfStream, isName, isStream, isString, name } from '../src/types.js';
import { readFileSync } from 'node:fs';

/** The decoded <appearance> payload of a real Acrobat-produced XFDF.
 *  See test/fixtures/xfdf/README.md for provenance. */
const acrobatAppearanceXml = (): Uint8Array =>
  new Uint8Array(readFileSync(new URL('./fixtures/xfdf/acrobat-stamp-appearance.xml', import.meta.url)));

const encStr = (s: string): PdfObject =>
  ({ kind: 'string', bytes: new TextEncoder().encode(s) });

const annot = (
  subtype: string, entries: [string, PdfObject][], extra: Partial<AnnotData> = {},
): AnnotData =>
  ({ page: 0, dict: new Map<string, PdfObject>([['Subtype', name(subtype)], ...entries]), ...extra });

const xml = (annots: AnnotData[]) => writeXml(writeAnnots(annots));

describe('writeAnnots', () => {
  it('maps the subtype to its XFDF element name, lowercased', () => {
    expect(xml([annot('StrikeOut', [['Rect', [1, 2, 3, 4]]])])).toContain('<strikeout');
    expect(xml([annot('PolyLine', [['Rect', [1, 2, 3, 4]]])])).toContain('<polyline');
  });

  it('writes rect and page, with page 0-based', () => {
    const out = xml([{ page: 2, dict: new Map<string, PdfObject>([
      ['Subtype', name('Square')], ['Rect', [1, 2, 3, 4.5]],
    ]) }]);
    expect(out).toContain('rect="1,2,3,4.5"');
    expect(out).toContain('page="2"');
  });

  it('writes colours as #RRGGBB', () => {
    const out = xml([annot('Square', [['Rect', [0, 0, 1, 1]], ['C', [1, 0, 0]], ['IC', [0, 0.5, 1]]])]);
    expect(out).toContain('color="#FF0000"');
    expect(out).toContain('interior-color="#0080FF"');
  });

  it('writes /F as a comma-separated flag name list', () => {
    const out = xml([annot('Square', [['Rect', [0, 0, 1, 1]], ['F', 6]])]);  // hidden|print
    expect(out).toContain('flags="hidden,print"');
  });

  it('writes /Contents as a child element, not an attribute', () => {
    const out = xml([annot('Text', [['Rect', [0, 0, 1, 1]], ['Contents', encStr('a & b')]])]);
    expect(out).toContain('<contents>a &amp; b</contents>');
  });

  it('writes /RC verbatim, without escaping its markup', () => {
    const out = xml([annot('Text', [['Rect', [0, 0, 1, 1]], ['RC', encStr('<b>hi</b>')]])]);
    expect(out).toContain('<contents-richtext><b>hi</b></contents-richtext>');
  });

  it('writes /QuadPoints as coords and /Vertices as vertices', () => {
    const hi = xml([annot('Highlight', [['Rect', [0, 0, 1, 1]], ['QuadPoints', [0, 1, 2, 3, 4, 5, 6, 7]]])]);
    expect(hi).toContain('coords="0,1,2,3,4,5,6,7"');
    const pg = xml([annot('Polygon', [['Rect', [0, 0, 1, 1]], ['Vertices', [0, 0, 5, 5]]])]);
    expect(pg).toContain('vertices="0,0,5,5"');
  });

  it('writes /InkList with semicolon-separated subpaths', () => {
    const out = xml([annot('Ink', [['Rect', [0, 0, 1, 1]], ['InkList', [[0, 0, 1, 1], [2, 2, 3, 3]]]])]);
    expect(out).toContain('inklist="0,0,1,1;2,2,3,3"');
  });

  it('writes /L as start and end, and /LE as head and tail', () => {
    const out = xml([annot('Line', [
      ['Rect', [0, 0, 9, 9]], ['L', [1, 2, 8, 9]],
      ['LE', [name('None'), name('OpenArrow')]],
    ])]);
    expect(out).toContain('start="1,2"');
    expect(out).toContain('end="8,9"');
    expect(out).toContain('head="None"');
    expect(out).toContain('tail="OpenArrow"');
  });

  it('writes the border width from /BS /W', () => {
    const out = xml([annot('Square', [
      ['Rect', [0, 0, 1, 1]], ['BS', new Map<string, PdfObject>([['W', 3]])],
    ])]);
    expect(out).toContain('width="3"');
  });

  it('writes the popup as a nested element and a reply as inreplyto', () => {
    const out = xml([
      annot('Text', [['Rect', [0, 0, 1, 1]], ['NM', encStr('n1')]], { popupName: 'p1' }),
      annot('Popup', [['Rect', [5, 5, 9, 9]], ['NM', encStr('p1')]]),
      annot('Highlight', [['Rect', [0, 0, 1, 1]], ['NM', encStr('h1')]], { inReplyTo: 'n1' }),
    ]);
    expect(out).toContain('inreplyto="n1"');
    expect(out).toContain('<popup');
    // The popup is nested inside its parent, not emitted again at top level.
    expect(out.match(/<popup/g)?.length).toBe(1);
  });

  it('emits an empty <annots/> for no annotations', () => {
    expect(xml([])).toContain('<annots/>');
  });

  it('skips a subtype with no XFDF element rather than inventing one', () => {
    expect(xml([annot('Movie', [['Rect', [0, 0, 1, 1]]])])).toContain('<annots/>');
  });
});

const parse = (xmlText: string): { annots: AnnotData[]; skipped: SkippedAnnot[] } => {
  const skipped: SkippedAnnot[] = [];
  const annots = readAnnots(parseXml(new TextEncoder().encode(xmlText)), skipped);
  return { annots, skipped };
};

const subtypeOf = (a: AnnotData): string => {
  const s = a.dict.get('Subtype');
  return isName(s) ? s.name : '';
};

const strOf = (v: PdfObject | undefined): string =>
  isString(v) ? new TextDecoder('latin1').decode(v.bytes) : '';

describe('readAnnots', () => {
  it('maps the element name back to the PDF subtype', () => {
    const { annots } = parse('<annots><strikeout page="0" rect="1,2,3,4"/></annots>');
    expect(subtypeOf(annots[0])).toBe('StrikeOut');
  });

  it('parses rect, colour and flags back into dict entries', () => {
    const { annots } = parse(
      '<annots><square page="1" rect="1,2,3,4.5" color="#FF0000" flags="hidden,print"/></annots>');
    const a = annots[0];
    expect(a.page).toBe(1);
    expect(a.dict.get('Rect')).toEqual([1, 2, 3, 4.5]);
    expect(a.dict.get('C')).toEqual([1, 0, 0]);
    expect(a.dict.get('F')).toBe(6);
  });

  it('reads coords, vertices, inklist, start/end and width', () => {
    const hi = parse('<annots><highlight page="0" rect="0,0,1,1" coords="0,1,2,3,4,5,6,7"/></annots>');
    expect(hi.annots[0].dict.get('QuadPoints')).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const ink = parse('<annots><ink page="0" rect="0,0,1,1" inklist="0,0,1,1;2,2,3,3"/></annots>');
    expect(ink.annots[0].dict.get('InkList')).toEqual([[0, 0, 1, 1], [2, 2, 3, 3]]);
    const ln = parse('<annots><line page="0" rect="0,0,9,9" start="1,2" end="8,9"/></annots>');
    expect(ln.annots[0].dict.get('L')).toEqual([1, 2, 8, 9]);
    const sq = parse('<annots><square page="0" rect="0,0,1,1" width="3"/></annots>');
    expect((sq.annots[0].dict.get('BS') as PdfDict).get('W')).toBe(3);
  });

  it('reads <contents> and carries <contents-richtext> verbatim', () => {
    const { annots } = parse(
      '<annots><text page="0" rect="0,0,1,1"><contents>a &amp; b</contents>' +
      '<contents-richtext><b>hi</b></contents-richtext></text></annots>');
    expect(strOf(annots[0].dict.get('Contents'))).toBe('a & b');
    expect(strOf(annots[0].dict.get('RC'))).toBe('<b>hi</b>');
  });

  it('lifts a nested <popup> into its own entry and a popupName link', () => {
    const { annots } = parse(
      '<annots><text page="0" rect="0,0,1,1" name="n1">' +
      '<popup page="0" rect="5,5,9,9" name="p1"/></text></annots>');
    expect(annots.length).toBe(2);
    const note = annots.find((a) => subtypeOf(a) === 'Text')!;
    expect(note.popupName).toBe('p1');
    expect(annots.some((a) => subtypeOf(a) === 'Popup')).toBe(true);
  });

  it('reads inreplyto into the neutral model', () => {
    const { annots } = parse('<annots><highlight page="0" rect="0,0,1,1" inreplyto="n1"/></annots>');
    expect(annots[0].inReplyTo).toBe('n1');
  });

  it('skips an element outside the vocabulary and keeps going', () => {
    const { annots, skipped } = parse(
      '<annots><movie page="0" rect="0,0,1,1"/><square page="0" rect="0,0,1,1"/></annots>');
    expect(annots.length).toBe(1);
    expect(skipped).toEqual([{ reason: 'unsupported annotation type' }]);
  });

  it('skips an annotation with a missing or non-numeric page', () => {
    const { annots, skipped } = parse('<annots><square rect="0,0,1,1"/></annots>');
    expect(annots).toEqual([]);
    expect(skipped[0].reason).toBe('missing page index');
  });

  it('skips an annotation whose coordinate list is malformed', () => {
    const { annots, skipped } = parse('<annots><square page="0" rect="1,two,3,4"/></annots>');
    expect(annots).toEqual([]);
    expect(skipped[0].reason).toBe('malformed rect');
  });

  it('finds <annots> nested under an <xfdf> root', () => {
    const { annots } = parse(
      '<xfdf><fields/><annots><square page="0" rect="0,0,1,1"/></annots></xfdf>');
    expect(annots.length).toBe(1);
  });

  it('returns nothing when there is no <annots> element at all', () => {
    const { annots, skipped } = parse('<xfdf><fields/></xfdf>');
    expect(annots).toEqual([]);
    expect(skipped).toEqual([]);
  });
});

describe('appearance codec', () => {
  const stream = (): PdfStream => ({
    kind: 'stream',
    dict: new Map<string, PdfObject>([['Subtype', name('Form')], ['BBox', [0, 0, 10, 10]]]),
    raw: new TextEncoder().encode('q 1 0 0 rg 0 0 5 5 re f Q'),
  });

  it('round-trips a form XObject byte-for-byte', () => {
    const back = decodeAppearance(encodeAppearance(stream()));
    expect(back).toBeDefined();
    expect(back!.raw).toEqual(stream().raw);
    expect(back!.dict.get('BBox')).toEqual([0, 0, 10, 10]);
  });

  it('returns undefined for base64 that is not a PDF stream', () => {
    expect(decodeAppearance('bm90IGEgcGRmIHN0cmVhbQ==')).toBeUndefined();
  });

  it('returns undefined for input that is not base64 at all', () => {
    expect(decodeAppearance('!!! not base64 !!!')).toBeUndefined();
  });

  it('returns undefined for an empty payload', () => {
    expect(decodeAppearance('   ')).toBeUndefined();
  });

  it('writes an <appearance> child for an inline /AP /N', () => {
    const a: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([
        ['Subtype', name('Square')], ['Rect', [0, 0, 10, 10]],
        ['AP', new Map<string, PdfObject>([['N', stream()]])],
      ]),
    };
    expect(writeXml(writeAnnots([a]))).toContain('<appearance>');
  });

  it('reads an <appearance> child into /AP /N', () => {
    const b64 = encodeAppearance(stream());
    const { annots } = parse(
      `<annots><square page="0" rect="0,0,10,10"><appearance>${b64}</appearance></square></annots>`);
    const ap = annots[0].dict.get('AP') as PdfDict;
    expect(isStream(ap.get('N'))).toBe(true);
  });

  it("reads Acrobat's COS-XML <appearance> encoding into the /N stream", () => {
    const n = decodeAppearance(Buffer.from(acrobatAppearanceXml()).toString('base64'));
    expect(n).toBeDefined();
    expect(isName(n!.dict.get('Subtype'))).toBe(true);
    expect((n!.dict.get('Subtype') as PdfName).name).toBe('Form');
    expect(n!.dict.get('BBox')).toEqual([0, 0, 512, 512]);
    expect(n!.dict.get('FormType')).toBe(1);
    // The 68-byte content stream, verbatim from Acrobat.
    expect(new TextDecoder().decode(n!.raw)).toContain('/xobj1 Do');
  });

  it("carries nested streams through Acrobat's COS-XML encoding", () => {
    const n = decodeAppearance(Buffer.from(acrobatAppearanceXml()).toString('base64'))!;
    const res = n.dict.get('Resources') as PdfDict;
    const xobj = res.get('XObject') as PdfDict;
    const img = xobj.get('xobj1') as PdfStream;
    expect(isStream(img)).toBe(true);
    expect((img.dict.get('Filter') as PdfName).name).toBe('DCTDecode');
    expect(img.dict.get('Interpolate')).toBe(true);
    expect(isStream(img.dict.get('SMask'))).toBe(true);
    // <DATA ENCODING="HEX" MODE="RAW"> holds the still-filtered bytes.
    expect(img.raw.length).toBe(8);
  });

  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

  it('reads COS-XML <DATA ENCODING="ASCII"> as already-decoded bytes', () => {
    const n = decodeAppearance(b64(
      '<DICT KEY="AP"><STREAM KEY="N">' +
      '<NAME KEY="Subtype" VAL="Form"/><NAME KEY="Filter" VAL="FlateDecode"/>' +
      '<DATA ENCODING="ASCII" MODE="RAW">0 0 1 rg</DATA>' +
      '</STREAM></DICT>'))!;
    expect(new TextDecoder().decode(n.raw)).toBe('0 0 1 rg');
    // ASCII carries decoded content, so the declared filter no longer applies.
    expect(n.dict.has('Filter')).toBe(false);
    expect(n.dict.get('Length')).toBe(8);
  });

  it('rejects COS-XML whose root is not the /AP dict', () => {
    expect(decodeAppearance(b64('<DICT KEY="Other"><STREAM KEY="N"/></DICT>'))).toBeUndefined();
  });

  it('rejects COS-XML that carries no /N stream', () => {
    expect(decodeAppearance(b64('<DICT KEY="AP"><STREAM KEY="D"/></DICT>'))).toBeUndefined();
  });

  it('rejects COS-XML with a malformed hex body rather than truncating it', () => {
    expect(decodeAppearance(b64(
      '<DICT KEY="AP"><STREAM KEY="N"><DATA ENCODING="HEX">zzzz</DATA></STREAM></DICT>')))
      .toBeUndefined();
  });

  it('ignores an unusable <appearance> without reporting a skip', () => {
    const { annots, skipped } = parse(
      '<annots><square page="0" rect="0,0,10,10"><appearance>@@@</appearance></square></annots>');
    expect(annots.length).toBe(1);
    expect(annots[0].dict.has('AP')).toBe(false);
    expect(skipped).toEqual([]);
  });

  it('survives a full write/read round trip with the appearance intact', () => {
    const a: AnnotData = {
      page: 2,
      dict: new Map<string, PdfObject>([
        ['Subtype', name('Square')], ['Rect', [0, 0, 10, 10]],
        ['AP', new Map<string, PdfObject>([['N', stream()]])],
      ]),
    };
    const { annots } = parse(writeXml(writeAnnots([a])));
    const ap = annots[0].dict.get('AP') as PdfDict;
    expect((ap.get('N') as PdfStream).raw).toEqual(stream().raw);
    expect(annots[0].page).toBe(2);
  });
});
