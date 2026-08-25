import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildTextAndImagePage } from './helpers/build-edit-pdf.js';
import { buildSimpleImagePdf } from './helpers/build-imageopt-pdf.js';

const FIGURE_PAGE = 'BT /F1 10 Tf 50 250 Td (caption) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q';

const open = (stream: string) => Document.Open(buildTextAndImagePage(stream));

/** Two pages carrying the same picture as two DISTINCT image XObjects — what a
 *  merge produces, and the case dedup exists for. Drawing one XObject twice
 *  would not exercise it: page.Images is keyed by resource, so the untagged
 *  builder emits one figure per XObject however often it is painted. */
function duplicated(): Document {
  const doc = open(FIGURE_PAGE);
  doc.AddPage(doc.Pages[0]);          // a deep copy: same bytes, new object
  return Document.Open(doc.Save());
}

describe('ToMarkdownAssets — inline (the default)', () => {
  it('returns the same markdown ToMarkdown does', () => {
    const doc = open(FIGURE_PAGE);
    expect(doc.ToMarkdownAssets().markdown).toBe(doc.ToMarkdown());
  });

  it('emits data URIs and no assets', () => {
    const doc = open(FIGURE_PAGE);
    const out = doc.ToMarkdownAssets();
    expect(out.markdown).toContain('](data:image/png;base64,');
    expect(out.images).toEqual([]);
  });

  // Note what this does NOT prove: two copies of one picture encode to the same
  // bytes, so they yield the same URI with or without the cache. Inline dedup
  // saves the re-encoding, which is a COST and not visible in the output — it is
  // measured by the external cases below, where sharing is observable as one
  // asset. Do not read this green as covering the inline cache.
  it('gives two copies of one picture the identical URI', () => {
    const md = duplicated().ToMarkdownAssets().markdown;
    const hrefs = [...md.matchAll(/\]\((data:[^)]+)\)/g)].map((m) => m[1]);
    expect(hrefs).toHaveLength(2);
    expect(hrefs[0]).toBe(hrefs[1]);
  });
});

describe('ToMarkdownAssets — external', () => {
  it('references a file and hands back its bytes', () => {
    const out = open(FIGURE_PAGE).ToMarkdownAssets({ images: 'external' });
    expect(out.images).toHaveLength(1);
    const asset = out.images[0];
    expect(asset.path).toBe('images/img-1.png');
    expect(asset.mediaType).toBe('image/png');
    expect(Array.from(asset.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(out.markdown).toContain('](images/img-1.png)');
    expect(out.markdown).not.toContain('data:');
  });

  // A DCTDecode image passes through as JPEG, so its file must be .jpg — a
  // .png path holding JPEG bytes is a file no viewer opens.
  it('writes a JPEG image to a .jpg path', () => {
    const doc = Document.Open(buildSimpleImagePdf().bytes);
    const out = doc.ToMarkdownAssets({ images: 'external' });
    expect(out.images).toHaveLength(1);
    expect(out.images[0].mediaType).toBe('image/jpeg');
    expect(out.images[0].path).toBe('images/img-1.jpg');
    expect(Array.from(out.images[0].bytes.slice(0, 2))).toEqual([0xff, 0xd8]);
    expect(out.markdown).toContain('](images/img-1.jpg)');
  });

  it('honours imageDir', () => {
    const out = open(FIGURE_PAGE).ToMarkdownAssets({ images: 'external', imageDir: 'assets/pics' });
    expect(out.images[0].path).toBe('assets/pics/img-1.png');
    expect(out.markdown).toContain('](assets/pics/img-1.png)');
  });

  // The point of the issue: one image used twice is one file, referenced twice.
  it('writes a duplicated picture once and references it twice', () => {
    const out = duplicated().ToMarkdownAssets({ images: 'external' });
    expect(out.images).toHaveLength(1);
    const uses = [...out.markdown.matchAll(/images\/img-1\.png/g)];
    expect(uses).toHaveLength(2);
  });
});

describe('ToMarkdown with external images', () => {
  // The combination can only produce links to files nobody wrote. Refusing is
  // better than emitting a document that looks fine and is broken.
  it('throws, naming the method that returns the bytes', () => {
    const doc = open(FIGURE_PAGE);
    expect(() => doc.ToMarkdown({ images: 'external' })).toThrow(/ToMarkdownAssets/);
  });

  it('still allows the default inline mode', () => {
    expect(() => open(FIGURE_PAGE).ToMarkdown({ images: 'inline' })).not.toThrow();
  });
});

describe('Page.ToMarkdownAssets', () => {
  it('works per page, like its ToMarkdown sibling', () => {
    const doc = open(FIGURE_PAGE);
    const out = doc.Pages[0].ToMarkdownAssets({ images: 'external' });
    expect(out.images).toHaveLength(1);
    expect(out.markdown).toContain('](images/img-1.png)');
  });
});
