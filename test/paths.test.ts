import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { Page } from '../src/page.js';
import { verifyPagePath } from '../src/paths.js';
import { enc } from '../src/serialize.js';
import { streamOf } from '../src/pagecontent.js';
import { name, type PdfDict, type PdfStream } from '../src/types.js';
import { buildPathsPdf, buildSeparationPathPdf, buildXObjectPathPdf, buildTaggedPathPdf } from './helpers/build-paths-pdf.js';

const paths = (bytes: Uint8Array) => Document.Open(bytes).Pages[0].GetPaths();

describe('GetPaths — geometry, device color, emission', () => {
  it('extracts a filled RGB rectangle', () => {
    const p = paths(buildPathsPdf());
    const rect = p.find((x) => x.fill?.space === 'DeviceRGB' && x.subpaths[0]?.closed);
    expect(rect).toBeDefined();
    expect(rect!.fill!.rgb).toEqual([255, 0, 0]);
    expect(rect!.stroke).toBeNull();
    expect(rect!.fillRule).toBe('nonzero');
    expect(rect!.subpaths[0].closed).toBe(true);
    // device bbox = user-space rect (identity CTM): [10,10,60,40]
    expect(rect!.bbox).toEqual([10, 10, 60, 40]);
  });

  it('extracts a stroked CMYK line with scaled line width', () => {
    const p = paths(buildPathsPdf());
    const line = p.find((x) => x.stroke?.space === 'DeviceCMYK');
    expect(line).toBeDefined();
    expect(line!.fill).toBeNull();
    expect(line!.lineWidth).toBe(4);                 // identity CTM
    expect(line!.stroke!.rgb).toEqual([0, 255, 255]); // cyan cmyk -> rgb
    expect(line!.subpaths[0].segments.map((s) => s.op)).toEqual(['move', 'line']);
  });

  it('emits fill+stroke for B', () => {
    const p = paths(buildPathsPdf());
    const bez = p.find((x) => x.fill?.rgb[1] === 255 && x.stroke !== null);
    expect(bez).toBeDefined();
    const seg = bez!.subpaths[0].segments.find((s) => s.op === 'cubic') as
      Extract<import('../src/paths.js').PathSegment, { op: 'cubic' }>;
    expect(seg.c1).toEqual([120, 180]);
    expect(seg.pt).toEqual([180, 100]);
  });

  it('emits a clip-only path for W* n', () => {
    const p = paths(buildPathsPdf());
    const clip = p.find((x) => x.clip === 'evenodd');
    expect(clip).toBeDefined();
    expect(clip!.fill).toBeNull();
    expect(clip!.stroke).toBeNull();
  });

  it('normalizes v and y into cubic segments', () => {
    const p = paths(buildPathsPdf());
    const vy = p.find((x) => x.subpaths[0]?.segments[0]?.op === 'move' &&
      (x.subpaths[0].segments[0] as Extract<import('../src/paths.js').PathSegment, { op: 'move' }>).pt[0] === 10 &&
      (x.subpaths[0].segments[0] as Extract<import('../src/paths.js').PathSegment, { op: 'move' }>).pt[1] === 150);
    expect(vy).toBeDefined();
    const segs = vy!.subpaths[0].segments;
    // v: c1 = current point (10,150); c2 = (10,160); pt = (30,160)
    expect(segs[1]).toEqual({ op: 'cubic', c1: [10, 150], c2: [10, 160], pt: [30, 160] });
    // y: operands 50 160 30 150 -> c1 = (50,160); c2 = pt = (30,150)
    expect(segs[2]).toEqual({ op: 'cubic', c1: [50, 160], c2: [30, 150], pt: [30, 150] });
  });
});

describe('GetPaths — colorspace resolution', () => {
  it('resolves a Separation fill to its alternate color and reports the family', () => {
    const p = Document.Open(buildSeparationPathPdf()).Pages[0].GetPaths();
    expect(p.length).toBe(1);
    expect(p[0].fill!.space).toBe('Separation');
    expect(p[0].fill!.rgb).toEqual([255, 0, 0]);
  });
});

describe('GetPaths — Form XObjects', () => {
  it('descends into a Form XObject and composes the CTM', () => {
    const p = Document.Open(buildXObjectPathPdf()).Pages[0].GetPaths();
    expect(p.length).toBe(1);
    expect(p[0].fill!.space).toBe('DeviceRGB');
    expect(p[0].fill!.rgb).toEqual([0, 0, 255]);
    // 0 0 20 20 rect scaled 2x + translate (100,100) -> [100,100,140,140]
    expect(p[0].bbox).toEqual([100, 100, 140, 140]);
    expect(p[0].addr.path).toEqual(['Fm0']);
    // subpaths remain in the form's own user space (unscaled)
    expect(p[0].bbox).not.toEqual([0, 0, 20, 20]);
  });
});

describe('GetPaths — marked content', () => {
  it('carries MCID and artifact flags', () => {
    const p = Document.Open(buildTaggedPathPdf()).Pages[0].GetPaths();
    expect(p.length).toBe(2);
    const tagged = p.find((x) => x.mcid === 3);
    expect(tagged).toBeDefined();
    expect(tagged!.artifact).toBeFalsy();
    const art = p.find((x) => x.artifact === true);
    expect(art).toBeDefined();
    expect(art!.mcid).toBeUndefined();
  });
});

describe('GetPaths — round-trip', () => {
  it('extracts identically after Save/Open', () => {
    const before = Document.Open(buildPathsPdf()).Pages[0].GetPaths();
    const saved = Document.Open(buildPathsPdf()).Save();
    const after = Document.Open(saved).Pages[0].GetPaths();
    expect(after.length).toBe(before.length);
    expect(after.map((x) => x.bbox)).toEqual(before.map((x) => x.bbox));
    expect(after.map((x) => x.fill?.rgb ?? null)).toEqual(before.map((x) => x.fill?.rgb ?? null));
  });
});

function setContents(doc: Document, page: Page, ...contents: string[]): void {
  page.Dict.set('Contents', contents.map((content) => doc.allocObject(streamOf(enc(content)))));
}

describe('GetPaths — addresses', () => {
  it('names construction through paint and includes clip termination', () => {
    const page = Document.Open(buildPathsPdf()).Pages[0];
    const [rect, , , clip] = page.GetPaths();
    const at = (opIndex: number) => ({ path: [], streamIndex: 0, opIndex });
    expect(rect.Addr).toEqual({ start: at(1), end: at(2), invocations: [] });
    expect(rect.addr).toEqual(rect.Addr.end);
    expect(clip.Addr).toEqual({ start: at(14), end: at(16), invocations: [] });
  });

  it('tracks a path across streams and resets the start at each paint', () => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    setContents(doc, page, '1 w 0 0 m 20 0 l', '20 20 l h S 1 1 4 4 re f');
    const [line, box] = page.GetPaths();
    expect(line.Addr.start).toEqual({ path: [], streamIndex: 0, opIndex: 1 });
    expect(line.Addr.end).toEqual({ path: [], streamIndex: 1, opIndex: 2 });
    expect(box.Addr.start).toEqual({ path: [], streamIndex: 1, opIndex: 3 });
    expect(verifyPagePath(doc, page, line)).toBe(line.Addr);
  });

  it('distinguishes repeated draws of a nested Form with inherited resources', () => {
    const doc = Document.Open(buildXObjectPathPdf());
    const [page] = doc.Pages;
    const xobjects = doc.resolve(page.Resources!.get('XObject')) as PdfDict;
    const outer = streamOf(enc('/Fm0 Do'));
    outer.dict.set('Subtype', name('Form'));
    outer.dict.set('BBox', [0, 0, 20, 20]);
    xobjects.set('Outer', doc.allocObject(outer));
    setContents(doc, page, '/Outer Do', 'q 1 0 0 1 30 0 cm /Outer Do Q');

    const [first, second] = page.GetPaths();
    expect(first.Addr.start).toEqual({ path: ['Outer', 'Fm0'], streamIndex: 0, opIndex: 1 });
    expect(second.Addr.end).toEqual(first.Addr.end);
    expect(first.Addr.invocations).toEqual([
      { path: [], streamIndex: 0, opIndex: 0 },
      { path: ['Outer'], streamIndex: 0, opIndex: 0 },
    ]);
    expect(second.Addr.invocations).toEqual([
      { path: [], streamIndex: 1, opIndex: 2 },
      { path: ['Outer'], streamIndex: 0, opIndex: 0 },
    ]);
    expect(verifyPagePath(doc, page, second)).toBe(second.Addr);

    const inner = doc.resolve(xobjects.get('Fm0')) as PdfStream;
    xobjects.set('Fm0', doc.allocObject({ ...inner, dict: new Map(inner.dict) }));
    const resources = page.Resources;
    const objectCount = [...doc.objectEntries()].length;
    expect(() => verifyPagePath(doc, page, second)).toThrow(RangeError);
    expect(page.Resources).toBe(resources);
    expect([...doc.objectEntries()]).toHaveLength(objectCount);
    expect(verifyPagePath(doc, page, page.GetPaths()[1])).toEqual(second.Addr);
  });

  it('rejects a replaced stream even if the same operations occupy its old span', () => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    setContents(doc, page, '0 0 10 10 re f 0 0 10 10 re f');
    const [first] = page.GetPaths();
    setContents(doc, page, '0 0 10 10 re f');
    expect(() => verifyPagePath(doc, page, first)).toThrow(RangeError);
  });

  it('rejects an in-place byte change and paths from another page', () => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    const other = doc.AddPage().page;
    const stream = streamOf(enc('0 0 10 10 re f'));
    const ref = doc.allocObject(stream);
    page.Dict.set('Contents', ref);
    other.Dict.set('Contents', ref);
    const [path] = page.GetPaths();
    expect(() => verifyPagePath(doc, other, path)).toThrow(RangeError);
    stream.raw[0] = 0x31;
    expect(() => verifyPagePath(doc, page, path)).toThrow(RangeError);
  });

  it('tracks the live page across wrapper replacement and rejects a removed page', () => {
    const doc = Document.Open(buildPathsPdf());
    const [original] = doc.Pages;
    const [path] = original.GetPaths();
    doc.AddPage();
    const [current] = doc.Pages;
    expect(verifyPagePath(doc, current, path)).toBe(path.Addr);

    doc.RemovePage(current);
    expect(() => verifyPagePath(doc, original, path)).toThrow(RangeError);
  });
});
