import { expect, it } from 'vitest';
import { Document, LoadLimits, ResourceLimitError, UnsupportedFeatureError } from '../src/index.js';
import { parseContentStream } from '../src/content.js';
import { streamOf } from '../src/pagecontent.js';
import { isDict, isName, isStream, name, ref, type PdfDict, type PdfObject } from '../src/types.js';
import { buildFormTextPdf, buildSharedFormPagesPdf, buildSimpleTextPdf } from './helpers/build-text-pdf.js';

const show = 'BT /F1 12 Tf (words) Tj ET';
const enc = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const open = (s: string) => Document.Open(buildSimpleTextPdf(s));

it('removes all four shows, including undecodable text, and preserves spacing, graphics and inline image bytes', () => {
  const graphics = '12  14 m  16 18 l S % preserve spacing';
  const inline = 'BI /W 2 /H 1 /BPC 8 /CS /G ID Tj EI';
  const d = open(`BT /Missing 12 Tf (one) Tj [(two) 30] TJ (three) ' 4 5 (four) " ET\n${graphics}\n${inline}\n`);
  d.Pages[0].RemoveAllText();
  const p = Document.Open(d.Save()).Pages[0], bytes = decode(p.Contents);
  expect(bytes).toContain(graphics);
  expect(bytes).toContain(inline);
  const ops = parseContentStream(p.Contents);
  expect(ops.map(o => o.operator)).toEqual(['BT', 'Tf', 'T*', 'Tw', 'Tc', 'T*', 'ET', 'm', 'l', 'S', 'BI']);
  expect(ops.slice(3, 5).map(o => o.operands)).toEqual([[4], [5]]);
  const contents = p.Dict.get('Contents');
  p.RemoveAllText();
  expect(p.Dict.get('Contents')).toBe(contents);
});

it('cleans marked sequences across page streams and through repeated Forms, preserving image-only and shared properties', () => {
  const d = Document.Open(buildFormTextPdf('', show, { formResources: false,
    pageRes: '/Properties << /P << /ActualText (label) /Lang (en) >> >>' }));
  const p = d.Pages[0];
  p.Dict.set('Contents', ['/Span /P BDC /Fm0', 'Do /Fm0 Do EMC /Figure /P BDC 0 0 5 5 re f EMC'].map(s => d.allocObject(streamOf(enc(s)))));
  p.RemoveAllText();
  const saved = Document.Open(d.Save()).Pages[0], ops = parseContentStream(saved.Contents);
  expect(saved.GetText()).toBe('');
  const [edited, kept] = ops.filter(o => o.operator === 'BDC').map(o => o.operands[1]);
  const props = saved.Document.resolve(saved.Resources!.get('Properties')) as PdfDict;
  const clean = isName(edited) ? saved.Document.resolve(props.get(edited.name)) : edited;
  expect(isDict(clean) && clean.has('Lang') && !clean.has('ActualText')).toBe(true);
  expect(isName(kept) && kept.name).toBe('P');
  expect((props.get('P') as PdfDict).has('ActualText')).toBe(true);
  const calls = ops.filter(o => o.operator === 'Do');
  expect(calls[0].operands).toEqual(calls[1].operands);
});

it('isolates shared Forms and page resources and preserves their non-text paint', () => {
  const d = Document.Open(buildSharedFormPagesPdf('/Span << /ActualText (logical) >> BDC ' + show + ' EMC 1 2 3 4 re f'));
  const [first, second] = d.Pages;
  first.RemoveAllText();
  expect(first.GetPaths()).toHaveLength(1);
  expect(second.GetText()).toContain('words');
  const [a, b] = Document.Open(d.Save()).Pages;
  expect(a.GetText()).toBe('');
  expect(b.GetText()).toContain('words');
});

it('rejects inherited clipping in a later Form invocation before publishing any changes', () => {
  const d = Document.Open(buildFormTextPdf(show + ' /Fm0 Do q BT 7 Tr ET /Fm0 Do Q', show));
  const before = d.Save(), p = d.Pages[0], contents = p.Dict.get('Contents'), resources = p.Resources;
  expect(() => p.RemoveAllText()).toThrow(UnsupportedFeatureError);
  expect(p.Dict.get('Contents')).toBe(contents);
  expect(p.Resources).toBe(resources);
  expect(d.Save()).toEqual(before);
});

it('restores the clipping mode on Q and preserves a vector clip', () => {
  const d = open('q BT 7 Tr ET Q 0 0 8 8 re W n ' + show);
  d.Pages[0].RemoveAllText();
  expect(decode(d.Pages[0].Contents)).toContain('0 0 8 8 re W n');
  expect(d.Pages[0].GetText()).toBe('');
});

it('retains the original Form binding used by an annotation appearance and a tiling pattern', () => {
  const d = Document.Open(buildFormTextPdf('/Fm0 Do /Pattern cs /P scn 0 0 8 8 re f', show));
  const p = d.Pages[0];
  p.Dict.set('Annots', [d.allocObject(new Map<string, PdfObject>([
    ['Subtype', name('Stamp')], ['Rect', [0, 0, 10, 10]], ['AP', new Map([['N', ref(6)]])],
  ]))]);
  const pattern = streamOf(enc('/Fm0 Do'));
  pattern.dict.set('Type', name('Pattern')); pattern.dict.set('PatternType', 1);
  p.Resources!.set('Pattern', new Map([['P', d.allocObject(pattern)]]));
  p.RemoveAllText();
  const saved = Document.Open(d.Save()).Pages[0], doc = saved.Document;
  const forms = doc.resolve(saved.Resources!.get('XObject')) as PdfDict;
  const original = doc.resolve(forms.get('Fm0'));
  const ap = doc.resolve(saved.Annotations[0].Dict.get('AP')) as PdfDict;
  expect(doc.resolve(ap.get('N'))).toBe(original);
  expect(isStream(original) && decode(original.raw)).toContain('(words) Tj');
  const patterns = doc.resolve(saved.Resources!.get('Pattern')) as PdfDict;
  const tile = doc.resolve(patterns.get('P'));
  expect(isStream(tile) && decode(tile.raw)).toBe('/Fm0 Do');
});

it('honors cumulative token limits across a page and a Form before publishing', () => {
  const d = Document.Open(buildFormTextPdf('q Q /Fm0 Do', show), {
    limits: LoadLimits.defaults.with({ maxContentTokens: 8 }),
  });
  const p = d.Pages[0], contents = p.Dict.get('Contents');
  expect(() => p.RemoveAllText()).toThrow(ResourceLimitError);
  expect(p.Dict.get('Contents')).toBe(contents);
});

it('refuses a Form tied to the structure tree before changing its caller', () => {
  const d = Document.Open(buildFormTextPdf(show + ' /Fm0 Do', show));
  const form = d.getObject(6);
  if (!isStream(form)) throw new Error('expected Form');
  form.dict.set('StructParents', 0);
  const before = d.Save();
  expect(() => d.Pages[0].RemoveAllText()).toThrow(/structure-parent/);
  expect(d.Save()).toEqual(before);
});
