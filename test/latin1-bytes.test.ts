import { describe, it, expect } from 'vitest';
import { Lexer } from '../src/lexer.js';
import { ObjectParser } from '../src/object-parser.js';
import { serializeObject, serializeString, enc as utf8 } from '../src/serialize.js';
import { isName } from '../src/types.js';

// TextDecoder('latin1') is a WHATWG alias for **windows-1252**, not
// ISO-8859-1. Bytes 0x80-0x9F decode to code points that are not the byte
// value (0x80 -> U+20AC, 0x85 -> U+2026, ...), so any decode/re-encode cycle
// through it silently rewrites those bytes. Length is preserved, which is what
// makes it hard to spot.

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const parse = (src: string) => new ObjectParser(new Lexer(enc(src))).parseObject();
const text = (b: Uint8Array) => String.fromCharCode(...b);

describe('name #XX escapes in the 0x80-0x9F range', () => {
  it('decodes #80 to U+0080, not to the windows-1252 character', () => {
    const v = parse('/A#80B');
    expect(isName(v) && v.name).toBe('AB');
  });

  it.each(['80', '85', '8F', '9D', '9F'])('round-trips /A#%sB through serialize', (hex) => {
    const v = parse(`/A#${hex}B`);
    expect(text(serializeObject(v)).toLowerCase()).toBe(`/a#${hex.toLowerCase()}b`);
  });

  it('leaves bytes outside that range alone', () => {
    const v = parse('/A#E9B');
    expect(isName(v) && v.name).toBe('AéB');
    expect(text(serializeObject(v)).toLowerCase()).toBe('/a#e9b');
  });
});

describe('serializeString emits pure ASCII', () => {
  // This is the invariant that keeps every `enc(...)` call site safe. `enc` is
  // TextEncoder, i.e. UTF-8, so any character above 127 reaching it would emit
  // two bytes and shift every offset after it. stamp.ts builds whole content
  // bodies as strings around serializeString output and relies on this.
  it('escapes every byte outside 32..126, for all 256 values', () => {
    const all = new Uint8Array(256).map((_v, i) => i);
    const s = serializeString(all);
    const bad = [...s].filter((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126);
    expect(bad).toEqual([]);
    // and therefore UTF-8 encoding it is a no-op on length
    expect(utf8(s).length).toBe(s.length);
  });
});
