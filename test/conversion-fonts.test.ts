import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { getStd14Sfnt } from '../src/std14fonts.js';
import { decodeStream } from '../src/filters.js';
import { parseSfnt } from '../src/sfnt.js';
import { isStream, name, type PdfDict, type PdfObject } from '../src/types.js';
import { buildNonEmbeddedFontPdf, type FontSpec } from './helpers/build-nonembedded-font-pdf.js';
import { buildFontPdf } from './helpers/build-font-pdf.js';

const face = getStd14Sfnt('Helvetica')!;
const gid = face.cmapSubtable(3, 1)!.get(65)!;
const width = Math.round(1000 * face.advanceWidth(gid) / face.unitsPerEm);
const simple: FontSpec = { baseFont: 'LiberationSans', encoding: name('WinAnsiEncoding'),
  widths: [...Array(33).fill(0), width], text: 'A' };
const composite: FontSpec = { baseFont: 'ABCDEF+LiberationSans', subtype: 'Type0',
  text: 'A', cidWidths: [65, [width]], toUnicode: '1 beginbfchar <0041> <0041> endbfchar' };
let folder: string;
beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'conversion-fonts-'));
  writeFileSync(join(folder, 'face.ttf'), face.raw);
});
afterAll(() => rmSync(folder, { recursive: true, force: true }));

function open(spec: FontSpec, source = folder): Document {
  const doc = Document.Open(buildNonEmbeddedFontPdf([spec]));
  doc.RegisterFontFolder(source);
  return doc;
}

function pageFont(doc: Document): PdfDict {
  const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font')) as PdfDict;
  return doc.resolve(fonts.get('F1')) as PdfDict;
}

function descendant(doc: Document): PdfDict {
  const font = pageFont(doc);
  return doc.resolve((doc.resolve(font.get('DescendantFonts')) as PdfObject[])[0]) as PdfDict;
}

describe('registered font embedding during conversion', () => {
  for (const target of ['PDF/A', 'PDF/UA'] as const) {
    const convert = (doc: Document, embedFonts?: boolean) => target === 'PDF/A'
      ? doc.ConvertToPdfA('1b', { embedFonts }) : doc.ConvertToPdfUa({ part: 2, embedFonts });
    it(`${target} requires explicit opt-in even after registration`, () => {
      for (const opt of [undefined, false]) {
        const doc = open(simple);
        expect(convert(doc, opt).fontEmbedding).toBeUndefined();
        expect(doc.Fonts[0].embedded).toBe(false);
      }
    });
    it.each([simple, composite])(`${target} preserves shown text and widths for $baseFont`, (spec) => {
      const doc = open(spec);
      const before = doc.Pages[0].GetTextFragments().map(f => f.quad);
      const report = convert(doc, true);
      expect(report.fontEmbedding?.embedded).toMatchObject([{ name: 'LiberationSans', source: 'registered' }]);
      const saved = Document.Open(doc.Save());
      expect(saved.Fonts[0].embedded).toBe(true);
      expect(saved.Pages[0].GetText()).toBe('A');
      expect(saved.Pages[0].GetTextFragments().map(f => f.quad)).toEqual(before);
      const embedded = spec.subtype === 'Type0' ? descendant(saved) : pageFont(saved);
      const fd = saved.resolve(embedded.get('FontDescriptor')) as PdfDict;
      const stream = saved.resolve(fd.get('FontFile2'));
      if (!isStream(stream)) throw new Error('missing TrueType program');
      const sfnt = parseSfnt(decodeStream(stream));
      expect(sfnt.glyphData(gid)).toEqual(face.glyphData(gid));
      expect(sfnt.advanceWidth(gid)).toBe(face.advanceWidth(gid));
      if (spec.subtype === 'Type0') {
        const desc = descendant(saved);
        expect(saved.resolve(desc.get('W'))).toEqual([65, [width]]);
        const map = saved.resolve(desc.get('CIDToGIDMap'));
        expect(isStream(map) && Buffer.from(decodeStream(map)).readUInt16BE(130)).toBe(gid);
        const descriptor = saved.resolve(desc.get('FontDescriptor')) as PdfDict;
        const set = saved.resolve(descriptor.get('CIDSet'));
        if (target === 'PDF/A') {
          expect(isStream(set) && Array.from(decodeStream(set))).toEqual([128, 0, 0, 0, 0, 0, 0, 0, 64]);
          expect(report.unresolved.map(i => i.rule)).not.toContain('FontCIDSet');
        } else expect(set).toBeNull();
      }
    });
    it(`${target} reports a width mismatch and leaves the font unembedded`, () => {
      const doc = open({ ...simple, widths: Array(34).fill(width + 50) });
      expect(convert(doc, true).fontEmbedding?.skipped).toMatchObject([{ reason: 'width-mismatch' }]);
      expect(doc.Fonts[0].embedded).toBe(false);
    });
  }
  it('honors the PDF/A preserve option even with opt-in', async () => {
    const doc = open(simple);
    const report = await doc.ConvertToPdfAAsync('2b', { embedFonts: true, preserve: ['fontEmbedding'] });
    expect(report.fontEmbedding).toBeUndefined();
    expect(doc.Fonts[0].embedded).toBe(false);
  });
  it('refuses restricted and bitmap-only registered outlines', () => {
    for (const flags of [2, 0x200]) {
      const dir = mkdtempSync(join(folder, 'restricted-'));
      const bytes = Uint8Array.from(face.raw);
      const os2 = face.table('OS/2')!;
      const offset = os2.byteOffset - face.raw.byteOffset;
      new DataView(bytes.buffer).setUint16(offset + 8, flags);
      writeFileSync(join(dir, 'face.ttf'), bytes);
      const doc = open(simple, dir);
      expect(doc.ConvertToPdfA('2b', { embedFonts: true }).fontEmbedding?.skipped)
        .toMatchObject([{ reason: 'license' }]);
      expect(doc.Fonts[0].embedded).toBe(false);
    }
  });
  it('reports raw Type 1 permissions as unverifiable', () => {
    const raw = readFileSync('test/fixtures/fonts/NimbusSans-Regular.t1');
    const at = raw.indexOf('/FontName');
    expect(at).toBeGreaterThan(0);
    const dir = mkdtempSync(join(folder, 'type1-'));
    writeFileSync(join(dir, 'Nimbus.pfa'), Buffer.concat([raw.subarray(0, at), Buffer.from('/FSType 2 def\n'), raw.subarray(at)]));
    const doc = open({ ...simple, baseFont: 'NimbusSans-Regular' }, dir);
    expect(doc.ConvertToPdfA('2b', { embedFonts: true }).fontEmbedding?.skipped)
      .toMatchObject([{ reason: 'license' }]);
  });
  it('writes a missing PDF/A-1 CIDSet for an already embedded Identity-H subset', () => {
    const doc = open(composite);
    doc.EmbedFonts();
    const saved = Document.Open(doc.Save());
    expect(saved.ValidatePdfA('1b').Errors.map(x => x.rule)).toContain('FontCIDSet');
    expect(saved.ConvertToPdfA('1b', { embedFonts: true }).unresolved.map(x => x.rule)).not.toContain('FontCIDSet');
    const fd = saved.resolve(descendant(saved).get('FontDescriptor')) as PdfDict;
    const set = saved.resolve(fd.get('CIDSet'));
    expect(isStream(set) && Array.from(decodeStream(set))).toEqual([128, 0, 0, 0, 0, 0, 0, 0, 64]);
  });
  it.each(['2b', '3b'] as const)('omits a stale optional CIDSet when converting to %s', level => {
    const doc = open(composite);
    doc.EmbedFonts();
    const fd = doc.resolve(descendant(doc).get('FontDescriptor')) as PdfDict;
    fd.set('CIDSet', doc.allocObject({ kind: 'stream', dict: new Map(), raw: Uint8Array.of(0) }));
    const result = doc.ConvertToPdfA(level, { embedFonts: true });
    expect(result.applied.some(a => a.rule === 'FontCIDSet')).toBe(true);
    expect((doc.resolve(descendant(doc).get('FontDescriptor')) as PdfDict).has('CIDSet')).toBe(false);
  });
  it('repairs a conflicting embedded CMap WMode when conversion opts in', async () => {
    const pdf = buildFontPdf({ type0: { encoding: 'X', embeddedCMap: { wmode: 0, dictWMode: 1 } }, text: 'A' });
    for (const [part, enabled] of [[1, true], [2, false], [2, true]] as const) {
      const doc = Document.Open(pdf);
      const original = doc.resolve(pageFont(doc).get('Encoding'));
      if (!isStream(original)) throw new Error('missing CMap');
      const report = await doc.ConvertToPdfUaAsync({ part, embedFonts: enabled });
      expect(report.applied.some(a => a.rule === 'CMapWModeMatch')).toBe(enabled);
      const saved = Document.Open(doc.Save());
      const cmap = saved.resolve(pageFont(saved).get('Encoding'));
      if (!isStream(cmap)) throw new Error('missing saved CMap');
      expect(cmap.raw).toEqual(original.raw);
      expect(cmap.dict.get('WMode')).toBe(enabled ? 0 : 1);
      expect(saved.ValidatePdfUa(2).Errors.some(i => i.rule === 'CMapWModeMatch')).toBe(!enabled);
    }
    const archival = Document.Open(pdf);
    expect(archival.ConvertToPdfA('2b', { embedFonts: true }).applied.some(a => a.rule === 'CMapWModeMatch')).toBe(true);
  });
});
