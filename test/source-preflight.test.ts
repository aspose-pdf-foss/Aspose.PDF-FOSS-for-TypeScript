import { expect, it } from 'vitest';
import { Document, LoadLimits } from '../src/index.js';
import { buildClassicPdf, buildXrefStreamPdf } from './helpers/build-pdf.js';
import { corruptStartxref } from './helpers/damage-pdf.js';
import { buildRawPdf } from './helpers/build-page-tree-pdf.js';
import { sourceObjectStream } from '../src/objstm.js';
import type { PdfDict } from '../src/types.js';

function replace(bytes: Uint8Array, from: string, to: string): Buffer {
  expect(to.length).toBe(from.length);
  const copy = Buffer.from(bytes);
  const at = copy.indexOf(from);
  expect(at).toBeGreaterThanOrEqual(0);
  copy.write(to, at, 'latin1');
  return copy;
}

it('accepts intact classic and stream xrefs', () => {
  for (const bytes of [buildClassicPdf(2), buildXrefStreamPdf()])
    expect(Document.Preflight(bytes).findings).toEqual([]);
});

it('reports the broken source xref even when Open recovers the pages', () => {
  const damaged = corruptStartxref(buildClassicPdf(2));
  const backing = Buffer.concat([Buffer.from('prefix'), damaged, Buffer.from('suffix')]);
  const bytes = backing.subarray(6, 6 + damaged.length);
  const before = Buffer.from(backing);
  expect(Document.Preflight(bytes).findings).toMatchObject([{ category: 'malformed', stage: 'xref' }]);
  const doc = Document.Open(bytes);
  expect(doc.recovery?.reason).toBe('startxref-unreadable');
  expect(doc.Pages.length).toBe(2);
  expect(backing).toEqual(before);
});

it('locates header and footer problems independently', () => {
  const bytes = replace(replace(buildClassicPdf(1), '%PDF-1.7', '%PDF-x.y'), '%%EOF', '%%bad');
  expect(Document.Preflight(bytes).findings).toMatchObject([
    { category: 'malformed', stage: 'header' }, { category: 'malformed', stage: 'xref' },
  ]);
});

it('stops at the first enforced bound and reports its measured values', () => {
  const bytes = buildClassicPdf(2);
  for (const [field, reached, stage] of [
    ['maxFileBytes', bytes.length, 'input'], ['maxObjects', 2, 'xref'],
  ] as const) {
    const limits = LoadLimits.defaults.with({ [field]: 1 });
    expect(Document.Preflight(bytes, { limits }).findings).toMatchObject([
      { category: 'limit', stage, limit: field, allowed: 1, reached },
    ]);
  }
});

it('distinguishes an unsupported structural filter from malformed xref data', () => {
  const bytes = replace(buildXrefStreamPdf(), '/FlateDecode', '/OtherDecode');
  expect(Document.Preflight(bytes).findings).toMatchObject([{ category: 'unsupported', stage: 'xref' }]);
});

const catalog = '<< /Type /Catalog /Pages 2 0 R >>';
const pages = '<< /Type /Pages /Count 0 /Kids [] >>';

it('checks object identity, generation and termination independently', () => {
  let bytes = replace(buildRawPdf([catalog, pages, 'null', 'false', 'true']), '3 0 obj', '8 0 obj');
  bytes = replace(bytes, '4 0 obj', '4 1 obj');
  bytes = replace(bytes, 'true\nendobj', 'true\nxndobj');
  expect(Document.Preflight(bytes).findings).toMatchObject([3, 4, 5].map(objectNumber => ({
    stage: 'object', category: 'malformed', objectNumber,
  })));
});

it('checks indirect stream lengths by reference even when the payload contains an end marker', () => {
  const payload = 'abc\nendstream\nendobj\nxyz';
  const bytes = buildRawPdf([catalog, pages, `<< /Length 4 0 R >>\nstream\n${payload}\nendstream`, String(payload.length)]);
  expect(Document.Preflight(bytes).findings).toEqual([]);
  for (const length of ['1 0 R', '3 0 R', '4 1 R', '    7']) {
    expect(Document.Preflight(replace(bytes, '/Length 4 0 R', '/Length ' + length)).findings)
      .toMatchObject([{ category: 'malformed', stage: 'object', objectNumber: 3 }]);
  }
});

it('reports a bad trailer root and stops on an object nesting limit', () => {
  const bytes = buildRawPdf([catalog, pages, '[[[[1]]]]']);
  expect(Document.Preflight(replace(bytes, '/Root 1 0 R', '/Root 2 0 R')).findings)
    .toMatchObject([{ category: 'malformed', stage: 'trailer' }]);
  const limits = LoadLimits.defaults.with({ maxNestingDepth: 2 });
  expect(Document.Preflight(bytes, { limits }).findings)
    .toMatchObject([{ category: 'limit', stage: 'object', objectNumber: 3, limit: 'maxNestingDepth' }]);
});

it('accepts compressed and incremental saves and ignores a free entry', () => {
  const bytes = buildClassicPdf(1);
  const doc = Document.Open(bytes);
  expect(Document.Preflight(doc.Save({ compressed: true })).findings).toEqual([]);
  doc.AddPage();
  expect(Document.Preflight(doc.Save({ incremental: true })).findings).toEqual([]);
  const free = buildRawPdf([catalog, pages, 'invalidBody']);
  const at = Buffer.from(free).indexOf('3 0 obj').toString().padStart(10, '0');
  expect(Document.Preflight(replace(free, at + ' 00000 n', '0000000000 00001 f')).findings).toEqual([]);
});

// A raw xref stream makes the type-2 slot and the object-stream members independently editable.
function compressedSource(index = 0, encryption = '', member = catalog): Buffer {
  const body = `%PDF-1.5\n2 0 obj\n${pages}\nendobj\n`;
  const data = '1 0 ' + member;
  const container = `3 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`;
  const xref = body.length + container.length;
  const rows = Buffer.from([0,0,0,255, 2,0,3,index, 1,0,9,0, 1,0,body.length,0, 1,xref >> 8,xref & 255,0]);
  return Buffer.concat([Buffer.from(body + container + `4 0 obj\n<< /Type /XRef /Size 5 /W [1 2 1] /Length 20 /Root 1 0 R ${encryption}>>\nstream\n`),
    rows, Buffer.from(`\nendstream\nendobj\nstartxref\n${xref}\n%%EOF\n`)]);
}

it('checks compressed member indices and syntax and identifies encrypted coverage', () => {
  expect(Document.Preflight(compressedSource()).findings).toEqual([]);
  expect(Document.Preflight(compressedSource(1)).findings).toContainEqual(expect.objectContaining({
    stage: 'object', category: 'malformed', objectNumber: 1,
  }));
  expect(Document.Preflight(compressedSource(0, '', 'invalidBody')).findings)
    .toContainEqual(expect.objectContaining({ stage: 'object', category: 'malformed' }));
  expect(Document.Preflight(compressedSource(0, '/Encrypt 5 0 R ')).findings)
    .toMatchObject([{ category: 'unsupported', stage: 'object' }]);
});

it('reports malformed xref rows and stream dimensions', () => {
  for (const bytes of [
    replace(buildClassicPdf(1), '00000 n', '00000 z'),
    replace(compressedSource(), '/W [1 2 1]', '/W [1 4 1]'),
    replace(compressedSource(), '/W [1 2 1]', '/W [x 2 1]'),
  ]) expect(Document.Preflight(bytes).findings[0]).toMatchObject({ category: 'malformed', stage: 'xref' });
});

it('accepts the paired first-page and main xrefs of a linearized save', () => {
  const bytes = Document.Open(buildClassicPdf(2)).Save({ linearized: true });
  expect(Document.Preflight(bytes).findings).toEqual([]);
});

it('uses a hybrid xref stream in preference to a classic free placeholder', () => {
  const source = compressedSource();
  const at = source.indexOf('startxref');
  const streamAt = source.indexOf('4 0 obj');
  const bytes = Buffer.concat([source.subarray(0, at), Buffer.from(
    `xref\n1 1\n0000000000 00000 f \ntrailer\n<< /Root 1 0 R /Size 5 /XRefStm ${streamAt} >>\nstartxref\n${at}\n%%EOF\n`)]);
  expect(Document.Preflight(bytes).findings).toEqual([]);
});

it('requires a delimiter between endstream and endobj', () => {
  const bytes = replace(buildClassicPdf(1), 'endstream\nendobj', 'endstreamendobj ');
  expect(Document.Preflight(bytes).findings).toMatchObject([{ stage: 'object', category: 'malformed' }]);
});

it('omits the location when an xref row points outside the source view', () => {
  const bytes = buildClassicPdf(1);
  const at = Buffer.from(bytes).indexOf('2 0 obj').toString().padStart(10, '0');
  const report = Document.Preflight(replace(bytes, at + ' 00000 n', '9999999999 00000 n'));
  expect(report.findings).toMatchObject([{ objectNumber: 2, category: 'malformed' }]);
  expect(report.findings[0].offset).toBeUndefined();
});

it('bounds the trailing token in a decoded object-stream header', () => {
  const header = '1 0 unexpected ';
  const dict: PdfDict = new Map([['N', 1], ['First', header.length]]);
  const stream = { kind: 'stream' as const, dict, raw: Buffer.from(header + 'null') };
  expect(() => sourceObjectStream(stream, 3, LoadLimits.defaults.with({ maxObjectBytes: 3 })))
    .toThrowError(expect.objectContaining({ limit: 'maxObjectBytes' }));
});
