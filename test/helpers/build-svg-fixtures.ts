import { deflateSync } from 'node:zlib';

const enc = (s: string) => new TextEncoder().encode(s);

type Obj = string | { dict: string; raw: Uint8Array };

/** Assemble a 1-page classic-xref PDF from a page dict body + content bytes +
 *  extra objects. `pageExtra` is spliced into the page dict (e.g. Rotate). */
export function buildSvgPdf(opts: {
  mediaBox?: number[];
  cropBox?: number[];
  rotate?: number;
  resources?: string;
  content: string | Uint8Array;
  extra?: Record<number, Obj>; // object number -> body (numbers >= 5)
}): Uint8Array {
  const mb = opts.mediaBox ?? [0, 0, 200, 200];
  const cb = opts.cropBox ? ` /CropBox [${opts.cropBox.join(' ')}]` : '';
  const rot = opts.rotate !== undefined ? ` /Rotate ${opts.rotate}` : '';
  const res = opts.resources ?? '<< >>';
  const contentRaw = typeof opts.content === 'string' ? enc(opts.content) : opts.content;

  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [${mb.join(' ')}]${cb}${rot} /Resources ${res} /Contents 4 0 R >>`;
  objs[4] = { dict: `<< /Length ${contentRaw.length} >>`, raw: contentRaw };
  if (opts.extra) for (const [k, v] of Object.entries(opts.extra)) objs[Number(k)] = v;
  const maxObj = objs.length - 1;

  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (u: Uint8Array) => { parts.push(u); length += u.length; };
  const offsets: number[] = new Array(maxObj + 1).fill(0);

  push(enc('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'));
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = length;
    const o = objs[n];
    if (o === undefined) continue;
    if (typeof o === 'string') push(enc(`${n} 0 obj\n${o}\nendobj\n`));
    else {
      push(enc(`${n} 0 obj\n${o.dict}\nstream\n`));
      push(o.raw);
      push(enc(`\nendstream\nendobj\n`));
    }
  }
  const xrefOff = length;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(enc(xref));
  push(enc(`trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`));

  const out = new Uint8Array(length);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Flate-compress helper for image/content stream builders. */
export function flate(bytes: Uint8Array | string): Uint8Array {
  const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return new Uint8Array(deflateSync(Buffer.from(b)));
}

/** A page drawing: a red even-odd filled rect, a blue stroked dashed line. */
export const VECTOR_CONTENT =
  '1 0 0 rg 20 20 60 60 re f* ' +           // red fill, even-odd
  '0 0 1 RG 4 w [6 3] 0 d 100 100 m 180 180 l S';

/** A page showing "Hi" in Helvetica-Bold at (72,100), size 24. */
export const TEXT_CONTENT = 'BT /F1 24 Tf 72 100 Td (Hi) Tj ET';
export const HELV_RESOURCES = '<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> >> >>';

/** Clip to a rectangle, then fill a larger rect that should be clipped. */
export const CLIP_CONTENT = '20 20 60 60 re W n 1 0 0 rg 0 0 200 200 re f';

/** A page drawing one 2x2 DeviceRGB Flate image (Im0) scaled to fill. */
export function flateImagePdf(): Uint8Array {
  const samples = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
  const raw = flate(samples);
  return buildSvgPdf({
    mediaBox: [0, 0, 100, 100],
    resources: '<< /XObject << /Im0 5 0 R >> >>',
    content: 'q 100 0 0 100 0 0 cm /Im0 Do Q',
    extra: { 5: { dict: `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${raw.length} >>`, raw } },
  });
}

/** A page with an axial (type 2) shading painted via the `sh` operator. */
export function axialShadingPdf(): Uint8Array {
  const res = '<< /Shading << /Sh0 5 0 R >> >>';
  const fn = '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>';
  const shading = `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 200 0] /Function ${fn} /Extend [true true] >>`;
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: res,
    content: 'q 0 0 200 200 re W n /Sh0 sh Q',
    extra: { 5: shading },
  });
}

/** A page with a radial (type 3) shading (red center → blue rim, no extend). */
export function radialShadingPdf(): Uint8Array {
  const res = '<< /Shading << /Sh0 5 0 R >> >>';
  const fn = '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>';
  const shading = `<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [100 100 0 100 100 80] /Function ${fn} /Extend [false false] >>`;
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: res,
    content: 'q 0 0 200 200 re W n /Sh0 sh Q',
    extra: { 5: shading },
  });
}

/** An axial shading clipped to the user-space rect [50 50 100 100]. */
export function axialShadingClippedPdf(): Uint8Array {
  const res = '<< /Shading << /Sh0 5 0 R >> >>';
  const fn = '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>';
  const shading = `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 200 0] /Function ${fn} /Extend [true true] >>`;
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: res,
    content: 'q 50 50 100 100 re W n /Sh0 sh Q',
    extra: { 5: shading },
  });
}

/** A shading of an unsupported type (6, a Coons patch mesh), clipped — should
 *  degrade to mid-gray. It was a /ShadingType 1 until 4gtd.3 implemented that
 *  type; a degrade fixture has to name a type nothing here draws. */
export function unsupportedShadingPdf(): Uint8Array {
  const res = '<< /Shading << /Sh0 5 0 R >> >>';
  const shading = `<< /ShadingType 6 /ColorSpace /DeviceRGB >>`;
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: res,
    content: 'q 50 50 100 100 re W n /Sh0 sh Q',
    extra: { 5: shading },
  });
}

/** A /ShadingType 1 missing the /Function that type REQUIRES — malformed rather
 *  than unimplemented, and it degrades by the same route. */
export function type1NoFunctionPdf(): Uint8Array {
  const res = '<< /Shading << /Sh0 5 0 R >> >>';
  const shading = `<< /ShadingType 1 /ColorSpace /DeviceRGB /Domain [0 1 0 1] >>`;
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: res,
    content: 'q 50 50 100 100 re W n /Sh0 sh Q',
    extra: { 5: shading },
  });
}

/** A function-based (type 1) shading over the whole page, its /Domain stated in
 *  user space so no /Matrix is involved. The field is R = x/200, G = y/200,
 *  B = 0 — it varies along BOTH axes, which is what lets a build that swapped
 *  the two domain coordinates be seen: an x-only ramp cannot tell them apart. */
export function type1ShadingPdf(): Uint8Array {
  // Stack in: x y. `200 div exch 200 div exch 0` leaves x/200 y/200 0, and the
  // topmost value is the LAST output — so R = x/200, G = y/200, B = 0.
  const prog = '{ 200 div exch 200 div exch 0 }';
  const res = '<< /Shading << /Sh0 5 0 R >> >>';
  const shading = '<< /ShadingType 1 /ColorSpace /DeviceRGB /Domain [0 200 0 200] '
    + '/Function 6 0 R >>';
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: res,
    content: 'q 0 0 200 200 re W n /Sh0 sh Q',
    extra: {
      5: shading,
      6: {
        dict: `<< /FunctionType 4 /Domain [0 200 0 200] /Range [0 1 0 1 0 1] /Length ${prog.length} >>`,
        raw: enc(prog),
      },
    },
  });
}

/**
 * A type 1 shading whose /Matrix is SINGULAR — it collapses the whole domain
 * onto a point, so the shading describes no field and cannot be inverted.
 *
 * A BLACK SQUARE IS DRAWN AFTER IT, and that is the point of the fixture rather
 * than decoration: `invert` throws on a singular matrix, and `renderCanvas`
 * catches everything around `interpret`, so the cost of letting the throw out
 * is every operator that follows on the page. A fixture whose shading is the
 * last thing drawn cannot see that half at all.
 */
export function type1SingularMatrixPdf(): Uint8Array {
  const prog = '{ 0 }';
  const res = '<< /Shading << /Sh0 5 0 R >> >>';
  const shading = '<< /ShadingType 1 /ColorSpace /DeviceRGB /Domain [0 1 0 1] '
    + '/Matrix [0 0 0 0 0 0] /Function 6 0 R >>';
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: res,
    content: 'q 50 50 100 100 re W n /Sh0 sh Q 0 0 0 rg 160 160 30 30 re f',
    extra: {
      5: shading,
      6: {
        dict: `<< /FunctionType 4 /Domain [0 1 0 1] /Range [0 1 0 1 0 1] /Length ${prog.length} >>`,
        raw: enc(prog),
      },
    },
  });
}

/** A type 1 shading whose unit /Domain reaches user space through a /Matrix
 *  that both SCALES and TRANSLATES — so a build that ignores the matrix, and
 *  one that applies it forward instead of inverted, each land outside the
 *  domain and paint nothing at all. */
export function type1MatrixShadingPdf(): Uint8Array {
  const prog = '{ 0 }';                       // stack in x y → out R=x, G=y, B=0
  const res = '<< /Shading << /Sh0 5 0 R >> >>';
  const shading = '<< /ShadingType 1 /ColorSpace /DeviceRGB /Domain [0 1 0 1] '
    + '/Matrix [100 0 0 100 50 50] /Function 6 0 R >>';
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: res,
    content: 'q 0 0 200 200 re W n /Sh0 sh Q',
    extra: {
      5: shading,
      6: {
        dict: `<< /FunctionType 4 /Domain [0 1 0 1] /Range [0 1 0 1 0 1] /Length ${prog.length} >>`,
        raw: enc(prog),
      },
    },
  });
}

/**
 * A type 1 shading whose /Domain covers only user 50..100 while the painted
 * area runs 50..150, so three quarters of it falls outside the domain — and a
 * /Background of pure BLUE, a colour neither the page (white), the degrade
 * (mid-gray) nor the function (whose blue channel is always 0) can produce.
 *
 * `as: 'pattern'` fills a rect through a PatternType 2; `as: 'sh'` paints the
 * same shading directly. The background must show in the first and NOT the
 * second (32000-1 8.7.4.3).
 */
export function type1BackgroundPdf(as: 'pattern' | 'sh'): Uint8Array {
  const prog = '{ 50 sub 50 div exch 50 sub 50 div exch 0 }';
  const shading = '<< /ShadingType 1 /ColorSpace /DeviceRGB /Domain [50 100 50 100] '
    + '/Background [0 0 1] /Function 6 0 R >>';
  const fnObj = {
    dict: `<< /FunctionType 4 /Domain [50 100 50 100] /Range [0 1 0 1 0 1] /Length ${prog.length} >>`,
    raw: enc(prog),
  };
  if (as === 'sh') {
    return buildSvgPdf({
      mediaBox: [0, 0, 200, 200],
      resources: '<< /Shading << /Sh0 5 0 R >> >>',
      content: 'q 50 50 100 100 re W n /Sh0 sh Q',
      extra: { 5: shading, 6: fnObj },
    });
  }
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /Pattern << /P0 5 0 R >> >>',
    content: '/Pattern cs /P0 scn 50 50 100 100 re f',
    extra: { 5: `<< /Type /Pattern /PatternType 2 /Shading ${shading} >>`, 6: fnObj },
  });
}

/** An AXIAL (type 2) shading carrying a /BBox — a COMMON shading entry, so the
 *  rule is shared rather than type 1's. The ramp extends in both directions and
 *  would otherwise cover the whole page; the /BBox confines it to user 50..150,
 *  so every probe outside that square is white if the entry is honoured and a
 *  saturated ramp colour if it is not. */
export function bboxShadingPdf(): Uint8Array {
  const fn = '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>';
  const res = '<< /Shading << /Sh0 5 0 R >> >>';
  const shading = `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 200 0] `
    + `/BBox [50 50 150 150] /Function ${fn} /Extend [true true] >>`;
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: res,
    content: 'q 0 0 200 200 re W n /Sh0 sh Q',
    extra: { 5: shading },
  });
}

/** A page whose TEXT is filled through a PatternType 2 (shading) pattern.
 *  The ramp is axial red→blue across the full page width, and the run of 90pt
 *  Helvetica 'H's spans it, so the first and last glyph sit on opposite ends of
 *  the ramp — which is what makes a flat fill distinguishable from a real one. */
export function patternTextPdf(): Uint8Array {
  const fn = '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>';
  const shading = `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 200 0] /Function ${fn} /Extend [true true] >>`;
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /Font << /F1 5 0 R >> /Pattern << /P0 6 0 R >> >>',
    content: 'BT /F1 90 Tf 2 70 Td /Pattern cs /P0 scn (HHH) Tj ET',
    extra: {
      5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      6: `<< /Type /Pattern /PatternType 2 /Shading ${shading} >>`,
    },
  });
}

/** A page filling a rect through a PatternType 2 (shading) pattern via scn.
 *  The shading is axial red→blue across user x 50..150; the fill rect is [50 50 100 100]. */
export function shadingPatternPdf(): Uint8Array {
  const fn = '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>';
  const shading = `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [50 0 150 0] /Function ${fn} /Extend [true true] >>`;
  const pattern = `<< /Type /Pattern /PatternType 2 /Shading ${shading} /Matrix [1 0 0 1 0 0] >>`;
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /Pattern << /P0 5 0 R >> >>',
    content: '/Pattern cs /P0 scn 50 50 100 100 re f',
    extra: { 5: pattern },
  });
}

/** A page invoking a Form XObject that fills a green rect. */
export function formXObjectPdf(): Uint8Array {
  const formContent = flate('0 1 0 rg 0 0 50 50 re f');
  const form = { dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] /Matrix [1 0 0 1 10 10] /Resources << >> /Filter /FlateDecode /Length ${formContent.length} >>`, raw: formContent };
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /XObject << /Fm0 5 0 R >> >>',
    content: 'q /Fm0 Do Q',
    extra: { 5: form },
  });
}

/** A page drawing a DCTDecode (JPEG) image. */
export function jpegImagePdf(): Uint8Array {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  return buildSvgPdf({
    mediaBox: [0, 0, 100, 100],
    resources: '<< /XObject << /Jp 5 0 R >> >>',
    content: 'q 100 0 0 100 0 0 cm /Jp Do Q',
    extra: { 5: { dict: `<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, raw: jpeg } },
  });
}

/** An axial shading whose colour comes from a type 4 PostScript function:
 *  R = t, G = 0, B = 1 - t. Deliberately the same visual ramp as
 *  `axialShadingPdf`, so a flat mid-grey result means the program did not run. */
export function type4ShadingPdf(): Uint8Array {
  const prog = '{ dup 0 exch 1 exch sub }';
  const res = '<< /Shading << /Sh0 5 0 R >> >>';
  const shading = '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 200 0] '
    + '/Function 6 0 R /Extend [true true] >>';
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: res,
    content: 'q 0 0 200 200 re W n /Sh0 sh Q',
    extra: {
      5: shading,
      6: {
        dict: `<< /FunctionType 4 /Domain [0 1] /Range [0 1 0 1 0 1] /Length ${prog.length} >>`,
        raw: enc(prog),
      },
    },
  });
}

/** A rect filled through a /Separation whose tint transform is a type 4
 *  program: R = 1 - t, G = 1, B = 1 - t, so tint 1 is pure green. */
export function type4SeparationPdf(): Uint8Array {
  const prog = '{ 1 exch sub dup 1 exch }';
  const res = '<< /ColorSpace << /CS0 5 0 R >> >>';
  const cs = '[/Separation /Spot /DeviceRGB 6 0 R]';
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: res,
    content: 'q /CS0 cs 1 scn 20 20 160 160 re f Q',
    extra: {
      5: cs,
      6: {
        dict: `<< /FunctionType 4 /Domain [0 1] /Range [0 1 0 1 0 1] /Length ${prog.length} >>`,
        raw: enc(prog),
      },
    },
  });
}
