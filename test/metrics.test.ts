import { describe, it, expect } from 'vitest';
import {
  HELVETICA_WIDTHS, measureWinAnsi, measure, glyphWidth, normalizeFont,
} from '../src/metrics.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('Helvetica metrics', () => {
  it('has a 256-entry width table', () => {
    expect(HELVETICA_WIDTHS).toHaveLength(256);
  });

  it('measures "Hello" at 12pt from AFM widths', () => {
    // H722 e556 l222 l222 o556 = 2278 /1000 * 12 = 27.336
    expect(measureWinAnsi(enc('Hello'), 12)).toBeCloseTo(27.336, 3);
  });

  it('scales linearly with font size', () => {
    expect(measureWinAnsi(enc('Hello'), 24)).toBeCloseTo(54.672, 3);
  });

  it('treats control-range bytes as zero width', () => {
    expect(measureWinAnsi(Uint8Array.of(0x00, 0x09), 12)).toBe(0);
  });
});

describe('Standard-14 metrics', () => {
  it('keeps the Helvetica shim stable', () => {
    expect(measureWinAnsi(enc('A'), 12)).toBeCloseTo(8.004, 3);
    expect(measure('Helvetica', enc('A'), 12)).toBe(measureWinAnsi(enc('A'), 12));
  });

  it('reproduces the exact Helvetica table via the name-driven builder', () => {
    // The non-Helvetica tables are built by mkWidths(WINANSI_NAMES, map). Build a
    // Helvetica map the same way and confirm it matches the hand-transcribed
    // HELVETICA_WIDTHS at every code — validating WINANSI_NAMES + the method.
    for (let c = 0; c < 256; c++) {
      expect(glyphWidth('Helvetica', c)).toBe(HELVETICA_WIDTHS[c]);
    }
  });

  it('has canonical per-family widths', () => {
    expect(glyphWidth('Helvetica', 0x20)).toBe(278);      // space
    expect(glyphWidth('Helvetica-Bold', 0x41)).toBe(722); // A
    expect(glyphWidth('Times-Roman', 0x20)).toBe(250);    // space
    expect(glyphWidth('Times-Roman', 0x41)).toBe(722);    // A
    expect(glyphWidth('Times-Bold', 0x57)).toBe(1000);    // W
    expect(glyphWidth('Courier', 0x41)).toBe(600);        // monospace
    expect(glyphWidth('Courier-Bold', 0x20)).toBe(600);
    expect(glyphWidth('ZapfDingbats', 0x34)).toBeGreaterThan(0); // '4' check glyph
  });

  it('measure is additive', () => {
    const ab = measure('Times-Roman', enc('AB'), 10);
    const a = measure('Times-Roman', enc('A'), 10);
    const b = measure('Times-Roman', enc('B'), 10);
    expect(ab).toBeCloseTo(a + b, 6);
  });

  it('has canonical Symbol widths indexed by its built-in encoding', () => {
    expect(glyphWidth('Symbol', 0x20)).toBe(250); // space
    expect(glyphWidth('Symbol', 0x41)).toBe(722); // Alpha
    expect(glyphWidth('Symbol', 0x61)).toBe(631); // alpha
    expect(glyphWidth('Symbol', 0xb7)).toBe(460); // bullet (183)
    expect(glyphWidth('Symbol', 0xd7)).toBe(250); // dotmath (215)
  });

  it('has canonical ZapfDingbats widths indexed by its built-in encoding', () => {
    expect(glyphWidth('ZapfDingbats', 0x20)).toBe(278); // space
    expect(glyphWidth('ZapfDingbats', 0x21)).toBe(974); // a1 (33)
    expect(glyphWidth('ZapfDingbats', 0x34)).toBe(846); // a20 '4' check glyph (52)
    expect(glyphWidth('ZapfDingbats', 0x6c)).toBe(791); // a71 'l' circle glyph (108)
    expect(glyphWidth('ZapfDingbats', 0xfe)).toBe(918); // a191 (254)
  });

  it('covers every printable Symbol/ZapfDingbats code and zeroes the gaps', () => {
    for (const font of ['Symbol', 'ZapfDingbats'] as const) {
      expect(glyphWidth(font, 0x20)).toBeGreaterThan(0); // space present
      for (let c = 0x21; c <= 0x7e; c++) expect(glyphWidth(font, c)).toBeGreaterThan(0);
      for (let c = 0xa1; c <= 0xfe; c++) {
        if (c === 0xf0) continue; // 240 unused in both built-in encodings
        expect(glyphWidth(font, c)).toBeGreaterThan(0);
      }
      for (let c = 0; c < 0x20; c++) expect(glyphWidth(font, c)).toBe(0);
      for (let c = 0x7f; c <= 0xa0; c++) expect(glyphWidth(font, c)).toBe(0);
      expect(glyphWidth(font, 0xf0)).toBe(0);
      expect(glyphWidth(font, 0xff)).toBe(0);
    }
  });

  it('normalizes names and abbreviations', () => {
    expect(normalizeFont('Helvetica')).toBe('Helvetica');
    expect(normalizeFont('Helv')).toBe('Helvetica');
    expect(normalizeFont('HeBo')).toBe('Helvetica-Bold');
    expect(normalizeFont('TiRo')).toBe('Times-Roman');
    expect(normalizeFont('Cour')).toBe('Courier');
    expect(normalizeFont('ZaDb')).toBe('ZapfDingbats');
    expect(normalizeFont('ABCDEF+Helvetica-Bold')).toBe('Helvetica-Bold');
    expect(normalizeFont('SomethingWeird')).toBe('Helvetica');
  });
});
