import { describe, it, expect } from 'vitest';
import { LoadLimits, LIMIT_FIELDS, type LoadLimitValues } from '../src/loadlimits.js';
import { ResourceLimitError, PdfParseError } from '../src/errors.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { decodeBmp } from '../src/bmp.js';
import { decodeTiff } from '../src/tiff.js';
import { buildBmp } from './helpers/build-bmp.js';
import { buildTiff, baseTags } from './helpers/build-tiff.js';

describe('LoadLimits', () => {
  it('names exactly the 17 fields ibzo.2-.4 and ibzo.12 consume', () => {
    // Asserted by SIZE, the rule htmlforeign.ts sets for its five tables: a
    // half-pasted field set is a red build rather than a limit that silently
    // does nothing. Every name here is one some later issue enforces.
    expect(LIMIT_FIELDS).toEqual([
      // ibzo.2 - parse boundary
      'maxFileBytes', 'maxObjects', 'maxXrefSections',
      'maxObjectBytes', 'maxNestingDepth', 'maxContainerItems',
      // ibzo.3 - filter and codec boundary
      'maxDecodedStreamBytes', 'maxTotalDecodedBytes', 'maxExpansionRatio',
      'maxFilterChain', 'maxImagePixels', 'maxFunctionSamples', 'maxSalvageProbes',
      // ibzo.4 - content and render boundary
      'maxContentBytes', 'maxContentTokens', 'maxCanvasPixels',
      // ibzo.12 - font programs
      'maxGlyphOperations',
    ]);
  });

  it('defaults every field to a positive safe integer', () => {
    // "Bounded defaults" is the whole posture: a caller who says nothing gets
    // limits, and opting out is explicit. A null here would be a silent opt-out.
    for (const f of LIMIT_FIELDS) {
      const v = LoadLimits.defaults[f];
      expect(Number.isSafeInteger(v), `${f} is ${v}`).toBe(true);
      expect(v as number).toBeGreaterThan(0);
    }
  });

  it('sets maxExpansionRatio above DEFLATE own ceiling', () => {
    // MEASURED, not cited: zlib deflates a 16 MiB run of zeros to 1028.3:1 and
    // approaches 1032:1 asymptotically. A limit of 1000 - the round number the
    // first draft reached for - refuses a legitimately compressed stream.
    expect(LoadLimits.defaults.maxExpansionRatio as number).toBeGreaterThan(1032);
  });

  it('bounds the two pixel defaults by MEASURED memory, not by guessed bytes a pixel (ibzo.10)', () => {
    // A page canvas is a Float32Array of RGBA: 16 bytes a pixel before any
    // encode, which is a fact of the type rather than a measurement. At the old
    // 2^28 that was 4 GB for the canvas alone. Keep it under 1.1 GB of floats.
    expect((LoadLimits.defaults.maxCanvasPixels as number) * 16).toBeLessThanOrEqual(1.1 * 2 ** 30);
    // Rendering an image measured 7.6-9.7 bytes a pixel; keep one under ~1.3 GB.
    expect((LoadLimits.defaults.maxImagePixels as number) * 10).toBeLessThanOrEqual(1.3 * 2 ** 30);
    // ...while admitting a 100-megapixel photograph and an A4 page at 600 dpi.
    expect(LoadLimits.defaults.maxImagePixels as number).toBeGreaterThanOrEqual(11_664 * 8_750);
    expect(LoadLimits.defaults.maxCanvasPixels as number).toBeGreaterThanOrEqual(Math.round(595 / 72 * 600) * Math.round(842 / 72 * 600));
  });

  it('is the ONE pixel bound: BMP and TIFF files refuse past it too', () => {
    // 11,586 squared is just over 2^27 and well under the 2^28 both readers used
    // to keep as their own constant — so a reader holding a second copy of the
    // number decodes on (and allocates) where this policy says stop.
    const side = 11_586;
    expect(side * side).toBeGreaterThan(LoadLimits.defaults.maxImagePixels as number);
    const bmp = buildBmp({ width: side, height: side, bpp: 24, rows: [], rawPixels: new Uint8Array(4) });
    expect(() => decodeBmp(bmp)).toThrow(expect.objectContaining({ limit: 'maxImagePixels' }));
    const tif = buildTiff({ le: true, pages: [{ tags: baseTags(side, side, 1), blocks: [new Uint8Array(4)] }] });
    expect(() => decodeTiff(tif)).toThrow(expect.objectContaining({ limit: 'maxImagePixels' }));
  });

  it('disables every field under unlimited(), and round-trips', () => {
    const u = LoadLimits.unlimited();
    for (const f of LIMIT_FIELDS) expect(u[f], f).toBeNull();
    expect(LoadLimits.unlimited()).toEqual(u);
  });

  it('disables one field alone, leaving the rest at their defaults', () => {
    // "null to disable THAT FIELD ALONE" - the issue's own words. A patch that
    // reset its neighbours would make a targeted opt-out a blanket one.
    const l = LoadLimits.defaults.with({ maxFileBytes: null });
    expect(l.maxFileBytes).toBeNull();
    expect(l.maxObjects).toBe(LoadLimits.defaults.maxObjects);
  });

  it('returns a new instance and leaves the receiver untouched', () => {
    const before = LoadLimits.defaults.maxObjects;
    const l = LoadLimits.defaults.with({ maxObjects: 10 });
    expect(l).not.toBe(LoadLimits.defaults);
    expect(l.maxObjects).toBe(10);
    expect(LoadLimits.defaults.maxObjects).toBe(before);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(LoadLimits.defaults)).toBe(true);
    expect(() => {
      (LoadLimits.defaults as unknown as Record<string, number>).maxObjects = 1;
    }).toThrow(TypeError);
  });

  it('throws TypeError for the wrong KIND of value', () => {
    // formcreate.ts's split: TypeError for the wrong kind of thing, RangeError
    // for outside the allowed set.
    expect(() => LoadLimits.defaults.with({ maxObjects: 1.5 })).toThrow(TypeError);
    expect(() => LoadLimits.defaults.with(
      { maxObjects: '10' as unknown as number })).toThrow(TypeError);
  });

  it('treats undefined as "leave alone", null as "disable"', () => {
    // viewerprefs.ts's convention, borrowed rather than re-invented: undefined
    // leaves, null disables, a value sets. A second rule for one shape is how
    // two option bags in one library come to disagree.
    const l = LoadLimits.defaults.with({ maxObjects: undefined, maxFileBytes: null });
    expect(l.maxObjects).toBe(LoadLimits.defaults.maxObjects);
    expect(l.maxFileBytes).toBeNull();
  });

  it('throws RangeError for a value outside the allowed SET', () => {
    expect(() => LoadLimits.defaults.with({ maxObjects: 0 })).toThrow(RangeError);
    expect(() => LoadLimits.defaults.with({ maxObjects: -1 })).toThrow(RangeError);
    expect(() => LoadLimits.defaults.with({ maxObjects: Infinity })).toThrow(RangeError);
    expect(() => LoadLimits.defaults.with({ maxObjects: NaN })).toThrow(RangeError);
  });

  it('rejects an unknown field rather than silently ignoring it', () => {
    // A typo'd name that quietly does nothing IS the failure ibzo.5 calls worse
    // than no limit at all - the caller believes they opted out and did not.
    expect(() => LoadLimits.defaults.with(
      { maxFileBytez: null } as unknown as Partial<LoadLimitValues>)).toThrow(TypeError);
  });

  it('validates the whole patch before assigning any of it', () => {
    // A rejected call leaves the receiver byte-identical - formcreate.ts's rule.
    // Without this the good half of a patch lands and the caller holds a policy
    // that is neither what they asked for nor what they had.
    const before = LoadLimits.defaults.maxObjects;
    expect(() => LoadLimits.defaults.with({ maxObjects: 10, maxFileBytes: -1 }))
      .toThrow(RangeError);
    expect(LoadLimits.defaults.maxObjects).toBe(before);
  });
});

describe('LoadLimits.enforce', () => {
  it('throws ResourceLimitError naming the field once reached passes allowed', () => {
    const l = LoadLimits.defaults.with({ maxObjects: 10 });
    expect(() => l.enforce('maxObjects', 10)).not.toThrow();
    let err: unknown;
    try { l.enforce('maxObjects', 11, 'classic xref'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ResourceLimitError);
    const r = err as ResourceLimitError;
    expect([r.limit, r.allowed, r.reached]).toEqual(['maxObjects', 10, 11]);
    expect(r.message).toContain('classic xref');
  });

  it('never throws for a disabled field', () => {
    expect(() => LoadLimits.unlimited().enforce('maxObjects', Number.MAX_SAFE_INTEGER)).not.toThrow();
  });
});

describe('ResourceLimitError', () => {
  it('is a sibling of PdfParseError, not a subclass', () => {
    // The decision ibzo.1 cannot revisit: "this file is too big" is
    // categorically not "this file is broken", so a caller branching on
    // PdfParseError to run the recovery ladder must NOT catch this.
    const e = new ResourceLimitError('maxObjects', 2_000_000, 10_000_000);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ResourceLimitError);
    expect(e).not.toBeInstanceOf(PdfParseError);
    expect(e.name).toBe('ResourceLimitError');
  });

  it('names the field, so a caller can raise it without parsing a message', () => {
    const e = new ResourceLimitError('maxObjects', 2_000_000, 10_000_000);
    expect(e.limit).toBe('maxObjects');
    expect(e.allowed).toBe(2_000_000);
    expect(e.reached).toBe(10_000_000);
    expect(e.message).toContain('maxObjects');
    expect(e.message).toContain('2000000');
    expect(e.message).toContain('10000000');
  });

  it('carries a detail when the numbers alone do not say what was refused', () => {
    const e = new ResourceLimitError('maxImagePixels', 1 << 28, 1 << 31, 'JBIG2 region');
    expect(e.message).toContain('JBIG2 region');
  });
});

describe('Document.loadLimits', () => {
  const pdf = () => Document.New(PageFormat.A4).Save();

  it('is the bounded defaults when a caller says nothing', () => {
    // Bounded by default is the posture; opting out has to be written down.
    expect(Document.Open(pdf()).loadLimits).toBe(LoadLimits.defaults);
  });

  it('reads back the policy the caller passed', () => {
    const limits = LoadLimits.defaults.with({ maxObjects: 10 });
    expect(Document.Open(pdf(), { limits }).loadLimits).toBe(limits);
  });

});
