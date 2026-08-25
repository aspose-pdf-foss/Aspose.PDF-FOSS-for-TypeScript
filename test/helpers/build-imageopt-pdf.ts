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

/** Assemble numbered objects into a classic-xref one-page PDF. */
function assemble(objs: Obj[]): Uint8Array {
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

/** A deterministic gradient — compresses like a photo, not a flat fill. */
export function gradient(w: number, h: number, channels = 3): Uint8Array {
  const out = new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let c = 0; c < channels; c++) {
      out[(y * w + x) * channels + c] = (x * 7 + y * 5 + c * 31) % 256;
    }
  }
  return out;
}

const imageDict = (w: number, h: number, cs: string, len: number, extra = '') =>
  `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /${cs} `
  + `/BitsPerComponent 8 /Filter /DCTDecode ${extra}/Length ${len} >>`;

/** A 64x64 DCTDecode RGB image drawn on a 200x200 page inside a `boxW x boxH`
 *  box. At the default 16x16 box that is 64*72/16 = 288 DPI. */
export function buildSimpleImagePdf(
  opts: { boxW?: number; boxH?: number; imgW?: number; imgH?: number } = {},
): { bytes: Uint8Array; imgObjNum: number } {
  const { boxW = 16, boxH = 16, imgW = 64, imgH = 64 } = opts;
  const jpeg = encodeJpeg(imgW, imgH, gradient(imgW, imgH), 'rgb', { quality: 90 });
  const content = enc(`q ${boxW} 0 0 ${boxH} 10 10 cm /Im0 Do Q`);
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: imageDict(imgW, imgH, 'DeviceRGB', jpeg.length), raw: jpeg };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  return { bytes: assemble(objs), imgObjNum: 4 };
}

/** One image drawn twice at different scales: a 16pt box (288 DPI) and a 64pt
 *  box (72 DPI). The max rule must pick 288. */
export function buildTwoPlacementPdf(): { bytes: Uint8Array; imgObjNum: number } {
  const jpeg = encodeJpeg(64, 64, gradient(64, 64), 'rgb', { quality: 90 });
  const content = enc('q 16 0 0 16 10 10 cm /Im0 Do Q q 64 0 0 64 100 100 cm /Im0 Do Q');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: imageDict(64, 64, 'DeviceRGB', jpeg.length), raw: jpeg };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  return { bytes: assemble(objs), imgObjNum: 4 };
}

/** An image drawn only from inside a Form XObject that carries its own /Matrix
 *  (scale 2), nested under a `cm` of 8 -> effective box 16pt -> 288 DPI. */
export function buildFormImagePdf(): { bytes: Uint8Array; imgObjNum: number } {
  const jpeg = encodeJpeg(64, 64, gradient(64, 64), 'rgb', { quality: 90 });
  const form = enc('/Im0 Do');
  const content = enc('q 8 0 0 8 10 10 cm /Fm0 Do Q');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm0 6 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: imageDict(64, 64, 'DeviceRGB', jpeg.length), raw: jpeg };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  objs[6] = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Matrix [2 0 0 2 0 0] /Resources << /XObject << /Im0 4 0 R >> >> /Length ${form.length} >>`,
    raw: form,
  };
  return { bytes: assemble(objs), imgObjNum: 4 };
}

/** An image drawn only from an annotation /AP /N stream whose /BBox [0 0 1 1]
 *  maps into /Rect [0 0 16 16] -> 288 DPI. */
export function buildAnnotImagePdf(): { bytes: Uint8Array; imgObjNum: number } {
  const jpeg = encodeJpeg(64, 64, gradient(64, 64), 'rgb', { quality: 90 });
  const ap = enc('/Im0 Do');
  const content = enc(' ');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 5 0 R /Annots [6 0 R] >>`;
  objs[4] = { dict: imageDict(64, 64, 'DeviceRGB', jpeg.length), raw: jpeg };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  objs[6] = `<< /Type /Annot /Subtype /Stamp /Rect [0 0 16 16] /AP << /N 7 0 R >> >>`;
  objs[7] = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /Im0 4 0 R >> >> /Length ${ap.length} >>`,
    raw: ap,
  };
  return { bytes: assemble(objs), imgObjNum: 4 };
}

/** A 64x64 DeviceCMYK DCTDecode image in a 16pt box (288 DPI). No /Decode: the
 *  fixture's JPEG is written by encodeJpeg, which stores CMYK non-inverted and
 *  emits no APP14, so no inversion is in play on either side. */
export function buildCmykImagePdf(): { bytes: Uint8Array; imgObjNum: number } {
  const jpeg = encodeJpeg(64, 64, gradient(64, 64, 4), 'cmyk', { quality: 90 });
  const content = enc('q 16 0 0 16 10 10 cm /Im0 Do Q');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: imageDict(64, 64, 'DeviceCMYK', jpeg.length), raw: jpeg };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  return { bytes: assemble(objs), imgObjNum: 4 };
}

/** An image that is referenced as an /SMask but never drawn. The scan must not
 *  reach it, so the safety net marks it incomplete. */
export function buildSmaskPdf(): { bytes: Uint8Array; imgObjNum: number; smaskObjNum: number } {
  const jpeg = encodeJpeg(64, 64, gradient(64, 64), 'rgb', { quality: 90 });
  const alpha = new Uint8Array(deflateSync(Buffer.from(gradient(64, 64, 1))));
  const content = enc('q 16 0 0 16 10 10 cm /Im0 Do Q');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: imageDict(64, 64, 'DeviceRGB', jpeg.length, '/SMask 6 0 R '), raw: jpeg };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  objs[6] = {
    dict: `<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${alpha.length} >>`,
    raw: alpha,
  };
  return { bytes: assemble(objs), imgObjNum: 4, smaskObjNum: 6 };
}

/** Two byte-identical DCT images drawn in identical boxes under different
 *  resource keys. After recompression both re-encode to the same bytes, so
 *  dedup must merge them — which only happens if images runs before dedup. */
export function buildTwinImagePdf(): { bytes: Uint8Array; imgObjNums: [number, number] } {
  const jpeg = encodeJpeg(64, 64, gradient(64, 64), 'rgb', { quality: 90 });
  const content = enc('q 16 0 0 16 10 10 cm /Im0 Do Q q 16 0 0 16 100 10 cm /Im1 Do Q');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R /Im1 6 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: imageDict(64, 64, 'DeviceRGB', jpeg.length), raw: jpeg };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  objs[6] = { dict: imageDict(64, 64, 'DeviceRGB', jpeg.length), raw: jpeg };
  return { bytes: assemble(objs), imgObjNums: [4, 6] };
}
