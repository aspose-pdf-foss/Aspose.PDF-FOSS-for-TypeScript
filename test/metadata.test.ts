import { describe, it, expect } from 'vitest';
import { encodePdfText, decodePdfText, formatPdfDate, parsePdfDate, readMetadata, applyUpdate, MetadataUpdate } from '../src/metadata.js';
import { PdfDict, PdfObject, isString } from '../src/types.js';

describe('pdf text codecs', () => {
  it('round-trips ASCII as latin1 (no BOM)', () => {
    const bytes = encodePdfText('Hello');
    expect(Array.from(bytes)).toEqual([72, 101, 108, 108, 111]);
    expect(decodePdfText(bytes)).toBe('Hello');
  });

  it('encodes non-ASCII as UTF-16BE with BOM and round-trips', () => {
    const bytes = encodePdfText('Café—Ω');
    expect(bytes[0]).toBe(0xfe);
    expect(bytes[1]).toBe(0xff);
    expect(decodePdfText(bytes)).toBe('Café—Ω');
  });

  it('decodes latin1 when no BOM present', () => {
    expect(decodePdfText(new Uint8Array([0x41, 0x42]))).toBe('AB');
  });
});

describe('pdf date codecs', () => {
  it('formats a Date as a UTC PDF date string', () => {
    const d = new Date(Date.UTC(2024, 5, 3, 12, 30, 45)); // 2024-06-03T12:30:45Z
    expect(formatPdfDate(d)).toBe("D:20240603123045+00'00'");
  });

  it('parses a Z-suffixed PDF date to a Date', () => {
    const d = parsePdfDate('D:20240603123045Z');
    expect(d instanceof Date).toBe(true);
    expect((d as Date).toISOString()).toBe('2024-06-03T12:30:45.000Z');
  });

  it('parses an offset PDF date to the correct UTC instant', () => {
    const d = parsePdfDate("D:20240603123045+05'00'");
    expect((d as Date).toISOString()).toBe('2024-06-03T07:30:45.000Z');
  });

  it('returns the raw string when unparseable', () => {
    expect(parsePdfDate('not a date')).toBe('not a date');
  });
});

const str = (s: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(s) });
const identity = (o: PdfObject | undefined): PdfObject => (o === undefined ? null : o);

describe('readMetadata', () => {
  it('maps standard keys to fields and others to custom', () => {
    const info: PdfDict = new Map<string, PdfObject>([
      ['Title', str('Hello')],
      ['Author', str('Ada')],
      ['CreationDate', str('D:20240603123045Z')],
      ['MyField', str('v1')],
    ]);
    const meta = readMetadata(info, identity);
    expect(meta.title).toBe('Hello');
    expect(meta.author).toBe('Ada');
    expect((meta.creationDate as Date).toISOString()).toBe('2024-06-03T12:30:45.000Z');
    expect(meta.custom).toEqual({ MyField: 'v1' });
  });

  it('returns empty metadata for undefined info', () => {
    expect(readMetadata(undefined, identity)).toEqual({ custom: {} });
  });
});

describe('applyUpdate', () => {
  it('merges set fields, leaves undefined, deletes on null', () => {
    const info: PdfDict = new Map<string, PdfObject>([
      ['Title', str('Old')],
      ['Author', str('Ada')],
    ]);
    const update: MetadataUpdate = { title: 'New', author: null, subject: undefined, custom: { K: 'V' } };
    applyUpdate(info, update);
    expect(isString(info.get('Title')) && decodeVal(info.get('Title'))).toBe('New');
    expect(info.has('Author')).toBe(false);
    expect(decodeVal(info.get('K'))).toBe('V');
  });

  it('formats a Date value for date fields', () => {
    const info: PdfDict = new Map<string, PdfObject>();
    applyUpdate(info, { creationDate: new Date(Date.UTC(2024, 0, 2, 3, 4, 5)) });
    expect(decodeVal(info.get('CreationDate'))).toBe("D:20240102030405+00'00'");
  });
});

function decodeVal(o: PdfObject | undefined): string {
  if (!o || (o as any).kind !== 'string') return '';
  return new TextDecoder('latin1').decode((o as any).bytes);
}
