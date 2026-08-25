import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
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
