import { describe, it, expect } from 'vitest';
import { decodeDataUri } from '../src/datauri.js';

describe('decodeDataUri', () => {
  it('decodes a base64 payload', () => {
    // "hi" in base64.
    expect(decodeDataUri('data:image/png;base64,aGk=')).toEqual(
      new Uint8Array([0x68, 0x69]));
  });

  it('decodes a percent-encoded payload as UTF-8', () => {
    expect(decodeDataUri('data:text/plain,a%20b')).toEqual(
      new Uint8Array([0x61, 0x20, 0x62]));
  });

  it('refuses anything that is not a data: URI', () => {
    expect(decodeDataUri('https://example.com/a.png')).toBeUndefined();
    expect(decodeDataUri('a.png')).toBeUndefined();
    expect(decodeDataUri('')).toBeUndefined();
  });

  it('refuses a data: URI with no comma', () => {
    // No payload separator at all: there is nothing to decode, and slicing
    // from -1 would silently take the whole string as the payload.
    expect(decodeDataUri('data:image/png;base64')).toBeUndefined();
  });

  it('never throws on a malformed payload', () => {
    // Damage is a value, the rule every parser here follows. A stray percent
    // makes decodeURIComponent throw, which must not escape.
    expect(() => decodeDataUri('data:text/plain,%%%')).not.toThrow();
    expect(decodeDataUri('data:text/plain,%%%')).toBeUndefined();
  });
});
