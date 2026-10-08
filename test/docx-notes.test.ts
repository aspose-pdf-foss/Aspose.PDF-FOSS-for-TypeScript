// test/docx-notes.test.ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { buildDocx } from './helpers/build-docx.js';
import { p, r } from './helpers/wml.js';
import { docxNoteOptions } from '../src/wmlflow.js';
import { readDocx } from '../src/wmlread.js';
import type { StructElement } from '../src/struct.js';

const fnRef = (id: string) => `<w:r><w:footnoteReference w:id="${id}"/></w:r>`;
const enRef = (id: string) => `<w:r><w:endnoteReference w:id="${id}"/></w:r>`;
const fn = (id: string, body: string) => `<w:footnote w:id="${id}">${body}</w:footnote>`;
const en = (id: string, body: string) => `<w:endnote w:id="${id}">${body}</w:endnote>`;
const noteP = (t: string) => p(`<w:r><w:footnoteRef/></w:r>${r(' ' + t)}`);
const count = (t: string, s: string) => t.split(s).length - 1;

describe('doc.AddDocx footnotes and endnotes', () => {
  it('draws the mark and the note at the page foot; nothing reported', () => {
    const bytes = buildDocx(p(r('A claim.') + fnRef('1')), { footnotes: fn('1', noteP('The SOURCE.')) });
    const { pages, skipped } = Document.New().AddDocx(bytes);
    const f = pages[0].GetTextFragments();
    const note = f.find((x) => x.text.includes('SOURCE'))!;
    expect(note.quad[1]).toBeLessThan(f.find((x) => x.text.includes('claim'))!.quad[1]);
    expect(note.quad[1]).toBeLessThan(200);
    expect(skipped.filter((s) => s.name.includes('Reference'))).toEqual([]);
  });
  it('a note’s list and table render inside it', () => {
    const body = noteP('intro') + p(r('item one'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')
      + '<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>' + p(r('CELLINNOTE')) + '</w:tc></w:tr></w:tbl>';
    const numbering = '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
    const { pages } = Document.New().AddDocx(buildDocx(p(r('t') + fnRef('1')), { footnotes: fn('1', body), numbering }));
    const t = pages[0].GetText();
    for (const s of ['intro', 'item one', 'CELLINNOTE']) expect(t).toContain(s);
  });
  it('a note’s external hyperlink is clickable (Review Focus 1)', () => {
    const bytes = buildDocx(p(r('t') + fnRef('1')), {
      footnotes: fn('1', p(`<w:hyperlink r:id="rL1">${r('LINKED')}</w:hyperlink>`)),
      footnoteRels: [{ id: 'rL1', type: 'hyperlink', target: 'https://example.com/n', external: true }],
    });
    const { pages } = Document.New().AddDocx(bytes);
    const uris = pages[0].Annotations.map((a) => (a as { Action?: { type: string; uri?: string } }).Action)
      .filter((x) => x?.type === 'uri').map((x) => x!.uri);
    expect(uris).toContain('https://example.com/n');
  });
  it('endnotes go after the content', () => {
    const bytes = buildDocx(p(r('A.') + enRef('2')) + p(r('closing')), { endnotes: en('2', p(r('ENDTEXT'))) });
    const f = Document.New().AddDocx(bytes).pages[0].GetTextFragments();
    expect(f.find((x) => x.text.includes('ENDTEXT'))!.quad[1]).toBeLessThan(f.find((x) => x.text.includes('closing'))!.quad[1]);
  });
  it('a custom mark is drawn as the mark', () => {
    const body = p(r('star') + '<w:r><w:footnoteReference w:customMarkFollows="1" w:id="1"/><w:t>*</w:t></w:r>');
    const f = Document.New().AddDocx(buildDocx(body, { footnotes: fn('1', p(r('STARRED'))) })).pages[0].GetTextFragments();
    expect(f.filter((x) => x.text.trim() === '*').length).toBe(2);   // citation + gutter
  });
  it('a custom mark Word also wrote into the note body is drawn once there (corpus finding)', () => {
    const body = p(r('star') + '<w:r><w:footnoteReference w:customMarkFollows="1" w:id="1"/><w:t>*</w:t></w:r>');
    const note = p('<w:r><w:t>*</w:t></w:r>' + r(' STARRED'));
    const f = Document.New().AddDocx(buildDocx(body, { footnotes: fn('1', note) })).pages[0].GetTextFragments();
    expect(f.filter((x) => x.text.includes('*')).length).toBe(2);   // citation + gutter, not a third in the body
  });
  it('a tab after Word’s own number (LibreOffice writes one) is not drawn or reported', () => {
    const note = p('<w:r><w:footnoteRef/></w:r><w:r><w:tab/><w:t>TABBED</w:t></w:r>');
    const { skipped } = Document.New().AddDocx(buildDocx(p(r('t') + fnRef('1')), { footnotes: fn('1', note) }));
    expect(skipped.filter((s) => s.name === 'w:tab')).toEqual([]);
  });
  it('lowerRoman from settings.xml, starting at 3', () => {
    const bytes = buildDocx(p(r('t') + fnRef('1')), { footnotes: fn('1', p(r('N'))),
      settings: '<w:footnotePr><w:numFmt w:val="lowerRoman"/><w:numStart w:val="3"/></w:footnotePr>' });
    const f = Document.New().AddDocx(bytes).pages[0].GetTextFragments();
    expect(f.filter((x) => x.text.trim() === 'iii').length).toBe(2);
  });
  it('eachSect restarts at each section boundary', () => {
    const sect = '<w:sectPr><w:footnotePr><w:numRestart w:val="eachSect"/></w:footnotePr></w:sectPr>';
    const body = p(r('a') + fnRef('1')) + p(r('b') + fnRef('2'), sect) + p(r('c') + fnRef('3'))
      + '<w:sectPr><w:footnotePr><w:numRestart w:val="eachSect"/></w:footnotePr></w:sectPr>';
    const bytes = buildDocx(body, { footnotes: fn('1', p(r('N1'))) + fn('2', p(r('N2'))) + fn('3', p(r('N3'))) });
    const f = Document.New().AddDocx(bytes).pages[0].GetTextFragments();
    expect(f.filter((x) => x.text.trim() === '3')).toHaveLength(0);
    expect(f.filter((x) => x.text.trim() === '1')).toHaveLength(4);
  });
  it('a reference in a table cell renders (v9j3.3.3 lifted the refusal)', () => {
    const tbl = '<w:tbl><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc>'
      + p(r('cell') + fnRef('1') + fnRef('2')) + '</w:tc></w:tr></w:tbl>';
    const { pages, skipped } = Document.New().AddDocx(buildDocx(tbl + p(r('after')),
      { footnotes: fn('1', p(r('CELLNOTE'))) + fn('2', p(r('CELLNOTE2'))) }));
    const t = pages[0].GetText();
    for (const s of ['cell', 'after', 'CELLNOTE', 'CELLNOTE2']) expect(t).toContain(s);
    expect(skipped.filter((s) => s.name.includes('table cell'))).toEqual([]);
  });
  it('a note citing another note is reported, not nested (hand-built: Word never writes one)', () => {
    const { pages, skipped } = Document.New().AddDocx(buildDocx(p(r('t') + fnRef('1')),
      { footnotes: fn('1', p(r('OUTER') + fnRef('2'))) + fn('2', p(r('INNERNOTE'))) }));
    const text = pages.map((pg) => pg.GetText()).join('\n');
    expect(text).toContain('OUTER');
    expect(text).not.toContain('INNERNOTE');
    expect(skipped).toContainEqual({ name: 'w:footnoteReference (in a note)', count: 1, kind: 'dropped' });
  });
  it('an unknown id is reported; a missing part reports every reference (Review Focus 5)', () => {
    const a = Document.New().AddDocx(buildDocx(p(r('t') + fnRef('9')), { footnotes: fn('1', p(r('N'))) }));
    expect(a.skipped).toContainEqual({ name: 'w:footnoteReference (unknown id)', count: 1, kind: 'dropped' });
    const b = Document.New().AddDocx(buildDocx(p(r('t') + fnRef('1') + fnRef('2')),
      { rels: [{ id: 'rX', type: 'footnotes', target: 'gone.xml' }] }));
    expect(b.skipped).toContainEqual({ name: 'w:footnoteReference', count: 2, kind: 'dropped' });
    expect(b.pages[0].GetText()).toContain('t');
  });
  it('reports unmappable format, endnote eachPage and non-default positions', () => {
    const o = docxNoteOptions(readDocx(buildDocx(p(r('x')), { settings:
      '<w:footnotePr><w:numFmt w:val="hebrew1"/><w:pos w:val="beneathText"/></w:footnotePr>'
      + '<w:endnotePr><w:numRestart w:val="eachPage"/><w:pos w:val="sectEnd"/></w:endnotePr>' })));
    expect(o.skipped.sort()).toEqual(['w:numFmt (footnote)', 'w:numRestart (endnote)', 'w:pos (endnote)', 'w:pos (footnote)']);
    expect(o.footnotes.format).toBe('arabic');
  });
  it('a section whose format differs from the last is reported', () => {
    const body = p(r('a'), '<w:sectPr><w:footnotePr><w:numFmt w:val="upperRoman"/></w:footnotePr></w:sectPr>') + p(r('b'));
    expect(docxNoteOptions(readDocx(buildDocx(body))).skipped).toContain('w:footnotePr (section)');
  });
  it('eachPage maps to restart: page', () => {
    const o = docxNoteOptions(readDocx(buildDocx(p(r('x')), { settings: '<w:footnotePr><w:numRestart w:val="eachPage"/></w:footnotePr>' })));
    expect(o.footnotes.restart).toBe('page');
  });
  it('the gutter mark is sized from the first note’s own text', () => {
    const big = p(`<w:r><w:rPr><w:sz w:val="28"/></w:rPr><w:t>BIGNOTE</w:t></w:r>`);   // 14pt
    expect(docxNoteOptions(readDocx(buildDocx(p(r('x') + fnRef('1')), { footnotes: fn('1', big) }))).footnotes.fontSize).toBe(14);
  });
  it('tagged: one /Note per note', () => {
    const doc = Document.New();
    doc.AddDocx(buildDocx(p(r('a') + fnRef('1')), { footnotes: fn('1', p(r('N'))) }), { tagged: true });
    const all = (el: { Children: StructElement[] }): StructElement[] => el.Children.flatMap((c) => [c, ...all(c)]);
    expect(all(doc.GetStructTree()!).filter((e) => e.Type === 'Note')).toHaveLength(1);
  });
  it('a note-free DOCX is byte-identical to the same body without a notes part (Review Focus 3)', () => {
    const sha = (b: Uint8Array) => createHash('sha256')
      .update(Buffer.concat(Document.New().AddDocx(b).pages.map((pg) => Buffer.from(pg.Contents)))).digest('hex');
    const body = p(r('plain words')) + p(r('second'));
    expect(sha(buildDocx(body, { footnotes: fn('1', p(r('unused'))) }))).toBe(sha(buildDocx(body)));
  });
});

describe('page.AddDocx and flow.AddDocx', () => {
  it('page.AddDocx places notes after the content inside the rect', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const r0 = page.AddDocx(buildDocx(p(r('A claim.') + fnRef('1'))), [72, 72, 400, 700]);
    expect(r0.skipped).toContainEqual({ name: 'w:footnoteReference', count: 1, kind: 'dropped' });
    const page2 = doc.AddPage().page;
    const r1 = page2.AddDocx(buildDocx(p(r('A claim.') + fnRef('1')), { footnotes: fn('1', p(r('RECTNOTE'))) }), [72, 72, 400, 700]);
    const f = page2.GetTextFragments();
    expect(f.find((x) => x.text.includes('RECTNOTE'))!.quad[1]).toBeLessThan(f.find((x) => x.text.includes('claim'))!.quad[1]);
    expect(r1.remainder).toEqual([]);
  });
  it('flow.AddDocx reports Word numbering the flow does not follow', () => {
    const flow = Document.New().NewFlow();
    const { skipped } = flow.AddDocx(buildDocx(p(r('t') + fnRef('1')), { footnotes: fn('1', p(r('N'))),
      settings: '<w:footnotePr><w:numFmt w:val="lowerRoman"/></w:footnotePr>' }));
    expect(skipped).toContainEqual({ name: 'w:footnotePr', count: 1, kind: 'degraded' });
  });
});
