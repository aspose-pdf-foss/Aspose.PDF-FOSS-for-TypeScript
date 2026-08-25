import { describe, it, expect } from 'vitest';
import { TextFont } from '../src/font.js';
import { PdfDict, PdfObject, name } from '../src/types.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dict = (o: Record<string, PdfObject>): PdfDict => new Map(Object.entries(o));

// Minimal resolver: values are already direct (no indirect refs) in these fixtures.
const id = (o: PdfObject | undefined) => o as PdfObject;
const noInflate = () => new Uint8Array(0);

describe('TextFont simple', () => {
  it('decodes WinAnsi bytes', () => {
    const f = new TextFont(dict({
      Subtype: name('Type1'), BaseFont: name('Helvetica'),
      Encoding: name('WinAnsiEncoding'),
    }), id, noInflate);
    expect(f.codeWidth).toBe(1);
    expect(f.decode(enc('Hello'))).toBe('Hello');
    expect(f.decode(Uint8Array.of(0x80))).toBe('€'); // Euro
  });

  it('applies /Differences over the base encoding', () => {
    const f = new TextFont(dict({
      Subtype: name('Type1'),
      Encoding: dict({
        BaseEncoding: name('WinAnsiEncoding'),
        Differences: [65, name('bullet'), name('Euro')], // 65->bullet, 66->Euro
      }),
    }), id, noInflate);
    expect(f.decode(Uint8Array.of(65, 66))).toBe('•€');
  });
});

describe('TextFont with ToUnicode', () => {
  it('prefers ToUnicode over base encoding', () => {
    const stream = {
      kind: 'stream' as const,
      dict: dict({}),
      raw: enc('1 begincodespacerange <00> <FF> endcodespacerange\n' +
               '1 beginbfchar <41> <0062> endbfchar\n'),
    };
    const f = new TextFont(dict({
      Subtype: name('Type1'), Encoding: name('WinAnsiEncoding'), ToUnicode: stream,
    }), id, (s) => s.raw); // inflate returns raw bytes for the fixture
    expect(f.decode(Uint8Array.of(0x41))).toBe('b'); // ToUnicode wins over 'A'
  });
});

describe('TextFont Type0 Identity-H', () => {
  it('decodes 2-byte codes via ToUnicode', () => {
    const stream = {
      kind: 'stream' as const,
      dict: dict({}),
      raw: enc('1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
               '1 beginbfchar <0003> <0048> <0004> <0069> endbfchar\n'),
    };
    const f = new TextFont(dict({
      Subtype: name('Type0'), Encoding: name('Identity-H'), ToUnicode: stream,
    }), id, (s) => s.raw);
    expect(f.codeWidth).toBe(2);
    expect(f.decode(Uint8Array.of(0x00, 0x03, 0x00, 0x04))).toBe('Hi');
  });
});

describe('TextFont decodeRun widths', () => {
  it('sums real /Widths (em units) for a simple font', () => {
    const f = new TextFont(dict({
      Subtype: name('Type1'), Encoding: name('WinAnsiEncoding'),
      FirstChar: 65, Widths: [500, 250], // 'A'=500, 'B'=250 (glyph units)
    }), id, noInflate);
    const r = f.decodeRun(Uint8Array.of(65, 66)); // "AB"
    expect(r.text).toBe('AB');
    expect(r.width).toBeCloseTo(0.75); // (500+250)/1000
    expect(r.ncodes).toBe(2);
    expect(r.nWordSpaces).toBe(0);
  });

  it('uses /MissingWidth for codes outside /Widths', () => {
    const f = new TextFont(dict({
      Subtype: name('Type1'), Encoding: name('WinAnsiEncoding'),
      FirstChar: 65, Widths: [500],
      FontDescriptor: dict({ MissingWidth: 100 }),
    }), id, noInflate);
    const r = f.decodeRun(Uint8Array.of(65, 90)); // 'A' in range, 'Z' out
    expect(r.width).toBeCloseTo(0.6); // (500 + 100)/1000
  });

  it('counts single-byte space codes for word spacing', () => {
    const f = new TextFont(dict({
      Subtype: name('Type1'), Encoding: name('WinAnsiEncoding'),
      FirstChar: 32, Widths: [250, 0, 0, 0, 0, 0, 0, 0, 0, 500], // 32=space, 41='A'
    }), id, noInflate);
    const r = f.decodeRun(Uint8Array.of(32, 41)); // space + 'A'(code 41)
    expect(r.nWordSpaces).toBe(1);
  });

  it('falls back to Standard-14 AFM widths when no /Widths', () => {
    // Only a Standard-14 face may omit /Widths; an unnamed one substitutes
    // Helvetica, exactly as a viewer would.
    const f = new TextFont(dict({
      Subtype: name('Type1'), Encoding: name('WinAnsiEncoding'),
    }), id, noInflate);
    const r = f.decodeRun(Uint8Array.of(65, 66, 67)); // A, B, C
    expect(r.width).toBeCloseTo((667 + 667 + 722) / 1000);
  });

  it('reads Type0 /W (both forms) and /DW default', () => {
    const cid = dict({
      Subtype: name('CIDFontType2'),
      DW: 600,
      // 3 -> 1000 ; 5..6 -> 400
      W: [3, [1000], 5, 6, 400],
    });
    const f = new TextFont(dict({
      Subtype: name('Type0'), Encoding: name('Identity-H'),
      DescendantFonts: [cid],
    }), id, noInflate);
    const r = f.decodeRun(Uint8Array.of(0x00, 0x03, 0x00, 0x05, 0x00, 0x09));
    // cid 3 -> 1000, cid 5 -> 400, cid 9 -> DW 600
    expect(r.width).toBeCloseTo(2.0); // (1000+400+600)/1000
    expect(r.ncodes).toBe(3);
  });

  it('decode() still returns just the text', () => {
    const f = new TextFont(dict({
      Subtype: name('Type1'), Encoding: name('WinAnsiEncoding'),
    }), id, noInflate);
    expect(f.decode(Uint8Array.of(65, 66))).toBe('AB');
  });
});
