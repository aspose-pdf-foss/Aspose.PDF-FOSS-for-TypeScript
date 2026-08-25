import { deflateSync } from 'node:zlib';
import { emitObjs, type Obj } from './build-image-pdf.js';

const enc = (s: string) => new TextEncoder().encode(s);

/** Inline image data is written as ASCIIHex (`/F /AHx`) throughout, so a content
 *  stream built from a JavaScript string carries no raw binary and cannot be
 *  corrupted by an encoding step. `redact-image.test.ts` uses the same trick. */
const AHX_RGB_2x2 = 'ff000000ff000000ffffff00';   // red, green, blue, yellow
const AHX_GRAY_1x1 = '80';

/** `BI … ID <hex>> EI` for an ASCIIHex-coded inline image. */
function inline(w: number, h: number, cs: 'RGB' | 'G', hex: string): string {
  return `BI /W ${w} /H ${h} /CS /${cs} /BPC 8 /F /AHx ID ${hex}> EI`;
}

/** One page carrying TWO inline images and ONE image XObject (`/Im0`).
 *
 *  The two inline images differ (2x2 RGB, then 1x1 gray) so a test can say
 *  WHICH one a removal took -- a pair of identical images could not. The
 *  XObject is there so a test can assert that `page.Images` and
 *  `page.InlineImages` stay separate rather than each picking up the other's. */
export function buildInlineImagePdf(): Uint8Array {
  const rgb = new Uint8Array(deflateSync(Buffer.from(
    Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))));
  const content = enc([
    `q 40 0 0 20 10 10 cm ${inline(2, 2, 'RGB', AHX_RGB_2x2)} Q`,
    `q 30 0 0 15 10 100 cm ${inline(1, 1, 'G', AHX_GRAY_1x1)} Q`,
    `q 50 0 0 25 10 200 cm /Im0 Do Q`,
  ].join('\n'));

  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> `
    + `/Contents 5 0 R >>`;
  objs[4] = {
    dict: `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB `
      + `/BitsPerComponent 8 /Filter /FlateDecode /Length ${rgb.length} >>`,
    raw: rgb,
  };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  return emitObjs(objs, 5);
}

/** One page whose only content is `/Fm0 Do`, where the form's own content holds
 *  an inline image. The vehicle for a nested ContentAddr: the handle's path is
 *  ['Fm0'] rather than [], and removing it edits the form's stream. */
export function buildInlineInFormPdf(): Uint8Array {
  const form = enc(`q 1 0 0 1 0 0 cm ${inline(2, 2, 'RGB', AHX_RGB_2x2)} Q`);
  const content = enc('q 100 0 0 100 0 0 cm /Fm0 Do Q');

  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm0 4 0 R >> >> `
    + `/Contents 5 0 R >>`;
  objs[4] = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Length ${form.length} >>`,
    raw: form,
  };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  return emitObjs(objs, 5);
}
