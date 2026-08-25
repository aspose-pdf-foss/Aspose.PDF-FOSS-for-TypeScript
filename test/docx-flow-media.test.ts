import { describe, it, expect } from 'vitest';
import { docxBody } from '../src/docxflow.js';
import { STYLE } from '../src/docxstyles.js';
import type { DocNode } from '../src/docmodel.js';
import type { PdfStream } from '../src/types.js';

const stream = (n: number) =>
  ({ kind: 'stream', dict: new Map([['N', n]]), raw: new Uint8Array() }) as unknown as PdfStream;

const imageSink = () => {
  const seen: PdfStream[] = [];
  return {
    seen,
    add(s: PdfStream) {
      seen.push(s);
      return { rid: `rIdImg${seen.length}`, pxWidth: 100, pxHeight: 50 };
    },
  };
};
const linkSink = () => {
  const seen: string[] = [];
  return { seen, add(h: string) { seen.push(h); return `rIdLnk${seen.length}`; } };
};

describe('docxBody hyperlinks', () => {
  it("wraps a link's runs in w:hyperlink with the hyperlink style", () => {
    const links = linkSink();
    const { xml } = docxBody([{ kind: 'container', type: 'P', children: [
      { kind: 'text', text: 'See ' },
      { kind: 'container', type: 'Link', href: 'https://example.com',
        children: [{ kind: 'text', text: 'the docs' }] },
    ] }], { add: () => undefined }, links);
    expect(links.seen).toEqual(['https://example.com']);
    expect(xml).toContain('<w:hyperlink r:id="rIdLnk1">');
    expect(xml).toContain(`<w:rStyle w:val="${STYLE.hyperlink}"/>`);
  });

  // An internal GoTo names a page object that will not exist once the PDF is
  // gone, so it degrades to the words it was on.
  it('emits a destination-less link as plain runs', () => {
    const links = linkSink();
    const { xml } = docxBody([{ kind: 'container', type: 'P', children: [
      { kind: 'container', type: 'Link', children: [{ kind: 'text', text: 'chapter two' }] },
    ] }], { add: () => undefined }, links);
    expect(links.seen).toEqual([]);
    expect(xml).not.toContain('w:hyperlink');
    expect(xml).toContain('chapter two');
  });

  it("keeps a linked run's own emphasis beside the hyperlink style", () => {
    const { xml } = docxBody([{ kind: 'container', type: 'P', children: [
      { kind: 'container', type: 'Link', href: 'https://example.com',
        children: [{ kind: 'text', text: 'bold link', bold: true }] },
    ] }], { add: () => undefined }, linkSink());
    expect(xml).toContain(`<w:rPr><w:rStyle w:val="${STYLE.hyperlink}"/><w:b/></w:rPr>`);
  });
});

describe('docxBody figures', () => {
  const fig = (sizes?: { width: number; height: number }[]): DocNode => ({
    kind: 'figure', alt: 'a chart', images: [stream(1)], tagged: true,
    ...(sizes ? { sizes } : {}),
  });

  it('sizes the drawing from the drawn box in EMU', () => {
    const { xml } = docxBody([fig([{ width: 180, height: 120 }])], imageSink(), linkSink());
    expect(xml).toContain('cx="2286000"');   // 180pt * 12700
    expect(xml).toContain('cy="1524000"');   // 120pt * 12700
  });

  it('falls back to pixels at 96 DPI when the drawn size is unknown', () => {
    const { xml } = docxBody([fig([{ width: 0, height: 0 }])], imageSink(), linkSink());
    expect(xml).toContain('cx="952500"');    // 100px * 0.75pt * 12700
  });

  it('puts the alt text on docPr', () => {
    expect(docxBody([fig([{ width: 10, height: 10 }])], imageSink(), linkSink()).xml)
      .toContain('descr="a chart"');
  });

  // Word tolerates a duplicate id in some builds and calls the file corrupt in
  // others, which makes it look like a reader-dependent defect.
  it('gives every drawing a unique non-zero docPr id', () => {
    const { xml } = docxBody(
      [fig([{ width: 10, height: 10 }]), fig([{ width: 10, height: 10 }])],
      imageSink(), linkSink());
    const ids = [...xml.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('0');
  });

  // A figure is described once: repeating /Alt on each part would have a screen
  // reader announce the same description N times.
  it('describes a composite figure once', () => {
    const composite: DocNode = {
      kind: 'figure', alt: 'a chart', images: [stream(1), stream(2)], tagged: true,
      sizes: [{ width: 10, height: 10 }, { width: 10, height: 10 }],
    };
    const { xml } = docxBody([composite], imageSink(), linkSink());
    expect(xml.match(/descr="a chart"/g)?.length).toBe(2);   // docPr + cNvPr of the FIRST only
  });

  // A tagged /Figure still has accessible content to announce; an untagged page
  // image has none, so it leaves nothing behind.
  it("keeps a tagged figure's alt when the image will not encode", () => {
    const dead = { add: () => undefined };
    expect(docxBody([fig()], dead, linkSink()).xml).toContain('a chart');
    expect(docxBody([{ kind: 'figure', alt: '', images: [stream(2)], tagged: false }],
      dead, linkSink()).xml).toBe('');
  });
});
