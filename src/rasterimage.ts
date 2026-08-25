/**
 * A decoded raster, ready to become a PDF image XObject.
 *
 * Produced by every image-input decoder in this repo (`bmp.ts`, `tiff.ts`) and
 * consumed in exactly one place, `imageembed.ts`'s `buildRasterXObject`. It is
 * a type-only leaf and imports nothing, which is what lets both decoders
 * depend on it without a cycle and what keeps either of them free of PDF
 * knowledge.
 *
 * Rows are TOP-DOWN and padded to a byte boundary only -- never a format's own
 * row stride -- so `samples` can be handed to a PDF image stream unchanged.
 */
export type RasterImage =
  | {
      kind: 'indexed';
      width: number; height: number;
      /** 1, 2, 4 or 8. The samples stay packed at this depth. */
      bpc: 1 | 2 | 4 | 8;
      /** RGB triples, 8 bits each. */
      palette: Uint8Array;
      samples: Uint8Array;
    }
  | {
      kind: 'gray';
      width: number; height: number;
      bpc: 1 | 2 | 4 | 8;
      /** DeviceGray convention: 0 is BLACK. A format saying otherwise -- TIFF's
       *  WhiteIsZero, `decodeCcitt`'s documented 0-is-white output -- is
       *  normalized by its decoder, once, before building this. */
      samples: Uint8Array;
      /** One byte per pixel, straight (NOT premultiplied) alpha. */
      alpha?: Uint8Array;
    }
  | {
      kind: 'rgb';
      width: number; height: number;
      /** 8-bit RGB triples. */
      samples: Uint8Array;
      /** One byte per pixel, straight (NOT premultiplied) alpha. */
      alpha?: Uint8Array;
    }
  | {
      kind: 'cmyk';
      width: number; height: number;
      /** 8-bit CMYK quadruples. */
      samples: Uint8Array;
    }
  | { kind: 'embedded'; format: 'jpeg' | 'png'; payload: Uint8Array };
