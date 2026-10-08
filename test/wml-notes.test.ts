// test/wml-notes.test.ts
import { describe, it, expect } from 'vitest';
import { readDocx } from '../src/wmlread.js';
import { buildDocx } from './helpers/build-docx.js';
import { p, r } from './helpers/wml.js';
import type { WmlParagraph } from '../src/wmlbody.js';

const fnRef = (id: string, extra = '') => `<w:r><w:rPr><w:b/></w:rPr><w:footnoteReference w:id="${id}"${extra}/></w:r>`;
const SEPARATORS = '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>'
  + '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>';
const note = (id: string, body: string) => `<w:footnote w:id="${id}">${body}</w:footnote>`;
const noteP = (text: string) => p(`<w:r><w:footnoteRef/></w:r>${r(' ' + text)}`);
const textOf = (ps: unknown[]) => (ps as WmlParagraph[]).map((x) => x.inlines.map((i) => ('text' in i ? i.text : '')).join('')).join('|');

describe('footnotes.xml', () => {
  it('reads notes by id, skips separators, drops footnoteRef', () => {
    const doc = readDocx(buildDocx(p(r('a') + fnRef('1')), { footnotes: SEPARATORS + note('1', noteP('First.') + p(r('Second.'))) }));
    expect([...doc.footnotes!.keys()]).toEqual(['1']);
    expect(textOf(doc.footnotes!.get('1')!)).toBe(' First.|Second.');
    expect(doc.unsupported).toEqual([]);
  });
  it('models a reference as a note inline carrying its run props', () => {
    const doc = readDocx(buildDocx(p(r('a') + fnRef('1')), { footnotes: note('1', noteP('N')) }));
    const inl = (doc.blocks[0] as WmlParagraph).inlines[1];
    expect(inl).toMatchObject({ kind: 'note', note: 'footnote', id: '1' });
    expect((inl as { props: { bold: boolean } }).props.bold).toBe(true);
  });
  it('customMarkFollows: the following text is the mark, not body text', () => {
    const body = p(r('a') + `<w:r><w:footnoteReference w:customMarkFollows="1" w:id="1"/><w:t>*</w:t></w:r>` + r('b'));
    const doc = readDocx(buildDocx(body, { footnotes: note('1', noteP('N')) }));
    const ps = doc.blocks[0] as WmlParagraph;
    expect(ps.inlines.find((i) => i.kind === 'note')).toMatchObject({ mark: '*' });
    expect(textOf([ps])).toBe('ab');
  });
  it('resolves a note’s hyperlink against footnotes.xml’s OWN relationships (Review Focus 1)', () => {
    const fnBody = p(`<w:hyperlink r:id="rL1">${r('site')}</w:hyperlink>`);
    const doc = readDocx(buildDocx(p(r('a') + fnRef('1')), {
      footnotes: note('1', fnBody),
      footnoteRels: [{ id: 'rL1', type: 'hyperlink', target: 'https://example.com/fn', external: true }],
    }));
    const link = (doc.footnotes!.get('1')![0] as WmlParagraph).inlines.find((i) => i.kind === 'text') as { link?: unknown };
    expect(link.link).toEqual({ url: 'https://example.com/fn' });
  });
  it('endnotes.xml likewise', () => {
    const doc = readDocx(buildDocx(p(r('a') + '<w:r><w:endnoteReference w:id="2"/></w:r>'), {
      endnotes: '<w:endnote w:id="2">' + p('<w:r><w:endnoteRef/></w:r>' + r(' E.')) + '</w:endnote>',
    }));
    expect(textOf(doc.endnotes!.get('2')!)).toBe(' E.');
  });
  it('a missing notes part leaves footnotes undefined and records it (Review Focus 5)', () => {
    const doc = readDocx(buildDocx(p(r('a') + fnRef('1')), {
      rels: [{ id: 'rX', type: 'footnotes', target: 'nowhere.xml' }],
    }));
    expect(doc.footnotes).toBeUndefined();
    expect(doc.unsupported).toContainEqual({ name: 'footnotes.xml: missing', count: 1 });
  });
  it('no notes part at all: footnotes undefined, nothing recorded by the reader', () => {
    const doc = readDocx(buildDocx(p(r('a') + fnRef('1'))));
    expect(doc.footnotes).toBeUndefined();
    expect(doc.unsupported).toEqual([]);
  });
});

describe('numbering properties', () => {
  it('reads settings.xml footnotePr / endnotePr', () => {
    const doc = readDocx(buildDocx(p(r('a')), { settings:
      '<w:footnotePr><w:numFmt w:val="lowerRoman"/><w:numStart w:val="3"/><w:numRestart w:val="eachPage"/><w:pos w:val="pageBottom"/></w:footnotePr>'
      + '<w:endnotePr><w:numFmt w:val="upperLetter"/></w:endnotePr>' }));
    expect(doc.notePr.settings).toEqual({
      footnotePr: { numFmt: 'lowerRoman', numStart: 3, numRestart: 'eachPage', pos: 'pageBottom' },
      endnotePr: { numFmt: 'upperLetter' },
    });
  });
  it('a section-ending paragraph carries its section’s properties; the body sectPr is the last', () => {
    const sect1 = '<w:sectPr><w:footnotePr><w:numRestart w:val="eachSect"/></w:footnotePr></w:sectPr>';
    const body = p(r('one'), sect1) + p(r('two'))
      + '<w:sectPr><w:footnotePr><w:numFmt w:val="chicago"/></w:footnotePr></w:sectPr>';
    const doc = readDocx(buildDocx(body));
    expect((doc.blocks[0] as WmlParagraph).sectionEnd).toEqual({ footnotePr: { numRestart: 'eachSect' } });
    expect((doc.blocks[1] as WmlParagraph).sectionEnd).toBeUndefined();
    expect(doc.notePr.last).toEqual({ footnotePr: { numFmt: 'chicago' } });
  });
  it('a junk numStart is not kept', () => {
    const doc = readDocx(buildDocx(p(r('a')), { settings: '<w:footnotePr><w:numStart w:val="x"/></w:footnotePr>' }));
    expect(doc.notePr.settings).toEqual({});
  });
});
