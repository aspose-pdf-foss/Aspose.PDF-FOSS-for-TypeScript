import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import { encodeSeedValue, readSeedValue, type SeedValue, type SeedRequirement } from '../src/sigseed.js';
import { isDict, isRef, isName, name, PdfDict, PdfObject } from '../src/types.js';

const RECT: [number, number, number, number] = [20, 120, 180, 170];
const ident = (o: PdfObject) => o;
const str = (s: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(s) });

/** Create a field carrying `sv`, save, reopen and read it back. */
function roundTrip(sv: SeedValue): SeedValue | undefined {
  const doc = Document.Open(buildClassicPdf(1));
  doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'S', seedValue: sv });
  const back = Document.Open(doc.Save());
  return back.Signatures[0].seedValue;
}

/** The raw /SV dict of field S after a save/reopen, and whether it was a ref. */
function rawSv(sv: SeedValue): { dict: PdfDict; indirect: boolean; doc: Document } {
  const doc = Document.Open(buildClassicPdf(1));
  doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'S', seedValue: sv });
  const back = Document.Open(doc.Save());
  const raw = back.Form.Get('S')!.Dict.get('SV');
  const dict = back.resolve(raw);
  if (!isDict(dict)) throw new Error('no /SV');
  return { dict, indirect: isRef(raw), doc: back };
}

describe('seed value round trip (puep.2)', () => {
  it('round-trips every entry, typed, with the required set intact', () => {
    const sv: SeedValue = {
      filter: 'Adobe.PPKLite',
      subFilter: ['ETSI.CAdES.detached', 'adbe.pkcs7.detached'],
      digestMethod: ['SHA256', 'SHA512'],
      v: 2,
      reasons: ['I approve', 'I have reviewed'],
      legalAttestation: ['No JavaScript'],
      appearanceFilter: 'Company stamp',
      addRevInfo: true,
      lockDocument: 'auto',
      mdp: 'form-fill',
      timestamp: { url: 'https://tsa.example/rfc3161', required: true },
      // /Ff is a bit set, so `required` reads back in BIT order.
      required: ['subFilter', 'reasons', 'digestMethod', 'lockDocument'],
    };
    expect(roundTrip(sv)).toEqual(sv);
  });

  it('reads nothing back when the field carries no /SV', () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'S' });
    const back = Document.Open(doc.Save());
    expect(back.Signatures[0].seedValue).toBeUndefined();
    expect(back.Form.Get('S')!.Dict.has('SV')).toBe(false);
  });

  it('reads an empty seed value as {} and a timestamp without /Ff as not required', () => {
    expect(roundTrip({})).toEqual({});
    expect(roundTrip({ timestamp: { url: 'https://t' } })).toEqual({ timestamp: { url: 'https://t', required: false } });
  });

  it('writes /SV as an indirect object carrying /Type /SV', () => {
    const { dict, indirect } = rawSv({ reasons: ['x'] });
    expect(indirect).toBe(true);
    const t = dict.get('Type');
    expect(isName(t) && t.name).toBe('SV');
  });

  it('writes no /Ff and no /V unless asked', () => {
    const { dict } = rawSv({ reasons: ['x'] });
    expect(dict.has('Ff')).toBe(false);
    expect(dict.has('V')).toBe(false);
  });

  // The bits are a transcription; a transposed pair round-trips perfectly, so
  // each is pinned to its published value alone (PDFBox PDSeedValue.FLAG_*,
  // pyHanko SigSeedValFlags).
  const BIT: Array<[SeedRequirement, number, SeedValue]> = [
    ['filter', 1, { filter: 'Adobe.PPKLite' }],
    ['subFilter', 2, { subFilter: ['adbe.pkcs7.detached'] }],
    ['v', 4, { v: 1 }],
    ['reasons', 8, { reasons: ['r'] }],
    ['legalAttestation', 16, { legalAttestation: ['a'] }],
    ['addRevInfo', 32, { addRevInfo: false }],
    ['digestMethod', 64, { digestMethod: ['SHA256'] }],
    ['lockDocument', 128, { lockDocument: 'true' }],
    ['appearanceFilter', 256, { appearanceFilter: 'n' }],
  ];
  for (const [req, bit, sv] of BIT) {
    it(`requires ${req} through /Ff bit value ${bit}`, () => {
      expect(rawSv({ ...sv, required: [req] }).dict.get('Ff')).toBe(bit);
    });
  }

  it('writes /MDP /P for each signature type, both directions', () => {
    const cases: Array<[NonNullable<SeedValue['mdp']>, number]> = [
      ['approval', 0], ['no-changes', 1], ['form-fill', 2], ['form-fill-and-annotate', 3],
    ];
    for (const [mdp, p] of cases) {
      const { dict, doc } = rawSv({ mdp });
      const m = doc.resolve(dict.get('MDP'));
      expect(isDict(m) && m.get('P')).toBe(p);
      expect(readSeedValue(ident, dict)?.mdp).toBe(mdp);
    }
  });

  it('writes a timestamp dict with /URL and /Ff 1 when required', () => {
    const { dict, doc } = rawSv({ timestamp: { url: 'https://t', required: true } });
    const ts = doc.resolve(dict.get('TimeStamp'));
    expect(isDict(ts) && ts.get('Ff')).toBe(1);
  });

  it('writes digest methods and subfilters as names', () => {
    const { dict } = rawSv({ digestMethod: ['SHA384'], subFilter: ['adbe.pkcs7.detached'], filter: 'Adobe.PPKLite' });
    const dm = dict.get('DigestMethod') as PdfObject[];
    expect(isName(dm[0]) && dm[0].name).toBe('SHA384');
    const sf = dict.get('SubFilter') as PdfObject[];
    expect(isName(sf[0]) && sf[0].name).toBe('adbe.pkcs7.detached');
    const f = dict.get('Filter');
    expect(isName(f) && f.name).toBe('Adobe.PPKLite');
  });

  it('round-trips non-ASCII reasons', () => {
    expect(roundTrip({ reasons: ['Одобрено', '承認'] })?.reasons).toEqual(['Одобрено', '承認']);
  });
});

describe('seed value refusals leave the document byte-identical (puep.2)', () => {
  const bad: Array<[string, unknown, ErrorConstructor]> = [
    ['required names an absent entry', { required: ['reasons'] }, RangeError],
    ['required names mdp', { mdp: 'approval', required: ['mdp'] }, RangeError],
    ['required repeats an entry', { reasons: ['r'], required: ['reasons', 'reasons'] }, RangeError],
    ['required is not an array', { required: 'reasons' }, TypeError],
    ['unknown digest method', { digestMethod: ['MD5'] }, RangeError],
    ['empty digest list', { digestMethod: [] }, RangeError],
    ['empty subFilter list', { subFilter: [] }, RangeError],
    ['non-string reason', { reasons: [1] }, TypeError],
    ['non-integer v', { v: 1.5 }, RangeError],
    ['zero v', { v: 0 }, RangeError],
    ['unknown lockDocument', { lockDocument: 'yes' }, RangeError],
    ['unknown mdp', { mdp: 'certify' }, RangeError],
    ['empty timestamp url', { timestamp: { url: '' } }, RangeError],
    ['non-boolean addRevInfo', { addRevInfo: 'true' }, TypeError],
    ['empty filter', { filter: '' }, RangeError],
    ['not an object', 'x', TypeError],
  ];
  for (const [label, sv, err] of bad) {
    it(`refuses: ${label}`, () => {
      const doc = Document.Open(buildClassicPdf(1));
      const before = doc.Save();
      expect(() => doc.Form.AddSignatureField({
        page: 1, rect: RECT, name: 'S', seedValue: sv as SeedValue,
      })).toThrow(err);
      expect(doc.Save()).toEqual(before);
    });
  }

  it('an empty reasons list and an empty-string reason are accepted verbatim', () => {
    expect(roundTrip({ reasons: [] })?.reasons).toEqual([]);
    expect(roundTrip({ reasons: [''] })?.reasons).toEqual(['']);
  });
});

describe('readSeedValue is lenient (puep.2)', () => {
  const sv = (entries: Array<[string, PdfObject]>): PdfDict => new Map(entries);

  it('drops wrong-typed entries rather than throwing', () => {
    const d = sv([
      ['Filter', str('Adobe.PPKLite')],          // a string, not a name
      ['SubFilter', name('adbe.pkcs7.detached')], // not an array
      ['V', str('2')],
      ['Reasons', [str('ok'), 5]],                 // mixed: whole entry dropped
      ['AddRevInfo', 1],
      ['LockDocument', name('maybe')],
      ['MDP', new Map<string, PdfObject>([['P', 7]])],
      ['TimeStamp', new Map<string, PdfObject>([['URL', 5]])],
      ['AppearanceFilter', name('x')],
    ]);
    expect(readSeedValue(ident, d)).toEqual({});
  });

  it('reads /DigestMethod written as strings, as pyHanko writes it', () => {
    const d = sv([['DigestMethod', [str('SHA256'), str('sha512')]]]);
    expect(readSeedValue(ident, d)?.digestMethod).toEqual(['SHA256', 'SHA512']);
  });

  it('drops a digest method outside the known set but keeps the rest', () => {
    const d = sv([['DigestMethod', [name('SHA256'), name('MD5')]]]);
    expect(readSeedValue(ident, d)?.digestMethod).toEqual(['SHA256']);
  });

  it('reports every stated /Ff bit it knows, and drops unknown bits', () => {
    const d = sv([['Ff', 1 | 64 | 1024]]);
    expect(readSeedValue(ident, d)?.required).toEqual(['filter', 'digestMethod']);
  });

  it('reads a /Ff naming no known bit as no required list', () => {
    expect(readSeedValue(ident, sv([['Ff', 0]]))?.required).toBeUndefined();
  });

  it('answers undefined for something that is not a dict', () => {
    expect(readSeedValue(ident, 5)).toBeUndefined();
    expect(readSeedValue(ident, null)).toBeUndefined();
  });

  it('encodes and reads back through the pure pair alone', () => {
    const v: SeedValue = { reasons: ['a'], mdp: 'approval', required: ['reasons'] };
    expect(readSeedValue(ident, encodeSeedValue(v))).toEqual(v);
  });
});
