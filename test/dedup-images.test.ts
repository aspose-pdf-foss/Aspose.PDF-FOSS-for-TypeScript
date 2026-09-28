import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { dedupStreams } from '../src/dedup.js';
import { imageKey } from '../src/imagehref.js';
import { PdfObject, PdfStream, name, ref, isStream } from '../src/types.js';
import { serializeDocument } from '../src/serializer.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A 16x16 RGB picture with enough structure that a one-sample change is the
 *  only difference between two copies. */
function picture(tweak = false): Uint8Array {
  const px = new Uint8Array(16 * 16 * 3);
  for (let i = 0; i < px.length; i++) px[i] = (i * 37 + (i >> 5) * 11) & 0xff;
  if (tweak) px[100] ^= 1;
  return px;
}
const mask = (): Uint8Array => Uint8Array.from({ length: 256 }, (_, i) => (i * 7) & 0xff);

type Coding = 'raw' | 'flate' | 'hexflate';

function imageStream(samples: Uint8Array, coding: Coding, extra: [string, PdfObject][] = [], gray = false): PdfStream {
  const dict = new Map<string, PdfObject>([
    ['Type', name('XObject')], ['Subtype', name('Image')],
    ['Width', 16], ['Height', 16], ['BitsPerComponent', 8],
    ['ColorSpace', name(gray ? 'DeviceGray' : 'DeviceRGB')], ...extra,
  ]);
  if (coding === 'raw') return { kind: 'stream', dict, raw: samples };
  const z = new Uint8Array(deflateSync(Buffer.from(samples)));
  if (coding === 'flate') { dict.set('Filter', name('FlateDecode')); return { kind: 'stream', dict, raw: z }; }
  const hex = enc(Buffer.from(z).toString('hex') + '>');
  dict.set('Filter', [name('ASCIIHexDecode'), name('FlateDecode')]);
  return { kind: 'stream', dict, raw: hex };
}

interface Img { samples: Uint8Array; coding: Coding; smask?: { samples: Uint8Array; coding: Coding } }

/** One page drawing Im1 at the left and Im2 at the right. Objects 10+ are images. */
function buildTwoImagePdf(a: Img, b: Img): Uint8Array {
  const objects = new Map<number, PdfObject>();
  let next = 10;
  const add = (img: Img): number => {
    const extra: [string, PdfObject][] = [];
    if (img.smask) {
      const m = next++;
      objects.set(m, imageStream(img.smask.samples, img.smask.coding, [], true));
      extra.push(['SMask', ref(m, 0)]);
    }
    const n = next++;
    objects.set(n, imageStream(img.samples, img.coding, extra));
    return n;
  };
  const i1 = add(a), i2 = add(b);
  const body = 'q 100 0 0 100 50 50 cm /Im1 Do Q q 100 0 0 100 250 50 cm /Im2 Do Q';
  objects.set(3, { kind: 'stream', dict: new Map([['Length', body.length]]), raw: enc(body) });
  objects.set(2, new Map<string, PdfObject>([
    ['Type', name('Page')], ['Parent', ref(4, 0)], ['MediaBox', [0, 0, 400, 200]], ['Contents', ref(3, 0)],
    ['Resources', new Map<string, PdfObject>([
      ['XObject', new Map<string, PdfObject>([['Im1', ref(i1, 0)], ['Im2', ref(i2, 0)]])],
    ])],
  ]));
  objects.set(4, new Map<string, PdfObject>([['Type', name('Pages')], ['Kids', [ref(2, 0)]], ['Count', 1]]));
  objects.set(1, new Map<string, PdfObject>([['Type', name('Catalog')], ['Pages', ref(4, 0)]]));
  return serializeDocument(objects, new Map<string, PdfObject>([['Root', ref(1, 0)]]));
}

function imageCount(pdf: Uint8Array): number {
  const doc = Document.Open(pdf);
  let n = 0;
  for (const [, o] of doc.objectEntries()) if (isStream(o) && (o.dict.get('Subtype') as { name?: string })?.name === 'Image') n++;
  return n;
}

function optimizeAndCompare(pdf: Uint8Array): { saved: Uint8Array; report: ReturnType<Document['Optimize']> } {
  const before = Document.Open(pdf).Pages[0].ToImage();
  const doc = Document.Open(pdf);
  const report = doc.Optimize();
  const saved = doc.Save();
  expect(Document.Open(saved).Pages[0].ToImage()).toEqual(before);
  return { saved, report };
}

describe('dedup — image XObjects by decoded samples', () => {
  it('merges one picture stored raw and again Flate-coded, and renders identically', () => {
    const pdf = buildTwoImagePdf({ samples: picture(), coding: 'raw' }, { samples: picture(), coding: 'flate' });
    expect(imageCount(pdf)).toBe(2);
    const { saved, report } = optimizeAndCompare(pdf);
    expect(report.dedup.merged).toBe(1);
    expect(imageCount(saved)).toBe(1);
  });

  it('keeps the compressed copy, whichever object number it has', () => {
    const doc = Document.Open(buildTwoImagePdf({ samples: picture(), coding: 'raw' }, { samples: picture(), coding: 'flate' }));
    dedupStreams(doc);
    const [survivor] = [...doc.objectEntries()].map(([, o]) => o)
      .filter((o): o is PdfStream => isStream(o) && (o.dict.get('Subtype') as { name?: string })?.name === 'Image');
    expect((survivor.dict.get('Filter') as { name: string }).name).toBe('FlateDecode');
  });

  it('merges across a multi-filter transparent chain', () => {
    const pdf = buildTwoImagePdf({ samples: picture(), coding: 'hexflate' }, { samples: picture(), coding: 'flate' });
    const { saved, report } = optimizeAndCompare(pdf);
    expect(report.dedup.merged).toBe(1);
    expect(imageCount(saved)).toBe(1);
  });

  it('does not merge two images one sample apart', () => {
    const pdf = buildTwoImagePdf({ samples: picture(), coding: 'raw' }, { samples: picture(true), coding: 'flate' });
    const { saved, report } = optimizeAndCompare(pdf);
    expect(report.dedup.merged).toBe(0);
    expect(imageCount(saved)).toBe(2);
  });

  it('does not merge equal samples that MEAN different pictures', () => {
    // 768 bytes are 16x16 RGB in one and 16x48 gray in the other: identical
    // decoded bytes, different images. The dict without its filter keys is part
    // of the key.
    const doc = Document.Open(buildTwoImagePdf({ samples: picture(), coding: 'raw' }, { samples: picture(), coding: 'flate' }));
    for (const [, o] of doc.objectEntries()) {
      if (isStream(o) && (o.dict.get('Filter') as { name?: string })?.name === 'FlateDecode') {
        o.dict.set('ColorSpace', name('DeviceGray')); o.dict.set('Height', 48);
      }
    }
    expect(dedupStreams(doc).merged).toBe(0);
  });

  it('merges images whose soft masks are themselves raw/Flate duplicates', () => {
    const pdf = buildTwoImagePdf(
      { samples: picture(), coding: 'raw', smask: { samples: mask(), coding: 'raw' } },
      { samples: picture(), coding: 'flate', smask: { samples: mask(), coding: 'flate' } },
    );
    expect(imageCount(pdf)).toBe(4);
    const { saved, report } = optimizeAndCompare(pdf);
    expect(report.dedup.merged).toBe(2);
    expect(imageCount(saved)).toBe(2);
  });

  it('keeps imageKey\'s context-free hash unchanged for the exporters', () => {
    const b = Uint8Array.from([1, 2, 3]);
    expect(imageKey(b)).toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
    expect(imageKey(b, '')).not.toBe(imageKey(b));
  });
});
