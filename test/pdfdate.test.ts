import { describe, it, expect } from 'vitest';
import { pdfDateToIso, isoToPdfDate, isoInstant, sameInstant } from '../src/pdfdate.js';

describe('pdfDateToIso', () => {
  it.each([
    ['D:2024', '2024'],
    ['D:202406', '2024-06'],
    ['D:20240603', '2024-06-03'],
    ['D:2024060312', '2024-06-03T12:00'],
    ['D:202406031230', '2024-06-03T12:30'],
    ['D:20240603123045', '2024-06-03T12:30:45'],
    ['D:20240603123045Z', '2024-06-03T12:30:45Z'],
    ["D:20240603123045Z00'00'", '2024-06-03T12:30:45Z'],
    ["D:20240603123045+02'00'", '2024-06-03T12:30:45+02:00'],
    ["D:20240603123045+02'00", '2024-06-03T12:30:45+02:00'],
    ['D:20240603123045+02', '2024-06-03T12:30:45+02:00'],
    ["D:20240603123045-05'30'", '2024-06-03T12:30:45-05:30'],
    ['20240603123045Z', '2024-06-03T12:30:45Z'],
  ])('%s -> %s', (pdf, iso) => {
    expect(pdfDateToIso(pdf)).toBe(iso);
  });

  it.each([
    'garbage', 'D:', 'D:24', 'D:20241303', 'D:20240632', 'D:20240603250000',
    'D:20240603126000', 'D:20240603123060', "D:20240603123045+24'00'",
    "D:20240603123045+02'60'", 'D:2024Z', '2024-06-03',
  ])('refuses %s', (s) => {
    expect(pdfDateToIso(s)).toBeUndefined();
  });
});

describe('isoToPdfDate', () => {
  it.each([
    ['2024', 'D:2024'],
    ['2024-06', 'D:202406'],
    ['2024-06-03', 'D:20240603'],
    ['2024-06-03T12:30', 'D:202406031230'],
    ['2024-06-03T12:30:45', 'D:20240603123045'],
    ['2024-06-03T12:30:45Z', 'D:20240603123045Z'],
    ['2024-06-03T12:30:45.123Z', 'D:20240603123045Z'],
    ['2024-06-03T12:30:45+02:00', "D:20240603123045+02'00'"],
    ['2024-06-03T12:30-05:30', "D:202406031230-05'30'"],
  ])('%s -> %s', (iso, pdf) => {
    expect(isoToPdfDate(iso)).toBe(pdf);
  });

  it.each(['garbage', '2024-13', '2024-06-03T24:00', '2024-06-03T12', '2024-06-03Z',
    '2024-06-03T12:30:45+02', 'D:20240603'])('refuses %s', (s) => {
    expect(isoToPdfDate(s)).toBeUndefined();
  });
});

describe('round trip', () => {
  it.each([
    'D:20240603123045Z', "D:20240603123045+02'00'", "D:19991231235959-11'45'",
    'D:20240603123045', 'D:202406031230', 'D:20240603', 'D:2024',
  ])('D -> ISO -> D is exact for %s', (d) => {
    expect(isoToPdfDate(pdfDateToIso(d)!)).toBe(d);
  });
});

describe('isoInstant / sameInstant', () => {
  it('reads a TZD-less time as UTC and applies an offset', () => {
    expect(isoInstant('2024-06-03T12:30:45')).toBe(Date.UTC(2024, 5, 3, 12, 30, 45));
    expect(isoInstant('2024-06-03T14:30:45+02:00')).toBe(Date.UTC(2024, 5, 3, 12, 30, 45));
    expect(isoInstant('2024')).toBe(Date.UTC(2024, 0, 1));
  });

  it('keeps a year below 100 as written', () => {
    expect(new Date(isoInstant('0050-01-01')!).getUTCFullYear()).toBe(50);
  });

  it('treats one instant spelled two ways as the same, to the second', () => {
    expect(sameInstant('2024-06-03T12:30:45.000Z', '2024-06-03T12:30:45+00:00')).toBe(true);
    expect(sameInstant('2024-06-03T14:30:45+02:00', '2024-06-03T12:30:45Z')).toBe(true);
    expect(sameInstant('2024-06-03T12:30:45.900Z', '2024-06-03T12:30:45Z')).toBe(true);
    expect(sameInstant('2024-06-03T12:30:46Z', '2024-06-03T12:30:45Z')).toBe(false);
    expect(sameInstant('junk', '2024-06-03T12:30:45Z')).toBe(false);
  });
});

describe('o6uu.9 residue', () => {
  // metadata.ts's parsePdfDate reads an offset with no apostrophes; the
  // text-to-text grammar must too, or such a date is skipped by SyncMetadata.
  it.each([
    ['D:20240603123045+0200', '2024-06-03T12:30:45+02:00'],
    ['D:20240603123045-0530', '2024-06-03T12:30:45-05:30'],
    ["D:20240603123045+02'", '2024-06-03T12:30:45+02:00'],
  ])('reads the offset in %s', (pdf, iso) => expect(pdfDateToIso(pdf)).toBe(iso));

  it('still refuses a malformed offset', () => {
    expect(pdfDateToIso('D:20240603123045+020')).toBeUndefined();
  });

  it('checks the day against its month and leap year, in both grammars', () => {
    expect(pdfDateToIso('D:20240231')).toBeUndefined();
    expect(pdfDateToIso('D:20240431')).toBeUndefined();
    expect(pdfDateToIso('D:20230229')).toBeUndefined();
    expect(pdfDateToIso('D:20240229')).toBe('2024-02-29');
    expect(pdfDateToIso('D:20000229')).toBe('2000-02-29');
    expect(pdfDateToIso('D:19000229')).toBeUndefined();
    expect(pdfDateToIso('D:20241231')).toBe('2024-12-31');
    expect(isoToPdfDate('2024-02-30')).toBeUndefined();
    expect(isoInstant('2024-02-30')).toBeUndefined();
    expect(isoInstant('2024-02-29T00:00:00Z')).toBe(Date.UTC(2024, 1, 29));
  });
});
