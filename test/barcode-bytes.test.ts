import { describe, expect, it } from 'vitest';
import { makePdf417, makePdf417Bytes, pdf417Bytes } from '../src/pdf417.js';
import { makeDataMatrix, makeDataMatrixBytes, dataMatrixBytes } from '../src/datamatrix.js';
import { makeQr, makeQrBytes } from '../src/qr.js';

// The byte paths are what a paper-barcode field draws through (2srz.4): its
// content may be compressed, so it is bytes rather than a string. The string
// entry points must be exactly the byte path over their own byte conversion,
// which test/barcode-zxing.test.ts's ZXing hashes then fence.
const STRINGS = ['HELLO', 'Grüße Привет', '1234567890123', 'a\tb\nc'];

describe('byte-input encoder paths', () => {
  for (const s of STRINGS) {
    it(`PDF417 byte path equals the string path for ${JSON.stringify(s)}`, () => {
      const { bytes, eci } = pdf417Bytes(s);
      expect(makePdf417Bytes(bytes, eci)).toEqual(makePdf417(s));
    });
    it(`Data Matrix byte path equals the string path for ${JSON.stringify(s)}`, () => {
      const { bytes, eci } = dataMatrixBytes(s);
      expect(makeDataMatrixBytes(bytes, eci)).toEqual(makeDataMatrix(s));
    });
  }

  it('QR byte path equals the string path for a string that selects byte mode', () => {
    const s = 'a\tb';
    expect(makeQrBytes(new TextEncoder().encode(s))).toEqual(makeQr(s));
  });

  it('QR byte path stays in byte mode for digits', () => {
    // As a string these select numeric mode; as bytes they must not, or a
    // compressed payload that happens to be all digits would change meaning.
    expect(makeQrBytes(new TextEncoder().encode('0123'))).not.toEqual(makeQr('0123'));
  });

  it('encodes arbitrary bytes in all three', () => {
    const raw = Uint8Array.from([0, 255, 10, 9, 0x80]);
    expect(makePdf417Bytes(raw, undefined).dark.length).toBeGreaterThan(0);
    expect(makeDataMatrixBytes(raw, undefined).dark.length).toBeGreaterThan(0);
    expect(makeQrBytes(raw).dark.length).toBeGreaterThan(0);
  });
});
