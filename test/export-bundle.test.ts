import { expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { buildTextAndImagePage } from './helpers/build-edit-pdf.js';
import { buildMeshPdf } from './helpers/build-mesh-pdf.js';
import { decodePng } from './helpers/decode-png.js';

import { LoadLimits } from '../src/loadlimits.js';
import { buildRestrictedTtfPdf } from './helpers/build-embed-fonts.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { name } from '../src/types.js';

const read = (bytes?: Uint8Array) => new TextDecoder().decode(bytes);
const picture = buildTextAndImagePage('BT /F1 10 Tf 50 250 Td (jump) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q');

it('preserves first selection order and original numbers in each bundle layout', () => {
  const doc = Document.New();
  expect(doc.ToHtmlBundle().entryPoints).toEqual(['index.html']);
  expect(doc.ToSvgBundle().entryPoints).toEqual([]);
  for (let i = 0; i < 3; i++) doc.AddPage();
  const pages = [3, 1, 3];
  expect(doc.ToHtmlBundle({ split: true, pages }).entryPoints).toEqual(['page-3.html', 'page-1.html']);
  expect(doc.ToSvgBundle({ pages }).entryPoints).toEqual(['page-3.svg', 'page-1.svg']);
  const html = read(doc.ToHtmlBundle({ pages }).files.get('index.html'));
  expect(html).toMatch(/id="page-3"[\s\S]*id="page-1"/);
  expect(html).not.toContain('id="page-2"');
  expect(doc.ToSvgBundle({ pages: [] }).entryPoints).toHaveLength(3);
  for (const n of [0, 1.5, 4, NaN]) expect(() => doc.ToSvgBundle({ pages: [n] })).toThrow(RangeError);
  for (const patchDpi of [0, -2, NaN, Infinity]) expect(() => doc.ToHtmlBundle({ patchDpi })).toThrow(RangeError);
});

it('shares byte-identical assets across independent pages and preserves inline exports', () => {
  const doc = Document.Open(picture);
  doc.AddPage(Document.Open(picture).Pages[0]);
  const svg = doc.Pages[0].ToSvg();
  const expected = Buffer.from(/data:image\/png;base64,([^"]+)/.exec(svg)![1], 'base64');
  for (const bundle of [doc.ToSvgBundle(), doc.ToHtmlBundle({ split: true }),
    doc.ToHtmlBundle({ mode: 'fixed', pages: [2, 1] })]) {
    const assets = [...bundle.files.keys()].filter(k => k.startsWith('assets/'));
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatch(/^assets\/[0-9a-f]{64}\.png$/);
    expect(Buffer.from(bundle.files.get(assets[0])!)).toEqual(expected);
    for (const path of bundle.entryPoints) expect(read(bundle.files.get(path))).toContain(assets[0]);
  }
  for (const backdrop of ['raster', 'page'] as const) {
    const bundle = doc.ToHtmlBundle({ mode: 'fixed', backdrop, split: true });
    const entry = read(bundle.files.get('page-1.html'));
    const asset = /<img src="([^"]+)"/.exec(entry)![1];
    expect(bundle.files.has(asset)).toBe(true);
    expect(read(bundle.files.get('page-2.html'))).toContain(asset);
    expect(bundle.files.size).toBe(3);
  }
  expect(doc.Pages[0].ToSvg()).toBe(svg);
});

it('rasterizes a mesh alone at patch DPI and keeps its point dimensions', () => {
  const doc = Document.Open(buildMeshPdf({ type: 4, vertices: [
    { x: 10, y: 10, comps: [1, 0, 0] }, { x: 190, y: 10, comps: [0, 1, 0] },
    { x: 100, y: 190, comps: [0, 0, 1] },
  ] }));
  for (const dpi of [72, 144]) {
    const bundle = doc.ToSvgBundle({ patchDpi: dpi });
    const svg = read(bundle.files.get('page-1.svg'));
    expect(svg).toContain('viewBox="0 0 200 200"');
    const path = /<image[^>]+href="([^"]+)"/.exec(svg)![1];
    const png = decodePng(bundle.files.get(path)!);
    expect(png.width).toBe(200 * dpi / 72);
    expect(png.at(0, 0)[3]).toBe(0);
    expect(png.at(20 * dpi / 72, 184 * dpi / 72)[0]).toBeGreaterThan(200);
  }
  expect(doc.Pages[0].ToSvg()).toContain('#808080');
});

it('stores the embedded WOFF bytes once and honors font permissions', () => {
  const doc = Document.Open(buildRestrictedTtfPdf());
  doc.AddPage(Document.Open(buildRestrictedTtfPdf()).Pages[0]);
  const allowed = doc.ToHtmlBundle({ mode: 'fixed', fonts: 'embed-all', split: true });
  const html = read(allowed.files.get('page-1.html'));
  const path = /src:url\((assets\/[^)]+\.woff)\)/.exec(html)![1];
  expect(read(allowed.files.get('page-2.html'))).toContain(path);
  expect(read(allowed.files.get(path)?.slice(0, 4))).toBe('wOFF');
  expect(allowed.files.size).toBe(3);
  expect(doc.ToHtmlBundle({ mode: 'fixed', fonts: 'embed' }).files.size).toBe(1);
});

it('bounds clipped shading allocations, preserves paint order and propagates pixel limits', () => {
  const pdf = buildSvgPdf({
    cropBox: [10, 10, 160, 160],
    resources: '<< /Shading << /S 5 0 R >> >>',
    extra: { 5: '<< /ShadingType 1 /ColorSpace /DeviceGray /Domain [0 200 0 200] /Function 6 0 R >>',
      6: '<< /FunctionType 2 /Domain [0 200] /C0 [0] /C1 [1] /N 1 >>' },
    content: '1 0 0 rg 0 0 5 5 re f q 20 30 15 10 re W n /S sh Q 0 1 0 rg 30 30 5 5 re f',
  });
  const doc = Document.Open(pdf, { limits: LoadLimits.defaults.with({ maxCanvasPixels: 150 }) });
  for (const mode of ['svg', 'fixed']) {
    const bundle = mode === 'svg' ? doc.ToSvgBundle({ patchDpi: 72 }) : doc.ToHtmlBundle({ mode: 'fixed', patchDpi: 72 });
    const markup = read(bundle.files.get(bundle.entryPoints[0]));
    expect(markup).toMatch(/fill="#ff0000"[\s\S]*<image x="10" y="120" width="15" height="10"[^>]*clip-path=[\s\S]*fill="#00ff00"/);
    expect(decodePng([...bundle.files.entries()].find(([k]) => k.endsWith('.png'))![1]).width).toBe(15);
  }
  expect(() => doc.ToSvgBundle({ patchDpi: 144 })).toThrow(/maxCanvasPixels/);
  expect(() => doc.ToHtmlBundle({ mode: 'fixed' })).toThrow(/maxCanvasPixels/);
});

it('keeps native gradients as vectors with distinct page-scoped IDs', () => {
  const fixture = buildSvgPdf({ resources: '<< /Shading << /S 5 0 R >> >>', content: '/S sh',
    extra: { 5: '<< /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 100 0] >>' } });
  const doc = Document.Open(fixture);
  doc.AddPage(Document.Open(fixture).Pages[0]);
  const bundle = doc.ToHtmlBundle({ mode: 'fixed' });
  const html = read(bundle.files.get('index.html'));
  const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map(m => m[1]);
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) expect(html).toContain('url(#' + id + ')');
  expect(bundle.files.size).toBe(1);
});

it('resolves named tagged links and leaves missing targets as readable text', () => {
  const doc = Document.New();
  const page = doc.AddPage().page;
  doc.AddPage();
  const p = doc.CreateStructTree().Append('P');
  page.AddTextBlock([{ text: 'Target', link: 'https://example.org' }], [50, 500, 300, 200], { tag: p });
  const link = page.Annotations.find(a => a.Subtype === 'Link')!;
  link.Dict.delete('A');
  link.Dict.set('Dest', name('there'));
  doc.SetNamedDestination('there', { page: 2 });
  const split = doc.ToHtmlBundle({ split: true });
  expect(read(split.files.get('page-1.html'))).toContain('href="page-2.html#page-2">Target</a>');
  for (const target of ['there', 'absent']) {
    link.Dict.set('Dest', name(target));
    const html = read(doc.ToHtmlBundle({ pages: [1] }).files.get('index.html'));
    expect(html).toContain('Target');
    expect(html).not.toContain('<a ');
  }
});

it('positions fixed links on a rotated crop box and escapes URI attributes', () => {
  const doc = Document.Open(picture);
  const p = doc.Pages[0];
  p.CropBox = [10, 20, 110, 220];
  p.Rotate = 90;
  p.AddLink({ rect: [20, 40, 50, 60], action: { type: 'uri', uri: 'https://example.org/?a=1&b=2' } });
  const html = read(doc.ToHtmlBundle({ mode: 'fixed' }).files.get('index.html'));
  expect(html).toContain('href="https://example.org/?a=1&amp;b=2"');
  expect(html).toContain('left:20px;top:10px;width:20px;height:30px');
});

it('keeps a cross-page tagged table within the selected page', () => {
  const doc = Document.New();
  const table = doc.CreateStructTree().Append('Table');
  for (const text of ['FirstRow', 'SecondRow']) {
    const page = doc.AddPage().page;
    const cell = table.Append('TR').Append('TD');
    page.AddTextBlock(text, [40, 400, 240, 450], { tag: cell });
  }
  const bundle = doc.ToHtmlBundle({ pages: [2] });
  const html = read(bundle.files.get('index.html'));
  expect(html).toContain('<table');
  expect(html).toContain('SecondRow');
  expect(html).not.toContain('FirstRow');
  expect(html.match(/<tr>/g)).toHaveLength(1);
});

it('bounds a raster shading painted through a stroked path', () => {
  const bytes = buildSvgPdf({ resources: '<< /Pattern << /P 5 0 R >> >>',
    extra: { 5: '<< /PatternType 2 /Shading << /ShadingType 1 /ColorSpace /DeviceGray /Domain [0 200 0 200] >> >>' },
    content: '/Pattern CS /P SCN 2 w 10 10 m 20 10 l S' });
  const doc = Document.Open(bytes, { limits: LoadLimits.defaults.with({ maxCanvasPixels: 20 }) });
  const bundle = doc.ToSvgBundle({ patchDpi: 72 });
  const patch = [...bundle.files.entries()].find(([path]) => path.endsWith('.png'))!;
  expect(decodePng(patch[1])).toMatchObject({ width: 10, height: 2 });
});

it('resolves a PDF string bookmark through the name tree when a legacy name collides', () => {
  const doc = Document.New();
  doc.AddPage();
  doc.AddPage();
  doc.SetNamedDestination('same', { page: 2 });
  doc.catalog().set('Dests', new Map([['same', [doc.pageRef(1), name('Fit')]]]));
  doc.SetOutlines([{ Title: 'Jump', Dest: { name: 'same' } }]);
  const entry = doc.ToHtmlBundle({ outlineNav: true });
  expect(read(entry.files.get('index.html'))).toContain('<a href="#page-2">Jump</a>');
});

it('ranks untagged text using just the exported pages', () => {
  const doc = Document.Open(picture);
  doc.AddPage();
  const ranked: number[] = [];
  doc.ToHtmlBundle({ pages: [1], onProgress: p => {
    if (p.phase === 'headings') ranked.push(p.pageNumber!);
  } });
  expect(ranked).toEqual([1]);
});

it('omits link hit regions marked for print only', () => {
  const doc = Document.Open(picture);
  doc.Pages[0].AddLink({ rect: [1, 1, 40, 40], action: { type: 'uri', uri: 'https://example.org/print' } }).Flags = 32;
  expect(read(doc.ToHtmlBundle({ mode: 'fixed' }).files.get('index.html'))).not.toContain('https://example.org/print');
});

it('keeps embedded-data URI actions out of distributed navigation', () => {
  const doc = Document.Open(picture);
  const action = { type: 'uri', uri: 'data:text/plain,bookmark' } as const;
  doc.SetOutlines([{ Title: 'Embedded data', Action: action }]);
  doc.Pages[0].AddLink({ rect: [45, 243, 100, 265], action });
  for (const mode of ['semantic', 'fixed'] as const) {
    const html = read(doc.ToHtmlBundle({ mode, outlineNav: true }).files.get('index.html'));
    expect(html).toContain('Embedded data');
    expect(html).not.toContain('href="data:');
  }
});

it('resolves selected destinations in semantic links, positioned links and nested bookmarks', () => {
  const doc = Document.Open(picture);
  doc.AddPage();
  doc.AddPage();
  doc.Pages[0].AddLink({ rect: [45, 245, 90, 265], action: { type: 'goto', page: 3 } });
  doc.SetOutlines([{ Title: '<omitted>', Dest: { page: 2 }, Children: [{ Title: 'last', Dest: { page: 3 } }] }]);
  for (const mode of ['semantic', 'fixed'] as const) {
    for (const split of [false, true]) {
      const bundle = doc.ToHtmlBundle({ pages: [3, 1], mode, split, outlineNav: true });
      const html = read(bundle.files.get(split ? 'page-1.html' : 'index.html'));
      const href = split ? 'page-3.html#page-3' : '#page-3';
      expect(html.split('href="' + href + '"')).toHaveLength(3);
      expect(html).toContain('&lt;omitted&gt;');
      expect(html).not.toContain('#page-2');
      expect(html).toContain('id="page-1"');
    }
  }
});
