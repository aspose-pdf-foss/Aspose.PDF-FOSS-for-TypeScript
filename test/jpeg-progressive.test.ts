import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeJpeg, decodeJpegFrame } from '../src/jpeg.js';
import { encodeJpeg, JpegEncodeOptions, JpegKind } from '../src/jpegencode.js';
import { Document } from '../src/document.js';
import { isStream } from '../src/types.js';
import { readPnm } from './helpers/read-pnm.js';
import { buildSimpleImagePdf } from './helpers/build-imageopt-pdf.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => new Uint8Array(readFileSync(join(here, 'fixtures/jpeg', name)));

/** Byte equality WITHOUT a deep-equality diff: on a mismatch `toEqual` renders a
 *  diff of two 100 KB arrays, which took 211 s and let a mutation harness time
 *  out and read the timeout as a pass. */
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** Every marker that opens a segment, in file order (entropy data skipped). */
function markers(jpeg: Uint8Array): number[] {
  const out: number[] = [];
  let p = 2;
  while (p + 3 < jpeg.length) {
    if (jpeg[p] !== 0xff) { p++; continue; }
    const m = jpeg[p + 1];
    if (m === 0x00 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) { p++; continue; }
    out.push(m);
    if (m === 0xd9) break;
    p += 2 + ((jpeg[p + 2] << 8) | jpeg[p + 3]);
  }
  return out;
}

/** Baseline and progressive encodings of the same samples. */
function pair(w: number, h: number, s: Uint8Array, kind: JpegKind, o: JpegEncodeOptions = {}) {
  return {
    base: encodeJpeg(w, h, s, kind, { quality: 75, ...o }),
    prog: encodeJpeg(w, h, s, kind, { quality: 75, ...o, progressive: true }),
  };
}

describe('progressive JPEG output (SOF2, spectral selection)', () => {
  const photo = readPnm(fixture('testorig.ppm'));   // 227x149: odd, so every grid pads

  it('decodes to the baseline\'s exact pixels, and is smaller, for a photograph at 4:2:0', () => {
    // 4:2:0 is the default and what Optimize's image pass writes for RGB.
    // Measured on testorig: 1.5-2.2% smaller at quality 50-90.
    const { base, prog } = pair(photo.width, photo.height, photo.data, 'rgb');
    expect(decodeJpegFrame(prog).frame.progressive).toBe(true);
    expect(same(decodeJpeg(prog).data, decodeJpeg(base).data)).toBe(true);
    expect(prog.length).toBeLessThan(base.length);
  });

  it('decodes to the baseline\'s exact pixels at 4:4:4, where it is NOT smaller', () => {
    // Measured on testorig: 0.8-1.6% LARGER at quality 50-90 — full-resolution
    // chroma on a small image does not repay a scan per component. Recorded so
    // it reads as a measurement rather than a promise nobody checked.
    const { base, prog } = pair(photo.width, photo.height, photo.data, 'rgb', { subsampling: '4:4:4' });
    expect(same(decodeJpeg(prog).data, decodeJpeg(base).data)).toBe(true);
    expect(prog.length).toBeGreaterThan(base.length);
  });

  it('writes SOF2, one DC scan, then one AC scan per component', () => {
    const { prog } = pair(photo.width, photo.height, photo.data, 'rgb');
    const m = markers(prog);
    expect(m).toContain(0xc2);
    expect(m).not.toContain(0xc0);
    expect(m.filter((x) => x === 0xda)).toHaveLength(4);
  });

  it('round-trips gray and CMYK', () => {
    const gray = readPnm(fixture('synth-gray.pgm'));
    const g = pair(gray.width, gray.height, gray.data, 'gray');
    expect(same(decodeJpeg(g.prog).data, decodeJpeg(g.base).data)).toBe(true);
    const cmyk = decodeJpeg(fixture('synth-cmyk-t0-baseline.jpg'));
    const c = pair(cmyk.width, cmyk.height, cmyk.data, 'cmyk');
    expect(markers(c.prog).filter((x) => x === 0xda)).toHaveLength(5);
    expect(same(decodeJpeg(c.prog).data, decodeJpeg(c.base).data)).toBe(true);
  });

  it('flushes an EOB run at 0x7FFF blocks', () => {
    // A flat image of more than 32767 blocks: every AC block is empty, so one
    // run would overflow the 15-bit EOBRUN without the flush.
    const w = 8 * 190, h = 8 * 180;                 // 34200 blocks
    const flat = new Uint8Array(w * h).fill(90);
    const { base, prog } = pair(w, h, flat, 'gray');
    expect(same(decodeJpeg(prog).data, decodeJpeg(base).data)).toBe(true);
    // And the runs are what pay for it here: measured 4,451 bytes against
    // baseline's 8,710, and 8,720 with an EOB per block instead of runs. The
    // photograph cannot see this — it stays smaller either way.
    expect(prog.length).toBeLessThan(base.length * 0.6);
  });

  it('is what Optimize({ images: { progressive } }) writes, rendering like the baseline pass', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf({ imgW: 128, imgH: 96 });
    const runs = [false, true].map((progressive) => {
      const doc = Document.Open(bytes);
      doc.Optimize({ images: { quality: 75, progressive } });
      const s = doc.getObject(imgObjNum);
      if (!isStream(s)) throw new Error('image gone');
      return { doc, raw: s.raw };
    });
    expect(markers(runs[0].raw)).toContain(0xc0);
    expect(markers(runs[1].raw)).toContain(0xc2);
    expect(same(runs[1].doc.Pages[0].ToImage(), runs[0].doc.Pages[0].ToImage())).toBe(true);
  });
});
