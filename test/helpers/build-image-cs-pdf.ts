import { readFileSync } from 'node:fs';
import { assemble, contentStream } from './build-grayscale-pdf.js';
import { minimalIccProfile } from './build-pdfa-pdf.js';

/**
 * A one-page document whose ONLY colour is an image XObject's colour space
 * (`ixxw.3`).
 *
 * `buildPdfaPdf` cannot serve this: it assembles the whole file as a JS string
 * and encodes it once, so a vendored JPEG's bytes would come back mangled.
 * `assemble` concatenates `Uint8Array`s instead and is byte-safe.
 *
 * The page draws the image and states NO colour operator of its own, which is
 * the point — before `ixxw.3` the page scan looked only at operators and
 * inline images, so a document like this reported no device colour at all and
 * `ConvertToPdfA` called it conformant with a DeviceCMYK payload in it.
 */

const enc = (s: string) => new TextEncoder().encode(s);

export type ImageJpeg = 'cmyk-t0' | 'cmyk-ycck';

const JPEG_FILE: Record<ImageJpeg, string> = {
  'cmyk-t0': 'synth-cmyk-t0-baseline.jpg',
  'cmyk-ycck': 'synth-cmyk-ycck-baseline.jpg',
};

export function vendoredJpeg(which: ImageJpeg): Uint8Array {
  return new Uint8Array(readFileSync(
    new URL(`../fixtures/jpeg/${JPEG_FILE[which]}`, import.meta.url)));
}

export interface ImageCsOptions {
  /** Which vendored CMYK JPEG to embed. Default 'cmyk-t0'. */
  jpeg?: ImageJpeg;
  /**
   * The image's `/ColorSpace`, as raw PDF text. Default `/DeviceCMYK`.
   * `'/CS0'` names the page's `/Resources /ColorSpace /CS0`, which is what
   * `namedSpace` supplies.
   */
  colorSpace?: string;
  /** A `/Resources /ColorSpace /CS0` entry, as raw PDF text. */
  namedSpace?: string;
  /** The PDF/A output intent's profile space. 'none' omits the intent. */
  intent?: 'RGB' | 'CMYK' | 'GRAY' | 'none';
  /** Emit an ICC profile stream at object 7 with this `/N`, for a
   *  `colorSpace` of `'[/ICCBased 7 0 R]'`. */
  iccComponents?: 1 | 3 | 4;
}

export function buildImageCsPdf(opts: ImageCsOptions = {}): Uint8Array {
  const bytes = vendoredJpeg(opts.jpeg ?? 'cmyk-t0');
  const cs = opts.colorSpace ?? '/DeviceCMYK';
  const intent = opts.intent ?? 'RGB';
  const objs: (string | { dict: string; raw: Uint8Array })[] = [];

  const catParts = ['/Type /Catalog', '/Pages 2 0 R'];
  if (intent !== 'none') {
    catParts.push('/OutputIntents [<< /Type /OutputIntent /S /GTS_PDFA1 '
      + '/OutputConditionIdentifier (probe) /DestOutputProfile 6 0 R >>]');
  }
  objs[1] = `<< ${catParts.join(' ')} >>`;
  objs[2] = '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 61 37] >>';
  const res = ['/XObject << /Im0 5 0 R >>'];
  if (opts.namedSpace) res.push(`/ColorSpace << /CS0 ${opts.namedSpace} >>`);
  objs[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << ${res.join(' ')} >> >>`;
  objs[4] = contentStream('q 61 0 0 37 0 0 cm /Im0 Do Q\n');
  objs[5] = {
    dict: `<< /Type /XObject /Subtype /Image /Width 61 /Height 37 /ColorSpace ${cs} `
      + `/BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>`,
    raw: bytes,
  };
  if (intent !== 'none') {
    const body = minimalIccProfile(intent);
    const n = intent === 'GRAY' ? 1 : intent === 'RGB' ? 3 : 4;
    objs[6] = { dict: `<< /N ${n} /Length ${body.length} >>`, raw: enc(body) };
  }
  if (opts.iccComponents !== undefined) {
    objs[7] = { dict: `<< /N ${opts.iccComponents} /Length 4 >>`, raw: enc('ICC ') };
  }
  return assemble(objs);
}
