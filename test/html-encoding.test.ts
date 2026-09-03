import { describe, it, expect } from 'vitest';
import {
  bomEncoding,
  encodingFromLabel,
  metaEncoding,
  decodeHtmlBytes,
} from '../src/htmlencoding.js';

const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);
const attrs = (o: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(o));

describe('bomEncoding', () => {
  it('recognises the UTF-8 BOM', () => {
    expect(bomEncoding(bytes(0xEF, 0xBB, 0xBF, 0x61))).toBe('utf-8');
  });

  it('recognises both UTF-16 BOMs, and they are NOT rewritten to UTF-8', () => {
    // A BOM is honoured as it stands (confidence certain). The UTF-16 -> UTF-8
    // rewrite belongs to the META path alone, so applying it here would make a
    // BOM-led UTF-16 document decode as mojibake.
    expect(bomEncoding(bytes(0xFE, 0xFF, 0x00, 0x61))).toBe('utf-16be');
    expect(bomEncoding(bytes(0xFF, 0xFE, 0x61, 0x00))).toBe('utf-16le');
  });

  it('reports nothing for a document with no BOM', () => {
    expect(bomEncoding(bytes(0x3C, 0x70, 0x3E))).toBeUndefined();
  });

  it('never reads past the end of a short buffer', () => {
    expect(bomEncoding(bytes())).toBeUndefined();
    expect(bomEncoding(bytes(0xEF))).toBeUndefined();
    expect(bomEncoding(bytes(0xEF, 0xBB))).toBeUndefined();
    expect(bomEncoding(bytes(0xFE))).toBeUndefined();
  });
});

describe('encodingFromLabel', () => {
  it('folds case and strips leading and trailing whitespace', () => {
    expect(encodingFromLabel(' UTF-8 ')).toBe('utf-8');
    expect(encodingFromLabel('UTF8')).toBe('utf-8');
  });

  it('resolves a legacy alias to its canonical name', () => {
    // The Encoding Standard's label table, which we do not transcribe: these
    // are the spellings a real legacy document writes.
    expect(encodingFromLabel('cp1251')).toBe('windows-1251');
    expect(encodingFromLabel('x-cp1251')).toBe('windows-1251');
    expect(encodingFromLabel('ms_kanji')).toBe('shift_jis');
  });

  it('resolves iso-8859-1 and ascii to windows-1252', () => {
    // Not a bug and not an approximation: the Encoding Standard deliberately
    // maps both onto windows-1252, because that is what the web means by them.
    expect(encodingFromLabel('iso-8859-1')).toBe('windows-1252');
    expect(encodingFromLabel('us-ascii')).toBe('windows-1252');
  });

  it('reports nothing for a label no encoding claims', () => {
    expect(encodingFromLabel('win-1251')).toBeUndefined();
    expect(encodingFromLabel('utf-7')).toBeUndefined();
    expect(encodingFromLabel('')).toBeUndefined();
  });

  it('reports nothing for a label whose encoding is `replacement`', () => {
    // The Encoding Standard maps these onto a decoder that yields one U+FFFD
    // for the whole stream, which no TextDecoder exposes. Declining leaves the
    // current encoding standing, which is the safer of the two wrong answers.
    expect(encodingFromLabel('iso-2022-kr')).toBeUndefined();
    expect(encodingFromLabel('hz-gb-2312')).toBeUndefined();
  });
});

describe('metaEncoding', () => {
  it('reads a charset attribute', () => {
    expect(metaEncoding(attrs({ charset: 'windows-1251' }))).toBe('windows-1251');
  });

  it('reads charset out of an http-equiv content-type', () => {
    expect(metaEncoding(attrs({
      'http-equiv': 'Content-Type',
      content: 'text/html; charset=windows-1251',
    }))).toBe('windows-1251');
  });

  it('ignores a content attribute whose http-equiv is not content-type', () => {
    expect(metaEncoding(attrs({
      'http-equiv': 'refresh',
      content: 'text/html; charset=windows-1251',
    }))).toBeUndefined();
    expect(metaEncoding(attrs({ content: 'text/html; charset=windows-1251' })))
      .toBeUndefined();
  });

  it('prefers the charset attribute over the content attribute', () => {
    expect(metaEncoding(attrs({
      charset: 'koi8-r',
      'http-equiv': 'content-type',
      content: 'text/html; charset=windows-1251',
    }))).toBe('koi8-r');
  });

  it('falls through to content when the charset attribute names no encoding', () => {
    // The in-head rule is "charset, and getting an encoding returns an
    // encoding, OTHERWISE http-equiv" — so a junk charset must not shadow a
    // perfectly good declaration sitting beside it.
    expect(metaEncoding(attrs({
      charset: 'nonsense-8',
      'http-equiv': 'content-type',
      content: 'text/html; charset=koi8-r',
    }))).toBe('koi8-r');
  });

  it('accepts a quoted value inside content', () => {
    expect(metaEncoding(attrs({
      'http-equiv': 'content-type', content: "text/html; charset='koi8-r'",
    }))).toBe('koi8-r');
    expect(metaEncoding(attrs({
      'http-equiv': 'content-type', content: 'text/html; charset="koi8-r"',
    }))).toBe('koi8-r');
  });

  it('reports nothing for an unterminated quoted value', () => {
    expect(metaEncoding(attrs({
      'http-equiv': 'content-type', content: "text/html; charset='koi8-r",
    }))).toBeUndefined();
  });

  it('keeps scanning past a "charset" that is not followed by =', () => {
    // The extraction algorithm restarts its search one character on rather
    // than giving up, so the real declaration behind a decoy is still found.
    expect(metaEncoding(attrs({
      'http-equiv': 'content-type', content: 'charsetish; charset=koi8-r',
    }))).toBe('koi8-r');
  });

  it('ends an unquoted value at a semicolon or whitespace', () => {
    expect(metaEncoding(attrs({
      'http-equiv': 'content-type', content: 'text/html; charset=koi8-r; q=1',
    }))).toBe('koi8-r');
    expect(metaEncoding(attrs({
      'http-equiv': 'content-type', content: 'text/html; charset=koi8-r other',
    }))).toBe('koi8-r');
  });

  it('tolerates whitespace around the equals sign', () => {
    expect(metaEncoding(attrs({
      'http-equiv': 'content-type', content: 'text/html; charset = koi8-r',
    }))).toBe('koi8-r');
  });

  it('rewrites a meta-declared UTF-16 to UTF-8', () => {
    // A document that reached tree construction as ASCII-compatible bytes
    // cannot actually be UTF-16, so the declaration is a mistake the spec
    // corrects rather than obeys. Obeying it decodes the page to nothing.
    expect(metaEncoding(attrs({ charset: 'utf-16' }))).toBe('utf-8');
    expect(metaEncoding(attrs({ charset: 'utf-16be' }))).toBe('utf-8');
    expect(metaEncoding(attrs({ charset: 'utf-16le' }))).toBe('utf-8');
  });

  it('rewrites a meta-declared x-user-defined to windows-1252', () => {
    expect(metaEncoding(attrs({ charset: 'x-user-defined' }))).toBe('windows-1252');
  });

  it('reports nothing for a meta naming an encoding we cannot decode', () => {
    expect(metaEncoding(attrs({ charset: 'nonsense-8' }))).toBeUndefined();
    expect(metaEncoding(attrs({ charset: '' }))).toBeUndefined();
  });
});

describe('decodeHtmlBytes', () => {
  it('decodes legacy bytes through the named encoding', () => {
    expect(decodeHtmlBytes(bytes(0xCF, 0xF0, 0xE8), 'windows-1251')).toBe('При');
  });

  it('strips a BOM rather than leaving it as content', () => {
    // A leading U+FEFF would reach the tokenizer as a character token and be
    // inserted into <body> as text.
    expect(decodeHtmlBytes(bytes(0xEF, 0xBB, 0xBF, 0x61), 'utf-8')).toBe('a');
  });

  it('replaces an invalid sequence rather than throwing', () => {
    // Damage is a value: the whole HTML stack's rule, and the reason a legacy
    // document survives its first pass as UTF-8 with its ASCII tags intact.
    expect(decodeHtmlBytes(bytes(0x3C, 0x70, 0x3E, 0xCF, 0xF0), 'utf-8'))
      .toBe('<p>��');
  });

  it('falls back to UTF-8 for an encoding this runtime cannot supply', () => {
    // A small-icu build supplies almost no legacy decoder. Degrading beats
    // throwing out of a parser whose contract is that it never throws.
    expect(decodeHtmlBytes(bytes(0x61), 'iso-2022-kr')).toBe('a');
  });
});
