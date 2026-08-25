import { buildSvgPdf, flate } from './build-svg-fixtures.js';

/** 200×200 page: an opaque red 100×100 square drawn at ca 0.5 over white.
 *  Expected composite over the white background: (255, 128, 128). */
export function constantAlphaPdf(): Uint8Array {
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /ExtGState << /GS0 << /Type /ExtGState /ca 0.5 /CA 0.5 >> >> >>',
    content: 'q /GS0 gs 1 0 0 rg 50 50 100 100 re f Q',
  });
}

/** 200×200 page. A luminosity soft mask whose group paints white over the left
 *  half (user x 0..100) and black over the right half, then a red 200×200 fill
 *  through it. White luminance = 1 → fully painted; black = 0 → fully masked.
 *  Expected: left half red (255,0,0), right half untouched white. */
export function luminositySoftMaskPdf(): Uint8Array {
  const groupContent = flate('1 g 0 0 100 200 re f 0 g 100 0 100 200 re f');
  const group = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] `
      + `/Group << /S /Transparency /CS /DeviceGray >> `
      + `/Filter /FlateDecode /Length ${groupContent.length} >>`,
    raw: groupContent,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /ExtGState << /GS0 << /Type /ExtGState /SMask << /S /Luminosity /G 5 0 R >> >> >> >>',
    content: 'q /GS0 gs 1 0 0 rg 0 0 200 200 re f Q',
    extra: { 5: group },
  });
}

/** 200×200 page: two overlapping opaque red squares inside a transparency
 *  group, drawn at ca 0.5 over white. `iso` selects the /I value; 'absent'
 *  omits the key entirely, which is the spec default (false) and the shape of
 *  an ordinary /Group form.
 *
 *  The group has no inner blend mode, so isolated and non-isolated agree:
 *    - correct (offscreen): overlap == non-overlap == (255, 128, 128)
 *    - broken  (inline):    the overlap composites twice → (255, 64, 64)
 */
export function nonIsolatedGroupPdf(
  iso: 'true' | 'false' | 'absent' = 'absent',
): Uint8Array {
  const inner = flate('1 0 0 rg 20 20 80 80 re f 60 60 80 80 re f');
  const i = iso === 'absent' ? '' : `/I ${iso} `;
  const form = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] `
      + `/Group << /S /Transparency ${i}/CS /DeviceRGB >> `
      + `/Resources << >> /Filter /FlateDecode /Length ${inner.length} >>`,
    raw: inner,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /XObject << /Fm0 5 0 R >> /ExtGState << /GS0 << /ca 0.5 >> >> >>',
    content: 'q /GS0 gs /Fm0 Do Q',
    extra: { 5: form },
  });
}

/** 100×100 page filled with a 20×20 tiling pattern whose cell paints a blue
 *  10×10 square at the cell origin. User (5,5) lands inside a blue square;
 *  user (15,15) lands in the gap. */
export function tilingPatternPdf(): Uint8Array {
  const cell = flate('0 0 1 rg 0 0 10 10 re f');
  const pattern = {
    dict: `<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 `
      + `/BBox [0 0 20 20] /XStep 20 /YStep 20 /Resources << >> `
      + `/Filter /FlateDecode /Length ${cell.length} >>`,
    raw: cell,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 100, 100],
    resources: '<< /Pattern << /P0 5 0 R >> >>',
    content: '/Pattern cs /P0 scn 0 0 100 100 re f',
    extra: { 5: pattern },
  });
}

/** 200×200 page: an isolated transparency group containing two overlapping
 *  opaque red squares, drawn at ca 0.5 over white.
 *    - correct (offscreen): overlap == non-overlap == (255, 128, 128)
 *    - broken  (inline):    the overlap composites twice → (255, 64, 64) */
export function isolatedGroupPdf(): Uint8Array {
  const inner = flate('1 0 0 rg 20 20 80 80 re f 60 60 80 80 re f');
  const form = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] `
      + `/Group << /S /Transparency /I true /CS /DeviceRGB >> `
      + `/Resources << >> /Filter /FlateDecode /Length ${inner.length} >>`,
    raw: inner,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /XObject << /Fm0 5 0 R >> /ExtGState << /GS0 << /ca 0.5 >> >> >>',
    content: 'q /GS0 gs /Fm0 Do Q',
    extra: { 5: form },
  });
}

/** 100×100 page with two NESTED clips whose intersection is a proper subset of
 *  each — an enclosing left band (user x 0..60) and an inner bottom band
 *  (user y 0..60), so a red full-page fill survives only in the bottom-left
 *  60×60 corner. The leaf carries the inner clip, which is chained onto the
 *  enclosing one so the two intersect.
 *
 *  A concentric inner⊂outer nesting cannot test the chaining: the intersection
 *  equals the inner clip, so dropping the chain changes no pixel. Here the
 *  discriminating region is inner-minus-enclosing (user x 60..100, y 0..60):
 *    - correct (chained): the paint is intersected with the enclosing clip and
 *      this region is unpainted (white).
 *    - broken (leaf clipped to the inner band only): it paints red.
 *  Both gaps are between saturated red and white, so antialiasing cannot blur
 *  one into the other. */
export function nestedClipPdf(): Uint8Array {
  return buildSvgPdf({
    mediaBox: [0, 0, 100, 100],
    content: 'q 0 0 60 100 re W n q 0 0 100 60 re W n '
      + '1 0 0 rg 0 0 100 100 re f Q Q',
  });
}

/** 100×100 page: a 50% gray backdrop, then an opaque pure-red square over it
 *  through blend mode `mode`. Both fills are opaque, so a probe inside the
 *  square reads the blend function's output directly. */
export function blendModePdf(mode: string): Uint8Array {
  return buildSvgPdf({
    mediaBox: [0, 0, 100, 100],
    resources: `<< /ExtGState << /GS0 << /Type /ExtGState /BM /${mode} >> >> >>`,
    content: '0.5 g 0 0 100 100 re f q /GS0 gs 1 0 0 rg 20 20 60 60 re f Q',
  });
}

/** The same 20×20 blue-cell pattern, but filling only a clip rectangle at user
 *  (40..80)² — away from the origin, and with the pattern cell at (0,0) lying
 *  outside the filled region. Guards the offscreen placement rules: a buffer
 *  anchored off-origin, a cell outside the region it fills, contents that must
 *  render unclipped, and a lattice walk that must step toward the target under
 *  the y-flip. A full-page fill satisfies all four accidentally. */
export function tilingPatternOffsetClipPdf(): Uint8Array {
  const cell = flate('0 0 1 rg 0 0 10 10 re f');
  const pattern = {
    dict: `<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 `
      + `/BBox [0 0 20 20] /XStep 20 /YStep 20 /Resources << >> `
      + `/Filter /FlateDecode /Length ${cell.length} >>`,
    raw: cell,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 100, 100],
    resources: '<< /Pattern << /P0 5 0 R >> >>',
    content: '/Pattern cs /P0 scn 40 40 40 40 re f',
    extra: { 5: pattern },
  });
}

/** 100×100 page: a 20-unit-wide stroked horizontal line at user y=50, painted
 *  through a solid-blue tiling pattern. The stroke band spans user y 40..60. */
export function strokePatternPdf(): Uint8Array {
  const cell = flate('0 0 1 rg 0 0 10 10 re f');
  const pattern = {
    dict: `<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 `
      + `/BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >> `
      + `/Filter /FlateDecode /Length ${cell.length} >>`,
    raw: cell,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 100, 100],
    resources: '<< /Pattern << /P0 5 0 R >> >>',
    content: '/Pattern CS /P0 SCN 20 w 0 50 m 100 50 l S',
    extra: { 5: pattern },
  });
}

/** 200×200 page: a yellow backdrop, then an ISOLATED transparency group at
 *  ca 1.0 whose contents Multiply a cyan square over it.
 *
 *  Isolated, the blend sees the group's transparent backdrop and is a no-op, so
 *  the group composites Normal onto the page and the square reads pure cyan
 *  (0,255,255). Drawn non-isolated — or inline, which is what an unbuffered
 *  group amounts to — the multiply sees the yellow page instead:
 *  cyan × yellow = (0,255,0). The two answers differ in a saturated channel, so
 *  antialiasing cannot blur one into the other.
 *
 *  `isolated` is a parameter so the tests can assert the fixture discriminates
 *  rather than passing for an unrelated reason. */
/** 200×200 page: a yellow backdrop, then a transparency group at ca 0.5 whose
 *  contents Multiply TWO OVERLAPPING cyan squares over it.
 *
 *  The overlap is load-bearing. With a single square, unit compositing and
 *  inline drawing produce the same pixel, and the fixture would not
 *  discriminate — the group alpha would apply once either way.
 *
 *  At the overlap the three candidate answers are pairwise distinct:
 *    - correct non-isolated (seed + remove): (128, 255,   0)
 *    - inline (the pre-bbu bug):             ( 64, 255,   0)
 *    - isolated:                             (128, 255, 128)
 *  Red separates correct from inline; blue separates non-isolated from
 *  isolated. Both gaps are saturated, so antialiasing cannot blur them. */
export function nonIsolatedBlendGroupPdf(isolated = false): Uint8Array {
  const inner = flate('q /GSM gs 0 1 1 rg 40 40 80 80 re f 80 80 80 80 re f Q');
  const form = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] `
      + `/Group << /S /Transparency /I ${isolated} /CS /DeviceRGB >> `
      + `/Resources << /ExtGState << /GSM << /Type /ExtGState /BM /Multiply >> >> >> `
      + `/Filter /FlateDecode /Length ${inner.length} >>`,
    raw: inner,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /XObject << /Fm0 5 0 R >> /ExtGState << /GS0 << /ca 0.5 >> >> >>',
    content: '1 1 0 rg 0 0 200 200 re f q /GS0 gs /Fm0 Do Q',
    extra: { 5: form },
  });
}

/** 200×200 page: a yellow backdrop, then a NON-isolated transparency group at
 *  ca 0.5 whose single inner cyan square is drawn Multiply at ca 0.5.
 *
 *  This is the discriminator the flat-opaque `nonIsolatedBlendGroupPdf` cannot
 *  be: there the interior has αgn = 1 and α0 = 1, so the §11.4.6 removal term
 *  k = α0/αgn − α0 is identically 0 and forcing k = 0 changes nothing. Here the
 *  inner square draws at ca 0.5, so αgn = 0.5 in the interior while the yellow
 *  page keeps α0 = 1, giving k = 1/0.5 − 1 = 1 — a removal that actually does
 *  arithmetic. At the flat interior:
 *    - correct (seed + remove): (191, 255, 0)
 *    - k = 0 mutation (no removal): (223, 255, 0)
 *  The 32-count gap in red is exact-match discriminable, so a broken removal
 *  term is caught rather than blurred away. Derivation: the buffer holds the
 *  seeded-and-multiplied color (0.5, 1, 0); removal maps its red toward the
 *  page's (0.5 + (0.5 − 1)·1 = 0), then it composites at αgn·ca = 0.25 over
 *  yellow → 0.75·1 + 0.25·0 = 0.75 red. Skipping removal keeps red 0.5 → 0.875. */
export function fractionalAlphaRemovalGroupPdf(isolated = false): Uint8Array {
  const inner = flate('q /GSM gs 0 1 1 rg 50 50 100 100 re f Q');
  const form = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] `
      + `/Group << /S /Transparency /I ${isolated} /CS /DeviceRGB >> `
      + `/Resources << /ExtGState << /GSM << /Type /ExtGState /BM /Multiply /ca 0.5 >> >> >> `
      + `/Filter /FlateDecode /Length ${inner.length} >>`,
    raw: inner,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /XObject << /Fm0 5 0 R >> /ExtGState << /GS0 << /ca 0.5 >> >> >>',
    content: '1 1 0 rg 0 0 200 200 re f q /GS0 gs /Fm0 Do Q',
    extra: { 5: form },
  });
}

/** 200×200 white page: an isolated transparency group (/I true) with two
 *  overlapping semi-transparent squares — red (40..120)² then blue (80..160)²,
 *  each drawn at inner ca 0.5. `knockout` sets /K.
 *
 *  Knockout composites each element against the group's initial (transparent)
 *  backdrop, so in the overlap blue replaces red: (128,128,255). Without
 *  knockout blue composites over red: (128,64,191). Both gaps are in saturated
 *  channels. The elements MUST be semi-transparent — opaque squares read the
 *  topmost either way and would not discriminate knockout. */
export function knockoutIsolatedPdf(knockout: boolean): Uint8Array {
  const inner = flate(
    'q /GS1 gs 1 0 0 rg 40 40 80 80 re f Q '
    + 'q /GS1 gs 0 0 1 rg 80 80 80 80 re f Q');
  const form = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] `
      + `/Group << /S /Transparency /I true /K ${knockout} /CS /DeviceRGB >> `
      + `/Resources << /ExtGState << /GS1 << /ca 0.5 >> >> >> `
      + `/Filter /FlateDecode /Length ${inner.length} >>`,
    raw: inner,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /XObject << /Fm0 5 0 R >> >>',
    content: '/Fm0 Do',
    extra: { 5: form },
  });
}

/** 200×200 yellow page: a NON-isolated transparency group (/I false) with two
 *  overlapping semi-transparent squares — red (40..120)² then blue (80..160)²,
 *  each at inner ca 0.5, Normal. `knockout` sets /K.
 *
 *  Non-isolated → each element composites against the page (B0 = yellow). With
 *  knockout, blue replaces red in the overlap and the §11.4.6 removal subtracts
 *  the seed, giving (128,128,128); without it blue composites over red over
 *  yellow → (128,64,128). Exercises knockout accumulation feeding the removal
 *  path — and needsBackdrop for non-isolated knockout WITHOUT an inner blend. */
export function knockoutNonIsolatedPdf(knockout: boolean): Uint8Array {
  const inner = flate(
    'q /GS1 gs 1 0 0 rg 40 40 80 80 re f Q '
    + 'q /GS1 gs 0 0 1 rg 80 80 80 80 re f Q');
  const form = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] `
      + `/Group << /S /Transparency /I false /K ${knockout} /CS /DeviceRGB >> `
      + `/Resources << /ExtGState << /GS1 << /ca 0.5 >> >> >> `
      + `/Filter /FlateDecode /Length ${inner.length} >>`,
    raw: inner,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /XObject << /Fm0 5 0 R >> >>',
    content: '1 1 0 rg 0 0 200 200 re f /Fm0 Do',
    extra: { 5: form },
  });
}

export function isolatedBlendGroupPdf(isolated = true): Uint8Array {
  const inner = flate('q /GSM gs 0 1 1 rg 50 50 100 100 re f Q');
  const form = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] `
      + `/Group << /S /Transparency /I ${isolated} /CS /DeviceRGB >> `
      + `/Resources << /ExtGState << /GSM << /Type /ExtGState /BM /Multiply >> >> >> `
      + `/Filter /FlateDecode /Length ${inner.length} >>`,
    raw: inner,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /XObject << /Fm0 5 0 R >> >>',
    content: '1 1 0 rg 0 0 200 200 re f /Fm0 Do',
    extra: { 5: form },
  });
}
