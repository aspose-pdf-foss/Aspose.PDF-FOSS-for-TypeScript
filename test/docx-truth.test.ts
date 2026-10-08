import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  mergeSegments, leafDiff, comparable, readerDisagreements, truthOf, readTruth, assertTruthShape, type DocxTruth,
} from './helpers/docx-truth.js';
import { readDocx } from '../src/wmlread.js';
import { buildOoxmlPackage } from '../src/ooxml.js';
import { docXml, p, r } from './helpers/wml.js';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
const read = (body: string, rels: { id: string; type: string; target: string; external?: boolean }[] = []) =>
  readDocx(buildOoxmlPackage([{ path: 'word/document.xml', bytes: docXml(body), contentType: `${CT}.document.main+xml` }],
    [{ source: '', id: 'rId1', type: `${REL}/officeDocument`, target: 'word/document.xml' },
      ...rels.map((x) => ({ source: 'word/document.xml', ...x }))]));

const truth = (over: Partial<DocxTruth> = {}): DocxTruth => ({
  reader: 'R', paragraphs: [], tables: [], links: [], images: 0, notes: { footnotes: [], endnotes: [] },
  counts: { headers: 0, footers: 0, footnotes: 0, endnotes: 0, textBoxes: 0, fields: 0, comments: 0, revisions: 0 },
  ...over,
});
const seg = (text: string, bold = false) => ({ text, bold, italic: false, sizePt: 10, font: 'F' });

describe('mergeSegments', () => {
  it('merges adjacent equal formatting and drops empty text', () => {
    expect(mergeSegments([seg('a'), seg(''), seg('b'), seg('c', true), seg('d', true), seg('e')]))
      .toEqual([seg('ab'), seg('cd', true), seg('e')]);
  });
});

describe('leafDiff', () => {
  it('reports leaf paths, array lengths, and compares arrays up to the shorter', () => {
    expect(leafDiff({ a: [1, 2, 3], b: { c: 'x' } }, { a: [1, 9], b: { c: 'y', d: 1 } }))
      .toEqual(['a.length', 'a[1]', 'b.c', 'b.d']);
  });

  it('tolerates a float difference under 0.01', () => {
    expect(leafDiff({ s: 10.5 }, { s: 10.504 })).toEqual([]);
    expect(leafDiff({ s: 10.5 }, { s: 10.6 })).toEqual(['s']);
  });
});

describe('comparable and readerDisagreements', () => {
  it('never compares the reader name or a style name, and compares counts', () => {
    const a = truth({ reader: 'Word', paragraphs: [{ text: 'x', styleName: 'Заголовок 1', heading: 1, listLabel: null, inTable: false, segments: [] }] });
    const b = truth({ reader: 'LO', paragraphs: [{ text: 'x', styleName: 'Heading 1', heading: 1, listLabel: null, inTable: false, segments: [] }] });
    expect(readerDisagreements(a, b)).toEqual([]);
    b.counts.footnotes = 1;
    expect(readerDisagreements(a, b)).toEqual(['counts.footnotes']);
    expect(Object.keys(comparable(a))).toEqual(['paragraphs', 'tables', 'links', 'images', 'notes']);
  });
});

describe('truthOf', () => {
  it('projects paragraphs, headings, labels, segments and table cells', () => {
    const doc = read(p(r('Bold ', '<w:b/>') + r('plain') + '<w:r><w:tab/></w:r>' + r('x'))
      + '<w:tbl><w:tr><w:tc>' + p(r('c1')) + p(r('c1b')) + '</w:tc><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>' + p(r('c2')) + '</w:tc></w:tr>'
      + '<w:tr><w:tc>' + p(r('d1')) + '</w:tc><w:tc><w:tcPr><w:vMerge/></w:tcPr>' + p('') + '</w:tc></w:tr></w:tbl>');
    const t = truthOf(doc);
    expect(t.paragraphs[0]).toEqual({ text: 'Bold plain\tx', heading: null, listLabel: null, inTable: false,
      segments: [{ text: 'Bold ', bold: true, italic: false, sizePt: 10, font: '' }, { text: 'plain\tx', bold: false, italic: false, sizePt: 10, font: '' }] });
    expect(t.paragraphs.map((x) => [x.text, x.inTable])).toEqual([['Bold plain\tx', false], ['c1', true], ['c1b', true], ['c2', true], ['d1', true], ['', true]]);
    expect(t.tables).toEqual([{ rows: [['c1\nc1b', 'c2'], ['d1']] }]);
  });

  it('keeps a link whole across a tab or a line break inside it, as Word does', () => {
    const doc = read(p(`<w:hyperlink w:anchor="toc1">${r('Chapter one')}<w:r><w:tab/></w:r>${r('1')}</w:hyperlink>`
      + `${r(' ')}<w:hyperlink w:anchor="toc2">${r('a')}<w:r><w:br/></w:r>${r('b')}</w:hyperlink>`));
    expect(truthOf(doc).links).toEqual([{ text: 'Chapter one\t1', anchor: 'toc1' }, { text: 'a\nb', anchor: 'toc2' }]);
  });

  it('writes a cell\'s text as its NON-EMPTY paragraphs, nested tables included', () => {
    const doc = read('<w:tbl><w:tr><w:tc><w:tbl><w:tr><w:tc>' + p(r('in1')) + '</w:tc></w:tr><w:tr><w:tc>' + p(r('in2'))
      + '</w:tc></w:tr></w:tbl>' + p('') + '</w:tc></w:tr></w:tbl>');
    expect(truthOf(doc).tables).toEqual([{ rows: [['in1\nin2']] }]);
  });

  it('merges a link\'s runs, reads anchors, counts images, and strips marker text', () => {
    const doc = read(p(`<w:hyperlink r:id="rL">${r('the ')}${r('site', '<w:b/>')}</w:hyperlink>${r(' and ')}`
      + `<w:hyperlink w:anchor="bm">${r('here')}</w:hyperlink>${r(' Boxed words')}`),
    [{ id: 'rL', type: `${REL}/hyperlink`, target: 'https://example.com', external: true }]);
    const t = truthOf(doc, ['Boxed words']);
    expect(t.links).toEqual([{ text: 'the site', url: 'https://example.com' }, { text: 'here', anchor: 'bm' }]);
    expect(t.paragraphs[0].text).toBe('the site and here ');
    expect(t.images).toBe(0);
  });
});

describe('readTruth and assertTruthShape', () => {
  it('reads a file with a BOM and CRLF line ends', () => {
    const dir = mkdtempSync(join(tmpdir(), 'truth-'));
    const f = join(dir, 'x.word.json');
    writeFileSync(f, '﻿' + JSON.stringify(truth(), null, 2).replace(/\n/g, '\r\n'));
    expect(readTruth(f).reader).toBe('R');
  });

  it('refuses a one-element array collapsed to a scalar, naming where', () => {
    const bad = { ...truth(), tables: [{ rows: ['only'] }] } as unknown;
    expect(() => assertTruthShape(bad, 'x.lo.json')).toThrow(/x\.lo\.json.*tables\[0\]\.rows\[0\]/);
    const bad2 = { ...truth(), paragraphs: { text: 'x' } } as unknown;
    expect(() => assertTruthShape(bad2, 'y')).toThrow(/y.*paragraphs/);
  });
});
