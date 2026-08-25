import { describe, it, expect } from 'vitest';
import { makeCode128, makeEan13, makeUpcA, makeEan8 } from '../src/barcode.js';
import { decode128, decodeEan } from './helpers/decode-barcode.js';
import { gfExp, gfMul, rsGeneratorPoly, rsEncode } from '../src/qr.js';
import { encodeQrData, qrMode, chooseQrVersion } from '../src/qr.js';
import { encodeQr, makeQr } from '../src/qr.js';
import { readQrCodewords } from './helpers/decode-barcode.js';
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

const decoded = (page: import('../src/page.js').Page) =>
  new TextDecoder('latin1').decode(page.Contents);

describe('Code128', () => {
  it('round-trips an alphanumeric payload', () => {
    const bc = makeCode128('CODE128');
    expect(bc.kind).toBe('linear');
    expect(bc.modules[0]).toBeGreaterThan(0);   // starts with a bar
    expect(decode128(bc.modules)).toBe('CODE128');
  });

  it('round-trips a payload with a long digit run (auto Code C)', () => {
    expect(decode128(makeCode128('AB123456CD').modules)).toBe('AB123456CD');
  });

  it('round-trips a pure-digit payload', () => {
    expect(decode128(makeCode128('0123456789').modules)).toBe('0123456789');
  });

  it('round-trips a control character via Code A (TAB shift)', () => {
    expect(decode128(makeCode128('A\tB').modules)).toBe('A\tB');
  });

  it('round-trips a payload starting with a control character (Start A)', () => {
    expect(decode128(makeCode128('\tHELLO').modules)).toBe('\tHELLO');
  });

  it('round-trips a run of control characters', () => {
    expect(decode128(makeCode128('\x00\x01\x1f').modules)).toBe('\x00\x01\x1f');
  });

  it('round-trips a GS1-style payload with a GS separator among digits', () => {
    // 0x1D (GS) is the field separator used in GS1-128 data.
    const payload = '10ABC123\x1d21XYZ';
    expect(decode128(makeCode128(payload).modules)).toBe(payload);
  });

  it('round-trips mixed control + lowercase (A/B interplay)', () => {
    expect(decode128(makeCode128('Hello\tWorld\n').modules)).toBe('Hello\tWorld\n');
  });

  it('round-trips the full 0x00-0x7F ASCII range', () => {
    let s = '';
    for (let c = 0; c < 128; c++) s += String.fromCharCode(c);
    expect(decode128(makeCode128(s).modules)).toBe(s);
  });
});

describe('EAN/UPC', () => {
  it('EAN-13 computes the check digit and round-trips', () => {
    const bc = makeEan13('590123412345');       // 12 digits -> check digit appended
    expect(bc.text).toBe('5901234123457');       // known check digit = 7
    expect(decodeEan(bc.modules, 'ean13')).toBe('5901234123457');
  });

  it('EAN-13 validates a supplied check digit', () => {
    expect(() => makeEan13('5901234123450')).toThrow(/check digit/i);
    expect(makeEan13('5901234123457').text).toBe('5901234123457');
  });

  it('UPC-A round-trips as zero-prefixed EAN-13', () => {
    const bc = makeUpcA('03600029145');          // 11 digits -> check appended
    expect(bc.text).toBe('036000291452');
    expect(decodeEan(bc.modules, 'ean13')).toBe('0036000291452');
  });

  it('EAN-8 round-trips', () => {
    const bc = makeEan8('9638507');
    expect(decodeEan(bc.modules, 'ean8')).toBe(bc.text);
  });

  it('rejects non-digit and wrong-length payloads', () => {
    expect(() => makeEan13('12345')).toThrow();
    expect(() => makeEan13('abcdefghijklm')).toThrow();
  });
});

describe('QR: GF(256) + Reed-Solomon', () => {
  it('field arithmetic basics', () => {
    expect(gfExp(0)).toBe(1);
    expect(gfExp(255)).toBe(1);            // wraps (order 255)
    expect(gfMul(0, 5)).toBe(0);
    expect(gfMul(1, 7)).toBe(7);
    expect(gfMul(gfExp(1), gfExp(1))).toBe(gfExp(2)); // 2*2 = 4
  });

  it('degree-10 generator polynomial matches the QR spec', () => {
    // Canonical alpha-exponents for the n=10 generator (ISO 18004 / Thonky table).
    const exps = [0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45];
    expect(rsGeneratorPoly(10)).toEqual(exps.map((e) => gfExp(e)));
  });

  it('all-zero data yields all-zero EC', () => {
    expect(rsEncode(new Array(16).fill(0), 10)).toEqual(new Array(10).fill(0));
  });
});

describe('QR: data encoding', () => {
  it('classifies modes', () => {
    expect(qrMode('01234567')).toBe('numeric');
    expect(qrMode('HELLO WORLD')).toBe('alphanumeric');
    expect(qrMode('https://a.co')).toBe('byte');
  });

  it('encodes the ISO example "01234567" (v1-M) to the known data codewords', () => {
    // ISO/IEC 18004 Annex worked example.
    expect(encodeQrData('01234567', 1, 'M')).toEqual(
      [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11],
    );
  });

  it('auto-sizes the version', () => {
    expect(chooseQrVersion('01234567', 'M')).toBe(1);
    // 1000 bytes fits at ECC H only in a high version (byte capacity grows with version).
    expect(chooseQrVersion('x'.repeat(1000), 'H')).toBeGreaterThan(20);
    expect(() => chooseQrVersion('x'.repeat(100000), 'H')).toThrow(/too large/i);
  });
});

describe('QR: matrix', () => {
  it('builds a 21x21 v1 matrix with correct function patterns', () => {
    const r = encodeQr('01234567', { ecc: 'M' });
    expect(r.version).toBe(1);
    expect(r.matrix.size).toBe(21);
    const dark = (x: number, y: number) => r.matrix.dark[y * 21 + x];
    // top-left finder: dark border, dark 3x3 center, light ring
    expect(dark(0, 0)).toBe(true);
    expect(dark(1, 1)).toBe(false);
    expect(dark(3, 3)).toBe(true);
    // timing pattern alternates on row 6 / col 6
    for (let x = 8; x < 13; x++) expect(dark(x, 6)).toBe(x % 2 === 0);
    // dark module at (col 8, row 4*1+9 = 13)
    expect(dark(8, 13)).toBe(true);
  });

  it('placed codewords read back to data + EC (layout & mask inverse)', () => {
    const r = encodeQr('01234567', { ecc: 'M' });
    expect(readQrCodewords(r.matrix, r.mask, r.reserved)).toEqual(r.codewords);
    expect(r.codewords.length).toBe(26);          // v1: 16 data + 10 EC
  });

  it('makeQr auto-sizes larger payloads and stays square', () => {
    const m = makeQr('https://example.com/some/longer/path?q=1', { ecc: 'Q' });
    expect(m.kind).toBe('matrix');
    expect(m.dark.length).toBe(m.size * m.size);
    expect(m.size).toBeGreaterThanOrEqual(21);
  });
});

describe('Page.AddBarcode', () => {
  it('places a vector Code128 and saves', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddBarcode({ type: 'code128', data: 'ABC-123' }, [50, 700, 200, 60]);
    const content = decoded(page);
    expect(content).toContain(' re');            // rectangle ops emitted
    expect(content).toMatch(/ re\nf\n/);         // rectangles then a fill
    expect(Document.Open(doc.Save()).Pages.length).toBe(1); // re-opens cleanly
  });

  it('places a raster QR (ImageMask XObject)', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddBarcode({ type: 'qr', data: 'https://example.com', ecc: 'M' },
                    [50, 500, 120, 120], { render: 'raster' });
    const content = decoded(page);
    expect(content).toMatch(/\/Bc\d+ Do/);       // XObject draw op
    expect(Document.Open(doc.Save()).Pages[0]).toBeDefined();  // re-opens cleanly
  });

  it('validates rect and payload', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    expect(() => page.AddBarcode({ type: 'code128', data: 'X' }, [1, 2, 3] as any)).toThrow(TypeError);
    expect(() => page.AddBarcode({ type: 'ean13', data: 'nope' }, [0, 0, 10, 10])).toThrow();
  });
});

describe('AddBarcode structure marking', () => {
  // AutoTag, not CreateStructTree: an empty tree leaves the fixture's own page
  // text untagged, so the rule would fire regardless of what the barcode does
  // and every assertion below would be measuring the fixture.
  function taggedDoc(): Document {
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US';
    doc.AutoTag();
    return doc;
  }
  const fires = (doc: Document) =>
    doc.ValidatePdfUa().Issues.some((i) => i.rule === 'UntaggedContent');

  it('has a clean baseline, so the assertions below measure the barcode', () => {
    expect(fires(taggedDoc())).toBe(false);
  });

  it('emits nothing extra by default, and the validator says so', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddBarcode({ type: 'code128', data: 'ABC-123' }, [50, 300, 200, 60]);
    // Not "no BDC anywhere" — AutoTag legitimately marks the fixture's own text.
    // The barcode adds no marking of its own, so with a clean baseline the rule
    // firing is exactly the barcode being reported.
    expect(decoded(doc.Pages[0])).not.toContain('/Artifact BMC');
    expect(fires(doc)).toBe(true); // accurate, not a false negative
  });

  it('wraps as an artifact when asked', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddBarcode({ type: 'code128', data: 'ABC-123' }, [50, 300, 200, 60],
      { artifact: true });
    expect(decoded(doc.Pages[0])).toContain('/Artifact BMC');
    expect(fires(doc)).toBe(false);
  });

  it('creates a /Figure carrying /Alt when given alt', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddBarcode({ type: 'code128', data: 'ABC-123' }, [50, 300, 200, 60],
      { alt: 'Order 12345' });
    expect(decoded(doc.Pages[0])).toMatch(/\/Figure <<\/MCID \d+>> BDC/);
    expect(fires(doc)).toBe(false);
  });

  it("uses the caller's element when given tag, ignoring alt", () => {
    const doc = taggedDoc();
    const elem = doc.GetStructTree()!.Children[0].Append('Figure', { alt: 'mine' });
    doc.Pages[0].AddBarcode({ type: 'code128', data: 'ABC-123' }, [50, 300, 200, 60],
      { tag: elem, alt: 'ignored' });
    expect(decoded(doc.Pages[0])).toMatch(/\/Figure <<\/MCID \d+>> BDC/);
    // Only the caller's element exists — alt did not create a second one.
    expect(doc.GetStructTree()!.Children[0].Children.filter((c) => c.Type === 'Figure'))
      .toHaveLength(1);
  });

  it('throws when artifact contradicts alt, drawing nothing', () => {
    const doc = taggedDoc();
    const before = decoded(doc.Pages[0]);
    expect(() => doc.Pages[0].AddBarcode(
      { type: 'code128', data: 'ABC-123' }, [50, 300, 200, 60],
      { artifact: true, alt: 'x' },
    )).toThrow(TypeError);
    expect(decoded(doc.Pages[0])).toBe(before);
  });

  it('ignores alt on an untagged document instead of throwing', () => {
    const doc = Document.Open(buildStampTarget());
    expect(() => doc.Pages[0].AddBarcode(
      { type: 'code128', data: 'ABC-123' }, [50, 300, 200, 60], { alt: 'x' },
    )).not.toThrow();
    expect(decoded(doc.Pages[0])).not.toContain('BDC');
  });
});
