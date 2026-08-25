import { deflateSync } from 'node:zlib';
import { emitObjs, type Obj } from './build-image-pdf.js';

const enc = (s: string) => new TextEncoder().encode(s);

/** A 2x2 DeviceRGB 8bpc Flate image's raw (deflated) bytes. */
function rgb2x2(): Uint8Array {
  return new Uint8Array(deflateSync(Buffer.from(
    Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]))));
}

const IMAGE_DICT = (len: number) =>
  `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB `
  + `/BitsPerComponent 8 /Filter /FlateDecode /Length ${len} >>`;

/** Two pages, each drawing the SAME image object (obj 6) as its own /Im0.
 *  The vehicle for the per-page copy-on-write rules. */
export function buildSharedImagePdf(): Uint8Array {
  const raw = rgb2x2();
  const c1 = enc('q 80 0 0 40 10 10 cm /Im0 Do Q');
  const c2 = enc('q 60 0 0 30 20 20 cm /Im0 Do Q');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 6 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 6 0 R >> >> /Contents 7 0 R >>`;
  objs[5] = { dict: `<< /Length ${c1.length} >>`, raw: c1 };
  objs[6] = { dict: IMAGE_DICT(raw.length), raw };
  objs[7] = { dict: `<< /Length ${c2.length} >>`, raw: c2 };
  return emitObjs(objs, 7);
}

/** Two pages, each drawing the SAME Form XObject (obj 6), whose own resources
 *  hold the image (obj 7) as /ImF and whose content actually draws it. The
 *  vehicle for nested-scope removal and form copy-on-write. */
export function buildFormImagePdf(): Uint8Array {
  const raw = rgb2x2();
  const form = enc('q 1 0 0 1 0 0 cm /ImF Do Q');
  const c1 = enc('q 100 0 0 100 0 0 cm /Fm0 Do Q');
  const c2 = enc('q 50 0 0 50 20 20 cm /Fm0 Do Q');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm0 6 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm0 6 0 R >> >> /Contents 8 0 R >>`;
  objs[5] = { dict: `<< /Length ${c1.length} >>`, raw: c1 };
  objs[6] = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] `
      + `/Resources << /XObject << /ImF 7 0 R >> >> /Length ${form.length} >>`,
    raw: form,
  };
  objs[7] = { dict: IMAGE_DICT(raw.length), raw };
  objs[8] = { dict: `<< /Length ${c2.length} >>`, raw: c2 };
  return emitObjs(objs, 8);
}

/** One page drawing /Im0 twice, with an /ExtGState /GS0 that is DECLARED in the
 *  page resources and referenced by no operator. That unreferenced entry is what
 *  separates a targeted Remove from a sanitizing one -- the image's own entry
 *  goes either way, and only the full prune takes /GS0 as well. */
export function buildTwiceDrawnImagePdf(): Uint8Array {
  const raw = rgb2x2();
  const content = enc('q 80 0 0 40 10 10 cm /Im0 Do Q q 60 0 0 30 20 120 cm /Im0 Do Q');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> `
    + `/ExtGState << /GS0 6 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: IMAGE_DICT(raw.length), raw };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  objs[6] = `<< /Type /ExtGState /ca 0.5 /CA 0.5 >>`;
  return emitObjs(objs, 6);
}

/** One page whose only image draw is wrapped in a `gs`, and whose `/GS0` is
 *  referenced by THAT OPERATOR AND NOWHERE ELSE.
 *
 *  The vehicle for `5ttj`. Before the walk-back crossed a `gs`, removing the
 *  image left an inert `q /GS0 gs … cm Q` behind — inert to render, but it kept
 *  `/GS0` referenced, so even a sanitizing Remove could not prune the ExtGState
 *  that only the removed block had used. Contrast `buildTwiceDrawnImagePdf`,
 *  whose `/GS0` is declared and referenced by no operator at all: that one
 *  separates a targeted Remove from a sanitizing one, this one separates a
 *  sanitizing Remove from a *complete* one. */
export function buildGsWrappedImagePdf(): Uint8Array {
  const raw = rgb2x2();
  const content = enc('q /GS0 gs 80 0 0 40 10 10 cm /Im0 Do Q');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> `
    + `/ExtGState << /GS0 6 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: IMAGE_DICT(raw.length), raw };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  objs[6] = `<< /Type /ExtGState /ca 0.5 /CA 0.5 >>`;
  return emitObjs(objs, 6);
}
