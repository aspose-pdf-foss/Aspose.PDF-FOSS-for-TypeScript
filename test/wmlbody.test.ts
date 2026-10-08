import { describe, it, expect } from 'vitest';
import { parseBody, type BodyResult, type BodyRel, type WmlParagraph, type WmlTable, type WmlInline } from '../src/wmlbody.js';
import { parseStyles, emptyStyles, EMPTY_THEME } from '../src/wmlstyles.js';
import { parseNumbering, EMPTY_NUMBERING } from '../src/wmlnumbering.js';
import { LoadLimits } from '../src/loadlimits.js';
import { PdfParseError, ResourceLimitError } from '../src/errors.js';
import { docXml, stylesXml, numberingXml, style, p, r, numPr, lvl, enc, W_NS } from './helpers/wml.js';

const RELS: Record<string, BodyRel> = {
  rLink: { target: 'https://example.com/a', external: true },
  rImg: { target: 'media/i.png', external: false, part: 'word/media/i.png' },
};
function body(xml: string, o: { styles?: string; numbering?: string; limits?: LoadLimits } = {}): BodyResult {
  const limits = o.limits ?? LoadLimits.defaults;
  return parseBody(docXml(xml), {
    styles: o.styles ? parseStyles(stylesXml(o.styles), EMPTY_THEME, limits) : emptyStyles(EMPTY_THEME, limits),
    numbering: o.numbering ? parseNumbering(numberingXml(o.numbering), limits) : EMPTY_NUMBERING,
    limits, rel: (id) => RELS[id],
  });
}
const paras = (res: BodyResult) => res.blocks.filter((b): b is WmlParagraph => b.kind === 'paragraph');
const textOf = (ps: { inlines: WmlInline[] }) => ps.inlines.map((i) => (i.kind === 'text' ? i.text : i.kind === 'tab' ? '\t' : i.kind === 'break' ? '\n' : '')).join('');
const unsupported = (res: BodyResult) => Object.fromEntries(res.unsupported);

describe('paragraphs and runs', () => {
  it('reads text, tabs and breaks, merging the w:t pieces of one run', () => {
    const [para] = paras(body(p('<w:r><w:t>a</w:t><w:t xml:space="preserve"> b</w:t><w:tab/><w:t>c</w:t>'
      + '<w:br/><w:br w:type="page"/><w:br w:type="column"/><w:cr/></w:r>')));
    expect(para.inlines.map((i) => i.kind)).toEqual(['text', 'tab', 'text', 'break', 'break', 'break', 'break']);
    expect(para.inlines[0]).toMatchObject({ text: 'a b' });
    expect(para.inlines.slice(3).map((i) => (i.kind === 'break' ? i.type : ''))).toEqual(['line', 'page', 'column', 'line']);
  });

  it('keeps separate runs separate, each with its own resolved props', () => {
    const [para] = paras(body(p(r('plain ') + r('bold', '<w:b/>'))));
    expect(para.inlines.map((i) => (i.kind === 'text' ? [i.text, i.props.bold] : []))).toEqual([['plain ', false], ['bold', true]]);
  });

  it('turns a non-breaking hyphen into U+2011', () => {
    expect(textOf(paras(body(p('<w:r><w:t>a</w:t><w:noBreakHyphen/><w:t>b</w:t></w:r>')))[0])).toBe('a‑b');
  });

  it('carries the heading level and style name', () => {
    const res = body(p(r('Title'), '<w:pStyle w:val="1"/>'),
      { styles: style('paragraph', '1', '<w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr>') });
    expect(paras(res)[0]).toMatchObject({ heading: 1, styleName: 'heading 1' });
  });
});

describe('lists', () => {
  const numbering = `<w:abstractNum w:abstractNumId="0">${lvl(0, 'decimal', '%1.')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`;

  it('labels list paragraphs and counts across an interrupting paragraph', () => {
    const res = body(p(r('a'), numPr(1)) + p(r('between')) + p(r('b'), numPr(1)), { numbering });
    expect(paras(res).map((x) => x.list?.label)).toEqual(['1.', undefined, '2.']);
    expect(paras(res)[0].list).toEqual({ numId: 1, ilvl: 0, ordinal: 1, label: '1.', bullet: false });
  });

  it('takes list membership from the paragraph style, and numId 0 opts out', () => {
    const styles = style('paragraph', 'L', '<w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr>');
    const res = body(p(r('in'), '<w:pStyle w:val="L"/>') + p(r('out'), '<w:pStyle w:val="L"/><w:numPr><w:numId w:val="0"/></w:numPr>'), { styles, numbering });
    expect(paras(res).map((x) => x.list?.label)).toEqual(['1.', undefined]);
  });

  it('records a list paragraph whose numId names no definition', () => {
    const res = body(p(r('x'), numPr(42)), { numbering });
    expect(paras(res)[0].list).toBeUndefined();
    expect(unsupported(res)).toEqual({ 'w:numPr (undefined list)': 1 });
  });
});

describe('hyperlinks', () => {
  it('links runs to an external URL or an anchor', () => {
    const [para] = paras(body(p(`<w:hyperlink r:id="rLink">${r('ext')}</w:hyperlink><w:hyperlink w:anchor="sec">${r('int')}</w:hyperlink>`)));
    expect(para.inlines.map((i) => (i.kind === 'text' ? i.link : null))).toEqual([{ url: 'https://example.com/a' }, { anchor: 'sec' }]);
  });

  it('keeps the text of a link whose r:id names nothing, and records it', () => {
    const res = body(p(`<w:hyperlink r:id="rNope">${r('orphan')}</w:hyperlink>`));
    expect(paras(res)[0].inlines[0]).toMatchObject({ text: 'orphan' });
    expect((paras(res)[0].inlines[0] as { link?: unknown }).link).toBeUndefined();
    expect(unsupported(res)).toEqual({ 'w:hyperlink (unresolved r:id)': 1 });
  });
});

describe('images', () => {
  const inline = (rid: string, holder = 'inline') => `<w:r><w:drawing><wp:${holder}><wp:extent cx="1270000" cy="635000"/>`
    + '<wp:docPr id="1" name="p" descr="A cat"/><a:graphic><a:graphicData uri="x"><pic:pic><pic:blipFill>'
    + `<a:blip r:embed="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:${holder}></w:drawing></w:r>`;

  it('reads an inline picture: part, size in points, alt text', () => {
    expect(paras(body(p(inline('rImg'))))[0].inlines).toEqual([
      { kind: 'image', part: 'word/media/i.png', widthPt: 100, heightPt: 50, alt: 'A cat' }]);
  });

  it('places a floating picture inline and records that', () => {
    const res = body(p(inline('rImg', 'anchor')));
    expect(paras(res)[0].inlines[0]).toMatchObject({ kind: 'image', part: 'word/media/i.png' });
    expect(unsupported(res)).toEqual({ 'w:drawing (anchor)': 1 });
  });

  it('keeps an image whose r:embed names nothing, without a part, and records it', () => {
    const res = body(p(inline('rNope')));
    expect(paras(res)[0].inlines[0]).toEqual({ kind: 'image', widthPt: 100, heightPt: 50, alt: 'A cat' });
    expect(unsupported(res)).toEqual({ 'a:blip (unresolved image)': 1 });
  });

  it('records a drawing that is not a picture', () => {
    const res = body(p('<w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><a:graphic/></wp:inline></w:drawing></w:r>'));
    expect(paras(res)[0].inlines).toEqual([]);
    expect(unsupported(res)).toEqual({ 'w:drawing (not a picture)': 1 });
  });
});

describe('containers and fields', () => {
  it('descends content controls, smart tags, custom XML, insertions and simple fields', () => {
    const res = body(`<w:sdt><w:sdtPr/><w:sdtContent>${p(r('blk'))}</w:sdtContent></w:sdt>`
      + p(`<w:sdt><w:sdtContent>${r('a')}</w:sdtContent></w:sdt><w:smartTag>${r('b')}</w:smartTag>`
        + `<w:customXml>${r('c')}</w:customXml><w:ins>${r('d')}</w:ins><w:fldSimple w:instr="PAGE">${r('e')}</w:fldSimple>`));
    expect(paras(res).map(textOf)).toEqual(['blk', 'abcde']);
    expect(unsupported(res)).toEqual({ 'w:ins': 1, 'w:fldSimple': 1 });
  });

  it('drops deletions (recorded), bookmarks and proofing marks', () => {
    const res = body(p(`<w:bookmarkStart w:id="0" w:name="x"/><w:proofErr/>${r('kept')}<w:del>`
      + '<w:r><w:tab/><w:delText>gone</w:delText></w:r></w:del><w:bookmarkEnd w:id="0"/>'));
    // The tab matters: w:delText is dropped on its own, so deleted TEXT stays out
    // even if w:del were descended — a deleted tab or drawing would not.
    expect(paras(res)[0].inlines.map((i) => i.kind)).toEqual(['text']);
    expect(textOf(paras(res)[0])).toBe('kept');
    expect(unsupported(res)).toEqual({ 'w:del': 1 });
  });

  it('keeps a complex field\'s result, skips its instruction, and records the field once', () => {
    const res = body(p('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r>'
      + `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${r('7')}<w:r><w:fldChar w:fldCharType="end"/></w:r>`));
    expect(textOf(paras(res)[0])).toBe('7');
    expect(unsupported(res)).toEqual({ 'w:fldChar': 1 });
  });

  it('skips a field instruction that spans paragraphs, as a TOC field does', () => {
    const res = body(p('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>TOC</w:instrText></w:r>')
      + p(r('still instruction')) + p(`<w:r><w:fldChar w:fldCharType="separate"/></w:r>${r('entry')}`)
      + p(`${r('more')}<w:r><w:fldChar w:fldCharType="end"/></w:r>`) + p(r('after')));
    expect(paras(res).map(textOf)).toEqual(['', '', 'entry', 'more', 'after']);
  });

  it('records an unknown construct and keeps its text', () => {
    const res = body(`<w:altChunkish>${r('blocktext')}</w:altChunkish>` + p(`<w:r><w:commentReference w:id="1"/></w:r><w:dir w:val="rtl">${r('x')}</w:dir>`));
    expect(paras(res).map(textOf)).toEqual(['blocktext', 'x']);
    expect(unsupported(res)).toEqual({ 'w:altChunkish': 1, 'w:commentReference': 1, 'w:dir': 1 });
  });

  it('takes a markup-compatibility Fallback for a Choice it does not understand', () => {
    const res = body(p(`<mc:AlternateContent><mc:Choice Requires="w14">${r('new')}</mc:Choice><mc:Fallback>${r('old')}</mc:Fallback></mc:AlternateContent>`));
    expect(textOf(paras(res)[0])).toBe('old');
  });
});

describe('tables', () => {
  const tbl = '<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>'
    + '<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="4000"/></w:tblGrid>'
    + `<w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:shd w:fill="FF0000"/></w:tcPr>${p(r('head'))}</w:tc></w:tr>`
    + `<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${p(r('a'))}</w:tc><w:tc>${p(r('b'))}</w:tc></w:tr>`
    + `<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr>${p('')}</w:tc><w:tc><w:tbl><w:tblGrid><w:gridCol w:w="100"/></w:tblGrid>`
    + `<w:tr><w:tc>${p(r('nested'))}</w:tc></w:tr></w:tbl>${p('')}</w:tc></w:tr></w:tbl>`;

  it('reads the grid, header rows, spans, vertical merges, shading and nested tables', () => {
    const [t] = body(tbl).blocks as WmlTable[];
    expect(t.gridPt).toEqual([100, 200]);
    expect(t.rows.map((row) => row.header)).toEqual([true, false, false]);
    expect(t.rows[0].cells[0]).toMatchObject({ span: 2, shading: [1, 0, 0] });
    expect(t.rows[1].cells[0].vMerge).toBe('restart');
    expect(t.rows[2].cells[0].vMerge).toBe('continue');
    const nested = t.rows[2].cells[1].blocks[0] as WmlTable;
    expect(nested.kind).toBe('table');
    expect(textOf(nested.rows[0].cells[0].blocks[0] as WmlParagraph)).toBe('nested');
  });

  it('records a table style it does not apply, and stays quiet about widths', () => {
    expect((body(tbl).blocks[0] as WmlTable).unmodelled).toEqual(['w:tblStyle']);
  });

  it('clamps a junk gridSpan to 1', () => {
    const [t] = body(`<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="x"/></w:tcPr>${p('')}</w:tc>`
      + `<w:tc><w:tcPr><w:gridSpan w:val="0"/></w:tcPr>${p('')}</w:tc></w:tr></w:tbl>`).blocks as WmlTable[];
    expect(t.rows[0].cells.map((c) => c.span)).toEqual([1, 1]);
  });

  it('models a row\'s gridBefore and gridAfter, which shift its cells', () => {
    const [t] = body(`<w:tbl><w:tr><w:trPr><w:gridBefore w:val="1"/><w:wBefore w:w="500" w:type="dxa"/></w:trPr><w:tc>${p('')}</w:tc></w:tr>`
      + `<w:tr><w:trPr><w:gridAfter w:val="2"/><w:wAfter w:w="500" w:type="dxa"/></w:trPr><w:tc>${p('')}</w:tc></w:tr>`
      + `<w:tr><w:trPr><w:gridBefore w:val="x"/><w:gridAfter w:val="0"/></w:trPr><w:tc>${p('')}</w:tc></w:tr></w:tbl>`).blocks as WmlTable[];
    expect(t.rows.map((row) => [row.gridBefore, row.gridAfter])).toEqual([[1, undefined], [undefined, 2], [undefined, undefined]]);
    expect(t.unmodelled).toEqual([]);
  });

  it('records the row and cell properties it does not model, once each, quiet about widths and cnfStyle', () => {
    const [t] = body('<w:tbl><w:tr><w:trPr><w:trHeight w:val="400"/><w:cnfStyle w:val="100000000000"/></w:trPr>'
      + `<w:tc><w:tcPr><w:tcW w:w="100" w:type="dxa"/><w:vAlign w:val="center"/><w:tcBorders/><w:cnfStyle w:val="1"/></w:tcPr>${p('')}</w:tc>`
      + `<w:tc><w:tcPr><w:vAlign w:val="bottom"/><w:noWrap/></w:tcPr>${p('')}</w:tc></w:tr></w:tbl>`).blocks as WmlTable[];
    expect(t.unmodelled).toEqual(['w:trHeight', 'w:vAlign', 'w:tcBorders', 'w:noWrap']);
  });
});

describe('symbols, ruby and fields around unknown blocks', () => {
  it('keeps a w:sym as the character Word stores, in the symbol\'s own font, and records it', () => {
    const res = body(p('<w:r><w:t>a</w:t><w:sym w:font="Symbol" w:char="F0B7"/><w:t>b</w:t></w:r>'));
    const [para] = paras(res);
    expect(para.inlines.map((i) => (i.kind === 'text' ? [i.text, i.props.font] : []))).toEqual([['a', undefined], ['', 'Symbol'], ['b', undefined]]);
    expect(unsupported(res)).toEqual({ 'w:sym': 1 });
  });

  it('records a w:sym with no usable character and draws nothing for it', () => {
    const res = body(p('<w:r><w:sym w:font="Symbol" w:char="zz"/><w:sym w:font="Symbol"/>'
      + '<w:sym w:font="Symbol" w:char="0000"/><w:sym w:font="Symbol" w:char="110000"/></w:r>'));
    expect(textOf(paras(res)[0])).toBe('');
    expect(unsupported(res)).toEqual({ 'w:sym': 4 });
  });

  it('links a w:sym inside a hyperlink like any other text', () => {
    const [para] = paras(body(p('<w:hyperlink w:anchor="s"><w:r><w:sym w:font="Wingdings" w:char="F04A"/></w:r></w:hyperlink>')));
    expect(para.inlines).toMatchObject([{ kind: 'text', text: '', link: { anchor: 's' } }]);
  });

  it('keeps a ruby\'s base text, never its annotation, and records it', () => {
    const res = body(p('<w:r><w:ruby><w:rubyPr/><w:rt><w:r><w:t>kan</w:t></w:r></w:rt>'
      + '<w:rubyBase><w:r><w:t>漢</w:t></w:r></w:rubyBase></w:ruby></w:r>'));
    expect(textOf(paras(res)[0])).toBe('漢');
    expect(unsupported(res)).toEqual({ 'w:ruby': 1 });
  });

  it('keeps an unknown block\'s text out of an open field instruction', () => {
    const res = body(p('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>TOC</w:instrText></w:r>')
      + `<w:altChunkish>${r('instruction')}</w:altChunkish>`
      + p(`<w:r><w:fldChar w:fldCharType="separate"/></w:r>${r('entry')}<w:r><w:fldChar w:fldCharType="end"/></w:r>`));
    expect(paras(res).map(textOf)).toEqual(['', 'entry']);
  });
});

describe('document', () => {
  it('records a complex field that never ends, which hides the rest of the document', () => {
    const res = body(p('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>TOC</w:instrText></w:r>') + p(r('lost')));
    expect(paras(res).map(textOf)).toEqual(['', '']);
    expect(unsupported(res)).toEqual({ 'w:fldChar': 1, 'w:fldChar (unterminated)': 1 });
  });

  it('reads the page from the final sectPr', () => {
    const res = body(p(r('x')) + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701"/></w:sectPr>');
    expect(res.page).toEqual({ widthPt: 595.3, heightPt: 841.9, margins: { top: 56.7, right: 42.5, bottom: 56.7, left: 85.05 } });
  });

  it('refuses a part whose root is not w:document', () => {
    expect(() => parseBody(enc(`<w:styles xmlns:w="${W_NS}"/>`), {
      styles: emptyStyles(EMPTY_THEME), numbering: EMPTY_NUMBERING, limits: LoadLimits.defaults, rel: () => undefined,
    })).toThrow(PdfParseError);
  });

  it('counts blocks, nested ones included, against maxContainerItems', () => {
    const xml = p(r('1')) + p(r('2')) + p(r('3'));
    expect(() => body(xml, { limits: LoadLimits.defaults.with({ maxContainerItems: 2 }) })).toThrow(ResourceLimitError);
    expect(body(xml, { limits: LoadLimits.defaults.with({ maxContainerItems: 3 }) }).blocks).toHaveLength(3);
  });
});
describe('sections, revisions and simple fields', () => {
  it('records the header and footer references of the final section', () => {
    const res = body(p(r('x')) + '<w:sectPr><w:headerReference w:type="default" r:id="rH"/>'
      + '<w:footerReference w:type="default" r:id="rF"/><w:footerReference w:type="first" r:id="rF2"/>'
      + '<w:pgSz w:w="11906" w:h="16838"/></w:sectPr>');
    expect(unsupported(res)).toEqual({ 'w:headerReference': 1, 'w:footerReference': 2 });
    expect(res.page?.widthPt).toBe(595.3);
  });

  it('records a section break inside a paragraph, and keeps it out of the paragraph\'s unmodelled list', () => {
    const res = body(p(r('one'), '<w:sectPr><w:headerReference w:type="default" r:id="rH"/><w:pgSz w:w="16838" w:h="11906"/></w:sectPr>')
      + p(r('two')));
    expect(unsupported(res)).toEqual({ 'w:sectPr': 1, 'w:headerReference': 1 });
    expect(paras(res)[0].unmodelled).toEqual([]);
    expect(paras(res).map(textOf)).toEqual(['one', 'two']);
  });

  it('records tracked insertions and deletions while showing the final text', () => {
    const res = body(p(`${r('a')}<w:ins w:id="1" w:author="x">${r('b')}</w:ins>`
      + '<w:del w:id="2" w:author="x"><w:r><w:delText>c</w:delText></w:r></w:del>'));
    expect(textOf(paras(res)[0])).toBe('ab');
    expect(unsupported(res)).toEqual({ 'w:ins': 1, 'w:del': 1 });
  });

  it('records moves like insertions and deletions', () => {
    const res = body(p(`<w:moveFrom w:id="1" w:author="x"><w:r><w:t>old</w:t></w:r></w:moveFrom><w:moveTo w:id="2" w:author="x">${r('new')}</w:moveTo>`));
    expect(textOf(paras(res)[0])).toBe('new');
    expect(unsupported(res)).toEqual({ 'w:moveFrom': 1, 'w:moveTo': 1 });
  });

  it('records a simple field while keeping its result', () => {
    const res = body(p(`<w:fldSimple w:instr=" PAGE ">${r('7')}</w:fldSimple>`));
    expect(textOf(paras(res)[0])).toBe('7');
    expect(unsupported(res)).toEqual({ 'w:fldSimple': 1 });
  });

  it('records a block-level insertion and keeps its paragraphs', () => {
    const res = body(`<w:ins w:id="1" w:author="x">${p(r('inserted'))}</w:ins>`);
    expect(paras(res).map(textOf)).toEqual(['inserted']);
    expect(unsupported(res)).toEqual({ 'w:ins': 1 });
  });
});

describe('HYPERLINK fields', () => {
  const fc = (t: string) => `<w:r><w:fldChar w:fldCharType="${t}"/></w:r>`;
  const ins = (s: string) => `<w:r><w:instrText xml:space="preserve">${s}</w:instrText></w:r>`;
  const field = (instr: string, result: string) => fc('begin') + ins(instr) + fc('separate') + result + fc('end');
  const links = (res: BodyResult) => paras(res).flatMap((q) => q.inlines.map((i) => (i.kind === 'text' ? [i.text, i.link] : [i.kind])));

  it('links a complex field\'s result to its URL and does not record it', () => {
    const res = body(p(r('see ') + field(' HYPERLINK "https://x.test/a" ', r('here')) + r('.')));
    expect(links(res)).toEqual([['see ', undefined], ['here', { url: 'https://x.test/a' }], ['.', undefined]]);
    expect(unsupported(res)).toEqual({});
  });

  it('reads \\l as an anchor, and a URL with \\l as the URL with a fragment', () => {
    const res = body(p(field('HYPERLINK \\l "_Toc1"', r('a')) + field('HYPERLINK "https://x.test/" \\l "sec"', r('b'))));
    expect(links(res)).toEqual([['a', { anchor: '_Toc1' }], ['b', { url: 'https://x.test/#sec' }]]);
  });

  it('joins an instruction split across runs, as Word writes it', () => {
    const res = body(p(fc('begin') + ins(' HYPER') + ins('LINK "https://x.') + ins('test/b" ') + fc('separate') + r('b') + fc('end')));
    expect(links(res)).toEqual([['b', { url: 'https://x.test/b' }]]);
  });

  it('takes an unquoted target and a lower-case name, and skips the arguments of \\o, \\t and \\*', () => {
    const res = body(p(field('hyperlink https://x.test/c \\o "tip" \\t "_blank"', r('c'))
      + field('HYPERLINK \\o "only a tip" "https://x.test/d"', r('d'))
      + field('HYPERLINK \\* MERGEFORMAT https://x.test/e', r('e'))));
    expect(links(res)).toEqual([['c', { url: 'https://x.test/c' }], ['d', { url: 'https://x.test/d' }], ['e', { url: 'https://x.test/e' }]]);
  });

  it('keeps the first target, and reads \\n as a switch taking no argument', () => {
    const res = body(p(field('HYPERLINK "https://x.test/h" "stray"', r('h')) + field('HYPERLINK \\n "https://x.test/i"', r('i'))));
    expect(links(res)).toEqual([['h', { url: 'https://x.test/h' }], ['i', { url: 'https://x.test/i' }]]);
  });

  it('unescapes \\" and \\\\ inside a quoted argument', () => {
    const res = body(p(field('HYPERLINK "C:\\\\dir\\\\a \\"b\\".pdf"', r('e'))));
    expect(links(res)).toEqual([['e', { url: 'C:\\dir\\a "b".pdf' }]]);
  });

  it('links every result run across paragraphs, tabs and a nested field', () => {
    const res = body(p(fc('begin') + ins('HYPERLINK \\l "x"') + fc('separate') + r('one') + '<w:r><w:tab/></w:r>'
      + field('PAGEREF x \\h', r('3'))) + p(r('two') + fc('end') + r('after')));
    expect(links(res)).toEqual([['one', { anchor: 'x' }], ['tab'], ['3', { anchor: 'x' }], ['two', { anchor: 'x' }], ['after', undefined]]);
    expect(unsupported(res)).toEqual({ 'w:fldChar': 1 });
  });

  it('lets a w:hyperlink inside the result win over the field', () => {
    const res = body(p(field('HYPERLINK "https://x.test/outer"', `<w:hyperlink r:id="rLink">${r('in')}</w:hyperlink>${r('out')}`)));
    expect(links(res)).toEqual([['in', { url: 'https://example.com/a' }], ['out', { url: 'https://x.test/outer' }]]);
  });

  it('lets a HYPERLINK field inside a w:hyperlink win over the element', () => {
    const res = body(p(`<w:hyperlink r:id="rLink">${r('el ')}${field('HYPERLINK "https://x.test/in"', r('fld'))}</w:hyperlink>`));
    expect(links(res)).toEqual([['el ', { url: 'https://example.com/a' }], ['fld', { url: 'https://x.test/in' }]]);
  });

  it('records a HYPERLINK field that names no target, and keeps its text', () => {
    const res = body(p(field('HYPERLINK \\o "tip"', r('f'))));
    expect(links(res)).toEqual([['f', undefined]]);
    expect(unsupported(res)).toEqual({ 'w:fldChar': 1 });
  });

  it('links a simple HYPERLINK field and does not record it', () => {
    const res = body(p(`<w:fldSimple w:instr=" HYPERLINK &quot;https://x.test/g&quot; ">${r('g')}</w:fldSimple>`));
    expect(links(res)).toEqual([['g', { url: 'https://x.test/g' }]]);
    expect(unsupported(res)).toEqual({});
  });
});
