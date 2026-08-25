import { deflateSync } from 'node:zlib';
import { encodeJpeg } from '../../src/jpegencode.js';

const enc = (s: string) => new TextEncoder().encode(s);

type Obj = string | { dict: string; raw: Uint8Array };

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Assemble numbered objects into a classic-xref PDF. Object 1 must be /Catalog. */
export function assemble(objs: Obj[]): Uint8Array {
  const parts: Uint8Array[] = [enc('%PDF-1.7\n')];
  const offsets: number[] = [];
  let pos = parts[0].length;
  for (let i = 1; i < objs.length; i++) {
    const o = objs[i];
    offsets[i] = pos;
    if (typeof o === 'string') {
      const b = enc(`${i} 0 obj\n${o}\nendobj\n`);
      parts.push(b); pos += b.length;
    } else {
      const head = enc(`${i} 0 obj\n${o.dict}\nstream\n`);
      const tail = enc('\nendstream\nendobj\n');
      parts.push(head, o.raw, tail);
      pos += head.length + o.raw.length + tail.length;
    }
  }
  const xref = pos;
  let x = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  x += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  parts.push(enc(x));
  return concat(parts);
}

/** A content stream object from its literal text. */
export const contentStream = (body: string): Obj => ({
  dict: `<< /Length ${enc(body).length} >>`,
  raw: enc(body),
});

/**
 * A 200x200 page carrying colour in five places at once:
 *   - page content: `1 0 0 rg` and a named DeviceRGB space via `/CS0 cs`
 *   - a Form XObject: `0 0 1 rg`
 *   - a tiling pattern: `0 1 0 rg`
 *   - a Type 3 glyph procedure: `1 1 0 rg`
 *   - an annotation /AP stream: `0 1 1 rg`
 * Every one of them must come back grey.
 */
export function buildGrayscalePdf(): Uint8Array {
  const content =
    '1 0 0 rg 0 0 50 50 re f\n'
    + '/CS0 cs 0 0 1 sc 50 0 50 50 re f\n'
    + '/Fm0 Do\n'
    + '/Pattern cs /P0 scn 0 100 50 50 re f\n'
    + 'BT /T3 12 Tf 10 150 Td (a) Tj ET\n';
  const form = '0 0 1 rg 0 0 50 50 re f';
  const tile = '0 1 0 rg 0 0 10 10 re f';
  const proc = '1000 0 0 0 12 12 d1 1 1 0 rg 0 0 12 12 re f';
  const ap = '0 1 1 rg 0 0 50 50 re f';

  return assemble([
    '',                                                            // 0 (free)
    '<< /Type /Catalog /Pages 2 0 R >>',                           // 1
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',                   // 2
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '        // 3
      + '/Resources << /ColorSpace << /CS0 /DeviceRGB >> '
      + '/XObject << /Fm0 5 0 R >> /Pattern << /P0 6 0 R >> '
      + '/Font << /T3 7 0 R >> >> '
      + '/Contents 4 0 R /Annots [10 0 R] >>',
    contentStream(content),                                        // 4
    { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] '  // 5
        + `/Length ${enc(form).length} >>`, raw: enc(form) },
    { dict: '<< /Type /Pattern /PatternType 1 /PaintType 1 '       // 6
        + '/TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 '
        + '/Resources << >> '
        + `/Length ${enc(tile).length} >>`, raw: enc(tile) },
    '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 12 12] '        // 7
      + '/FontMatrix [0.001 0 0 0.001 0 0] /CharProcs 8 0 R '
      + '/Encoding << /Type /Encoding /Differences [97 /a] >> '
      + '/FirstChar 97 /LastChar 97 /Widths [1000] /Resources << >> >>',
    '<< /a 9 0 R >>',                                              // 8
    { dict: `<< /Length ${enc(proc).length} >>`, raw: enc(proc) }, // 9
    '<< /Type /Annot /Subtype /Square /Rect [100 100 150 150] '    // 10
      + '/F 4 /C [1 0 0] /IC [0 0 1] /AP << /N 11 0 R >> >>',
    { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] '  // 11
        + `/Length ${enc(ap).length} >>`, raw: enc(ap) },
  ]);
}

/** A page drawing one RGB Flate image and one RGB JPEG image. */
export function buildGrayscaleImagePdf(): Uint8Array {
  const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  const flate = new Uint8Array(deflateSync(rgb));
  const jw = 8, jh = 8;
  const jrgb = new Uint8Array(jw * jh * 3);
  for (let i = 0; i < jw * jh; i++) jrgb[i * 3] = 255;
  const jpeg = encodeJpeg(jw, jh, jrgb, 'rgb', { quality: 90 });
  const content = 'q 50 0 0 50 0 0 cm /Im0 Do Q q 50 0 0 50 60 0 cm /Im1 Do Q';

  return assemble([
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
      + '/Resources << /XObject << /Im0 5 0 R /Im1 6 0 R >> >> /Contents 4 0 R >>',
    contentStream(content),
    { dict: '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 '
        + '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode '
        + `/Length ${flate.length} >>`, raw: flate },
    { dict: `<< /Type /XObject /Subtype /Image /Width ${jw} /Height ${jh} `
        + '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode '
        + `/Length ${jpeg.length} >>`, raw: jpeg },
  ]);
}

/** A page painting an axial shading via `sh` and a shading pattern via scn. */
export function buildGrayscaleShadingPdf(): Uint8Array {
  const content = 'q 0 0 100 100 re W n /Sh0 sh Q '
    + 'q /Pattern cs /P1 scn 100 0 100 100 re f Q';
  const fn = '<< /FunctionType 2 /Domain [0 1] /N 1 /C0 [1 0 0] /C1 [0 0 1] >>';
  return assemble([
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
      + '/Resources << /Shading << /Sh0 5 0 R >> /Pattern << /P1 6 0 R >> >> '
      + '/Contents 4 0 R >>',
    contentStream(content),
    `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] /Function ${fn} >>`,
    '<< /PatternType 2 /Shading << /ShadingType 3 /ColorSpace /DeviceRGB '
      + `/Coords [50 50 0 50 50 40] /Function ${fn} >> >>`,
  ]);
}

/** A coloured page whose /AcroForm carries a signature field. Converting it
 *  would invalidate the signature, so ConvertToGrayscale must refuse. */
export function buildSignedGrayscalePdf(): Uint8Array {
  const content = '1 0 0 rg 0 0 50 50 re f';
  return assemble([
    '',
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
      + '/Resources << >> /Contents 4 0 R >>',
    contentStream(content),
    '<< /FT /Sig /T (sig1) /V << /Type /Sig >> >>',
  ]);
}

/**
 * One 200x200 page carrying colour in every place this feature converts, each
 * in its own 40x40 cell so a failing pixel names the construct that leaked:
 *
 *   (0,0)     page content, `1 0 0 rg`          -> 0.299 -> 76
 *   (40,0)    named space, `/CS0 cs 0 0 1 sc`   -> 0.114 -> 29
 *   (80,0)    Form XObject, `0 0 1 rg`          -> 0.114 -> 29
 *   (120,0)   annotation /AP, `0 1 1 rg`        -> 0.701 -> 179
 *   (0,40)    tiling pattern, `0 1 0 rg`        -> 0.587 -> 150
 *   (40,40)   shading pattern (axial red->blue)
 *   (0,80)    `sh` shading (axial red->blue)
 *   (80,80)   Flate RGB image
 *   (120,80)  DCT RGB image
 *   (160,80)  unfiltered inline image
 *   (0,160)   Type 3 glyph, `1 1 0 rg`          -> 0.886 -> 226
 *
 * Every colour has a luma strictly between 0 and 1, so a bug that paints
 * everything black or white cannot pass.
 */
export function buildEverythingColorPdf(): Uint8Array {
  const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  const flate = new Uint8Array(deflateSync(rgb));
  const jw = 8, jh = 8;
  const jrgb = new Uint8Array(jw * jh * 3);
  for (let i = 0; i < jw * jh; i++) { jrgb[i * 3] = 255; jrgb[i * 3 + 2] = 128; }
  const jpeg = encodeJpeg(jw, jh, jrgb, 'rgb', { quality: 90 });

  // Inline-image samples, all < 128 so the content stream stays byte-for-byte
  // what TextEncoder emits, and containing no `EI` sequence to end it early.
  const inline = [120, 20, 60, 120, 20, 60, 120, 20, 60, 120, 20, 60];
  const inlineBytes = inline.map((b) => String.fromCharCode(b)).join('');

  const fn = '<< /FunctionType 2 /Domain [0 1] /N 1 /C0 [1 0 0] /C1 [0 0 1] >>';
  const content =
    '1 0 0 rg 0 0 40 40 re f\n'
    + '/CS0 cs 0 0 1 sc 40 0 40 40 re f\n'
    + 'q 1 0 0 1 80 0 cm /Fm0 Do Q\n'
    + '/Pattern cs /P0 scn 0 40 40 40 re f\n'
    + '/Pattern cs /P1 scn 40 40 40 40 re f\n'
    + 'q 0 80 40 40 re W n /Sh0 sh Q\n'
    + 'q 40 0 0 40 80 80 cm /Im0 Do Q\n'
    + 'q 40 0 0 40 120 80 cm /Im1 Do Q\n'
    + `q 40 0 0 40 160 80 cm BI /W 2 /H 2 /CS /RGB /BPC 8 ID ${inlineBytes} EI Q\n`
    + 'BT /T3 40 Tf 0 160 Td (a) Tj ET\n';

  const form = '0 0 1 rg 0 0 40 40 re f';
  const tile = '0 1 0 rg 0 0 10 10 re f';
  const proc = '1000 0 d0 1 1 0 rg 0 0 1000 1000 re f';
  const ap = '0 1 1 rg 0 0 40 40 re f';

  return assemble([
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',                            // 1
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',                    // 2
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '         // 3
      + '/Resources << /ColorSpace << /CS0 /DeviceRGB >> '
      + '/XObject << /Fm0 5 0 R /Im0 12 0 R /Im1 13 0 R >> '
      + '/Pattern << /P0 6 0 R /P1 15 0 R >> '
      + '/Shading << /Sh0 14 0 R >> '
      + '/Font << /T3 7 0 R >> >> '
      + '/Contents 4 0 R /Annots [10 0 R] >>',
    contentStream(content),                                         // 4
    { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 40 40] '   // 5
        + `/Length ${enc(form).length} >>`, raw: enc(form) },
    { dict: '<< /Type /Pattern /PatternType 1 /PaintType 1 '        // 6
        + '/TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 '
        + `/Resources << >> /Length ${enc(tile).length} >>`, raw: enc(tile) },
    '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] '     // 7
      + '/FontMatrix [0.001 0 0 0.001 0 0] /CharProcs 8 0 R '
      + '/Encoding << /Type /Encoding /Differences [97 /a] >> '
      + '/FirstChar 97 /LastChar 97 /Widths [1000] /Resources << >> >>',
    '<< /a 9 0 R >>',                                               // 8
    { dict: `<< /Length ${enc(proc).length} >>`, raw: enc(proc) },   // 9
    '<< /Type /Annot /Subtype /Square /Rect [120 0 160 40] '         // 10
      + '/F 4 /C [1 0 0] /IC [0 0 1] /AP << /N 11 0 R >> >>',
    { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 40 40] '   // 11
        + `/Length ${enc(ap).length} >>`, raw: enc(ap) },
    { dict: '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 ' // 12
        + '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode '
        + `/Length ${flate.length} >>`, raw: flate },
    { dict: `<< /Type /XObject /Subtype /Image /Width ${jw} /Height ${jh} ` // 13
        + '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode '
        + `/Length ${jpeg.length} >>`, raw: jpeg },
    '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 80 40 80] '  // 14
      + `/Extend [true true] /Function ${fn} >>`,
    '<< /PatternType 2 /Shading << /ShadingType 2 '                  // 15
      + '/ColorSpace /DeviceRGB /Coords [40 40 80 40] /Extend [true true] '
      + `/Function ${fn} >> >>`,
  ]);
}

/** The same page with every colour already stated in DeviceGray. Converting it
 *  must change nothing at all -- the byte-identity fence. */
export function buildAlreadyGrayPdf(): Uint8Array {
  return assemble([
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
      + '/Resources << >> /Contents 4 0 R >>',
    contentStream('0.3 g 0 0 50 50 re f 0.7 G 1 w 10 10 m 40 40 l S'),
  ]);
}

/**
 * A page whose only paint is a type 4 (free-form triangle) mesh shading with no
 * /Function -- the one shading shape whose colour lives in the stream data.
 *
 * One triangle, its three corners red, green and blue, so each vertex greys to
 * a different value and a splice that dropped or duplicated a component shows
 * up as the wrong byte rather than as a plausible ramp. The coordinates are
 * deliberately not round (0x8000, 0xffff): they must survive bit for bit.
 */
export function buildGrayscaleMeshPdf(): Uint8Array {
  const data = new Uint8Array([
    0, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00,   // red
    0, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00,   // green
    0, 0x80, 0x00, 0xff, 0xff, 0x00, 0x00, 0xff,   // blue
  ]);
  return assemble([
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
      + '/Resources << /Shading << /Sh0 5 0 R >> >> /Contents 4 0 R >>',
    contentStream('q 0 0 200 200 re W n /Sh0 sh Q'),
    {
      dict: '<< /ShadingType 4 /ColorSpace /DeviceRGB /BitsPerCoordinate 16 '
        + '/BitsPerComponent 8 /BitsPerFlag 8 '
        + `/Decode [0 200 0 200 0 1 0 1 0 1] /Length ${data.length} >>`,
      raw: data,
    },
  ]);
}

/**
 * A page drawing one RGB image whose transparency is a colour-key `/Mask`.
 *
 * Two of its four pixels grey to the SAME value, 76 — (255,0,0) at 0.299*255
 * and (0,130,0) at 0.587*130 — and only the first is keyed. That is the whole
 * point: after conversion the samples cannot distinguish them, so a mask
 * re-derived as a grey range would have to cover both.
 */
export function buildColorKeyMaskPdf(): Uint8Array {
  const rgb = new Uint8Array([
    255, 0, 0,      // keyed
    0, 130, 0,      // same luma, not keyed
    0, 0, 255,
    255, 255, 255,
  ]);
  const flate = new Uint8Array(deflateSync(rgb));
  return assemble([
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
      + '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    contentStream('q 100 0 0 100 0 0 cm /Im0 Do Q'),
    { dict: '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 '
        + '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode '
        + `/Mask [250 255 0 5 0 5] /Length ${flate.length} >>`, raw: flate },
  ]);
}
