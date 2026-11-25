import { expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { pageContentStreams } from '../src/pagecontent.js';
import { buildSimpleTextPdf, buildFormTextPdf, buildType0Pdf } from './helpers/build-text-pdf.js';

const withText = (ops: string) => Document.Open(buildSimpleTextPdf('BT /F1 10 Tf ' + ops + ' ET', { baseFont: 'Courier' }));
const occurrences = () => withText('20 100 Td (same) Tj 0 -20 Td [(same) -2000 (tail)] TJ');

it('replaces one occurrence with its own font, preserving the following pen and rejecting the old handle', () => {
  const doc = occurrences(), p = doc.Pages[0];
  const [first, target, tail] = p.GetTextFragments();
  target.text = 'caller snapshot';
  target.quad[0] = 400;
  target.ReplaceText('longer');
  const result = Document.Open(doc.Save()).Pages[0].GetTextFragments();
  expect(result.map(f => f.text)).toEqual(['same', 'longer', 'tail']);
  expect(result[0]).toEqual(first);
  expect(result[1].fontName).toBe('Courier');
  expect(result[2].quad).toEqual(tail.quad);
  expect(() => target.MoveBy(1, 2)).toThrow(RangeError);
});

it('restyles the selected occurrence while preserving the next glyph position and state', () => {
  const doc = occurrences(), p = doc.Pages[0];
  const [first, second, tail] = p.GetTextFragments();
  second.Restyle({ fontSize: 12, color: [1, 0, 0] });
  const result = Document.Open(doc.Save()).Pages[0];
  expect(result.Search('same').map(m => m.hits[0].fontSize)).toEqual([10, 12]);
  expect(result.Search('same')[1].hits[0].color).toEqual([255, 0, 0]);
  expect(result.GetTextFragments()[0].quad).toEqual(first.quad);
  expect(result.Search('tail')[0].hits[0].quad[0]).toBeCloseTo(tail.quad[0]);
  expect(result.Search('tail')[0].hits[0].color).toBeUndefined();
});

it('moves one fragment in page points and preserves text rise and later relative lines', () => {
  const doc = withText('2 0 0 2 20 140 Tm 3 Ts 15 TL [(one) -2000 (two)] TJ T* (three) Tj');
  const p = doc.Pages[0], [first, second, third] = p.GetTextFragments();
  first.MoveBy(4, 9);
  const out = Document.Open(doc.Save()).Pages[0].GetTextFragments();
  expect(out[0].quad).toEqual(first.quad.map((v, i) => v + (i % 2 ? 9 : 4)));
  expect(out[1].quad).toEqual(second.quad);
  expect(out[2].quad).toEqual(third.quad);
});

it('aligns only the chosen paragraph within its original bounds through the document read API', () => {
  const doc = withText('20 180 Td 12 TL (longest) Tj T* (xx) Tj 0 -65 Td (other) Tj');
  const p = doc.Pages[0], [paragraph, other] = doc.GetParagraphs();
  paragraph.quad[2] = 999;
  paragraph.Align('right');
  const [longest, short, last] = Document.Open(doc.Save()).Pages[0].GetTextFragments();
  expect(short.quad[2]).toBeCloseTo(longest.quad[2]);
  expect(short.quad[1]).toBe(168);
  expect(last.quad).toEqual(other.quad);
  expect(p.GetText()).toBe('longest\nxx\nother');
});

it('refuses an unencodable replacement and a multi-part fragment before writing, leaving the handle usable', () => {
  const doc = withText('20 100 Td (one) Tj (two) Tj 0 -24 Td (ok) Tj');
  const [multi, single] = doc.Pages[0].GetTextFragments(), before = doc.Save();
  expect(() => multi.ReplaceText('new')).toThrow(UnsupportedFeatureError);
  expect(() => single.ReplaceText('🦆')).toThrow(UnsupportedFeatureError);
  expect(doc.Save()).toEqual(before);
  single.ReplaceText('yes');
  expect(doc.Pages[0].GetText()).toContain('yes');
});

it('declines a joined paragraph even when the caller removes its continuation snapshot', () => {
  const doc = withText('20 180 Td (a passage) Tj');
  doc.AddPage(withText('20 180 Td (continues here) Tj').Pages[0]);
  const [joined] = doc.GetParagraphs({ joinContinuations: true }), before = doc.Save();
  delete joined.continuations;
  expect(() => joined.Align('left')).toThrow(UnsupportedFeatureError);
  expect(doc.Save()).toEqual(before);
});

it('moves only one invocation of a repeated Form', () => {
  const doc = Document.Open(buildFormTextPdf('q 1 0 0 1 10 90 cm /Fm0 Do Q q 1 0 0 1 10 30 cm /Fm0 Do Q',
    'BT /F1 10 Tf (label) Tj ET'));
  const p = doc.Pages[0], [first, second] = p.GetTextFragments();
  second.MoveBy(10, 5);
  const out = Document.Open(doc.Save()).Pages[0].GetTextFragments();
  expect(out[0].quad).toEqual(first.quad);
  expect(out[1].quad.slice(0, 2)).toEqual([20, 35]);
});

it('keeps a decoration and a replacement local to the selected Form invocation', () => {
  const doc = Document.Open(buildFormTextPdf('q 1 0 0 1 10 90 cm /Fm0 Do Q q 1 0 0 1 10 30 cm /Fm0 Do Q',
    'BT /F1 10 Tf (label) Tj ET'));
  const p = doc.Pages[0];
  p.GetTextFragments()[1].Restyle({ underline: true });
  expect(p.GetPaths()).toHaveLength(1);
  expect(p.GetPaths()[0].bbox[1]).toBeLessThan(30);
  p.GetTextFragments()[1].ReplaceText('other');
  expect(Document.Open(doc.Save()).Pages[0].GetTextFragments().map(f => f.text)).toEqual(['label', 'other']);
});

it('rolls back alignment when its second line belongs to a Form, and refuses text that establishes a clip', () => {
  const doc = Document.Open(buildFormTextPdf('BT /F1 10 Tf 20 90 Td (longer) Tj ET q 1 0 0 1 20 78 cm /Fm0 Do Q',
    'BT /F1 10 Tf (xx) Tj ET'));
  const p = doc.Pages[0], before = doc.Save();
  expect(p.GetParagraphs()).toHaveLength(1);
  expect(() => p.GetParagraphs()[0].Align('center')).toThrow(UnsupportedFeatureError);
  expect(doc.Save()).toEqual(before);
  const clipped = withText('4 Tr 20 90 Td (clip) Tj'), saved = clipped.Save();
  expect(() => clipped.Pages[0].GetTextFragments()[0].MoveBy(10, 0)).toThrow(UnsupportedFeatureError);
  expect(clipped.Save()).toEqual(saved);
});

it('justifies word gaps, retaining the last line unless full justification was requested', () => {
  const doc = withText('20 180 Td 12 TL (a b) Tj T* (long longest) Tj T* (c d) Tj');
  const p = doc.Pages[0];
  p.GetParagraphs()[0].Align('justify');
  expect(p.Search('b')[0].quads[0][2]).toBeCloseTo(92);
  expect(p.Search('d')[0].quads[0][2]).toBeCloseTo(38);
  const fresh = withText('20 180 Td 12 TL (long longest) Tj T* (c d) Tj').Pages[0];
  fresh.GetParagraphs()[0].Align('fullJustify');
  expect(fresh.Search('d')[0].quads[0][2]).toBeCloseTo(92);
});

it('restyles an original glyph code whose multi-character Unicode mapping cannot be reverse encoded', () => {
  const doc = Document.Open(buildType0Pdf('BT /F1 10 Tf 20 90 Td <0001> Tj ET',
    '1 beginbfchar\n<0001> <00660069>\nendbfchar'));
  const [fragment] = doc.Pages[0].GetTextFragments();
  expect(fragment.text).toBe('fi');
  fragment.Restyle({ color: [1, 0, 0] });
  const [match] = Document.Open(doc.Save()).Pages[0].Search('fi');
  expect(match.hits.map(g => [g.code, g.color])).toEqual([[1, [255, 0, 0]]]);
});

it('rejects a changed source even when the selected letters and position still match', () => {
  const doc = occurrences(), p = doc.Pages[0];
  const [, target] = p.GetTextFragments();
  const stream = pageContentStreams(doc, p)[0];
  const tail = Buffer.from(stream.raw).indexOf('tail');
  expect(tail).toBeGreaterThan(0);
  stream.raw[tail] = 'T'.charCodeAt(0);
  const before = doc.Save();
  expect(() => target.ReplaceText('else')).toThrow(RangeError);
  expect(doc.Save()).toEqual(before);
});

it('declines ambiguous overlapping paragraph lines while the fragment addresses still distinguish the two draws', () => {
  const doc = withText('1 0 0 1 20 100 Tm (same) Tj 1 0 0 1 20 100 Tm (same) Tj');
  const p = doc.Pages[0], before = doc.Save();
  expect(() => p.GetParagraphs()[0].Align('right')).toThrow(UnsupportedFeatureError);
  expect(doc.Save()).toEqual(before);
  p.GetTextFragments()[1].MoveBy(0, -20);
  expect(p.GetTextFragments().map(f => f.quad[1])).toEqual([100, 80]);
});
