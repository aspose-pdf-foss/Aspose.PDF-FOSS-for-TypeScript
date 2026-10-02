/** The OCR seam (`3ywf.3`): pixels in, positioned text out.
 *
 *  `MakeSearchable` renders each page and hands the image to an
 *  {@link OcrEngine} the caller supplies — `aiOcrEngine` over an `AiModel`, or
 *  a few-line adapter over Tesseract or a cloud OCR service. Vision LLMs read
 *  well and box poorly; dedicated OCR boxes well. The seam lets the caller
 *  choose. A LEAF importing nothing. */

/** A rendered page. */
export interface OcrImage {
  bytes: Uint8Array;
  mediaType: 'image/png' | 'image/jpeg';
  /** Pixels. */
  width: number;
  height: number;
}

/** One recognized run of text — a word or a whole line — and where it sits:
 *  `box` is `[x0, y0, x1, y1]` in image PIXELS, origin top-left, y downward. */
export interface OcrSpan {
  text: string;
  box: [x0: number, y0: number, x1: number, y1: number];
}

/** Recognizes the text in a page image. */
export interface OcrEngine {
  recognize(image: OcrImage, opts: { signal?: AbortSignal }): Promise<OcrSpan[]>;
}
