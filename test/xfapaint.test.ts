// test/xfapaint.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { chromeContent, ChromeFonts, paintChrome } from '../src/xfapaint.js';
import { facePicker } from '../src/xfafont.js';
import type { ChromeOp } from '../src/xfachrome.js';

const doc0 = () => { const d = Document.New(); d.AddPage(PageFormat.custom(200, 100)); return d; };
const ascii = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

describe('chromeContent: XFA frame to PDF operators (164g.4)', () => {
  it('flips y and fills', () => {
    const d = doc0();
    const s = ascii(chromeContent(d, new Map(), [{ kind: 'fill', color: [1, 0, 0], path: [['M', 10, 20], ['L', 30, 20], ['L', 30, 40], ['Z']] }],
      100, new ChromeFonts(d, facePicker(d)), () => {}));
    expect(s).toBe('q 1 0 0 rg 10 80 m 30 80 l 30 60 l h f Q\n');
  });

  it('strokes with width, caps, joins and dashes', () => {
    const d = doc0();
    const op: ChromeOp = { kind: 'stroke', color: [0, 0, 0], width: 2, cap: 'round', join: 'miter', dash: [0, 4], path: [['M', 0, 0], ['L', 10, 0]] };
    expect(ascii(chromeContent(d, new Map(), [op], 100, new ChromeFonts(d, facePicker(d)), () => {})))
      .toBe('q 0 0 0 RG 2 w 1 J 0 j [0 4] 0 d 0 100 m 10 100 l S Q\n');
  });

  it('writes text in the Standard-14 face that stands for Arial', () => {
    const d = doc0();
    const fonts = new Map();
    const s = ascii(chromeContent(d, fonts, [{ kind: 'text', x: 5, y: 30, text: 'Hi', color: [0, 0, 0], underline: false, lineThrough: false,
      style: { family: ['Arial'], size: 9, bold: false, italic: false } }], 100, new ChromeFonts(d, facePicker(d)), () => {}));
    expect(s).toMatch(/^BT \/F\d+ 9 Tf 0 0 0 rg 5 70 Td <4869> Tj ET\n$/);
    const key = s.match(/\/(F\d+)/)![1];
    expect((d.resolve((fonts as Map<string, never>).get(key)) as Map<string, { name: string }>).get('BaseFont')).toEqual({ kind: 'name', name: 'Helvetica' });
  });

  it('skips text whose face cannot be resolved, saying why', () => {
    const d = doc0();
    const why: string[] = [];
    const s = chromeContent(d, new Map(), [{ kind: 'text', x: 0, y: 0, text: 'x', color: [0, 0, 0], underline: false, lineThrough: false,
      style: { family: ['NoSuchFace'], size: 9, bold: false, italic: false } }], 100, new ChromeFonts(d, facePicker(d)), (r) => why.push(r));
    expect(s.length).toBe(0);
    expect(why[0]).toMatch(/NoSuchFace/);
  });

  it('draws an underline under underlined text', () => {
    const d = doc0();
    const s = ascii(chromeContent(d, new Map(), [{ kind: 'text', x: 5, y: 30, text: 'Hi', color: [0, 0, 0], underline: true, lineThrough: false,
      style: { family: ['Arial'], size: 9, bold: false, italic: false } }], 100, new ChromeFonts(d, facePicker(d)), () => {}));
    expect(s).toMatch(/ re f/);
  });
});

describe('paintChrome', () => {
  it('places each page area\'s master chrome once as a shared Form XObject, sized to that area', () => {
    const d = Document.New();
    d.AddPage(PageFormat.custom(200, 100));
    d.AddPage(PageFormat.custom(200, 100));
    d.AddPage(PageFormat.custom(300, 400));
    const fill = (y: number): ChromeOp => ({ kind: 'fill', color: [0, 0, 0], path: [['M', 0, y], ['L', 1, y], ['L', 1, y + 1], ['Z']] });
    const n = paintChrome(d, {
      pages: [{ pageArea: 0, ops: [] }, { pageArea: 0, ops: [fill(5)] }, { pageArea: 1, ops: [] }],
      masters: new Map([[0, { ops: [fill(0)], w: 200, h: 100 }], [1, { ops: [fill(0)], w: 300, h: 400 }]]),
    }, () => {});
    expect(n).toBe(3);
    const xobjs = d.Pages.map((p) => [...((p.Resources?.get('XObject') as Map<string, unknown>) ?? new Map()).values()]);
    expect(xobjs[0][0]).toEqual(xobjs[1][0]);
    expect(xobjs[0][0]).not.toEqual(xobjs[2][0]);
    // Review Focus 3: the area-1 XObject is flipped against ITS page height.
    const form = d.resolve(xobjs[2][0] as never) as { dict: Map<string, unknown>; raw: Uint8Array };
    expect(form.dict.get('BBox')).toEqual([0, 0, 300, 400]);
    expect(ascii(form.raw)).toContain('0 400 m');
  });

  it('paints nothing and counts 0 when there are no operations', () => {
    const d = doc0();
    expect(paintChrome(d, { pages: [{ pageArea: 0, ops: [] }], masters: new Map() }, () => {})).toBe(0);
  });
});
