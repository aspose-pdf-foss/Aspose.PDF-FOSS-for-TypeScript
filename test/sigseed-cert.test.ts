import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner } from './helpers/build-signer.js';
import { Document } from '../src/document.js';
import {
  encodeSeedValue, readSeedValue, type SeedValue, type SeedCertValue, type SeedCertRequirement,
} from '../src/sigseed.js';
import { isDict, isName, isString, name, PdfDict, PdfObject } from '../src/types.js';

const RECT: [number, number, number, number] = [20, 120, 180, 170];
const ident = (o: PdfObject) => o;
const str = (s: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(s) });
const certA = buildSigner({ commonName: 'Allowed' }).certificate;
const certCA = buildSigner({ commonName: 'Some CA' }).certificate;

function roundTrip(cert: SeedCertValue): SeedCertValue | undefined {
  const doc = Document.Open(buildClassicPdf(1));
  doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'S', seedValue: { cert } });
  return Document.Open(doc.Save()).Signatures[0].seedValue?.cert;
}

/** The /Cert dict encodeSeedValue writes for `cert`. */
function certDict(cert: SeedCertValue): PdfDict {
  const d = encodeSeedValue({ cert }).get('Cert');
  if (!isDict(d)) throw new Error('no /Cert');
  return d;
}

describe('seedValue.cert round trip (puep.6)', () => {
  it('round-trips every entry, typed, with its own required set', () => {
    const cert: SeedCertValue = {
      subject: [certA],
      issuer: [certCA],
      subjectDN: [{ CN: 'Jane Roe', O: 'Acme' }, { OU: 'Legal' }],
      keyUsage: [
        { required: ['digitalSignature', 'nonRepudiation'], forbidden: ['keyEncipherment'] },
        { required: ['decipherOnly'] },
      ],
      url: 'https://ca.example/enrol',
      urlType: 'Browser',
      required: ['subject', 'subjectDN', 'keyUsage'],   // bit order
    };
    expect(roundTrip(cert)).toEqual(cert);
  });

  it('writes /Cert as /Type /SVCert, with no /Ff and no /URLType unless asked', () => {
    const d = certDict({ url: 'https://x' });
    expect(isName(d.get('Type')) && (d.get('Type') as { name: string }).name).toBe('SVCert');
    expect(d.has('Ff')).toBe(false);
    expect(d.has('URLType')).toBe(false);
  });

  it('keeps certificates as raw BYTE strings, not text', () => {
    const s = certDict({ subject: [certA] }).get('Subject') as PdfObject[];
    expect(isString(s[0]) && Buffer.from(s[0].bytes).equals(Buffer.from(certA))).toBe(true);
  });

  // Transcribed from pyHanko's SigCertConstraintFlags; each pinned alone.
  const BIT: Array<[SeedCertRequirement, number, SeedCertValue]> = [
    ['subject', 1, { subject: [certA] }],
    ['issuer', 2, { issuer: [certCA] }],
    ['subjectDN', 8, { subjectDN: [{ CN: 'x' }] }],
    ['keyUsage', 32, { keyUsage: [{ required: ['digitalSignature'] }] }],
    ['url', 64, { url: 'https://x' }],
  ];
  for (const [req, bit, cert] of BIT) {
    it(`requires ${req} through /Ff bit value ${bit}`, () => {
      expect(certDict({ ...cert, required: [req] }).get('Ff')).toBe(bit);
    });
  }
});

describe('/KeyUsage strings — Table 235, RFC 5280 bit order (puep.6)', () => {
  it('encodes 1 = required, 0 = forbidden, X = either, nine positions', () => {
    const ku = certDict({
      keyUsage: [{ required: ['digitalSignature', 'decipherOnly'], forbidden: ['nonRepudiation', 'cRLSign'] }],
    }).get('KeyUsage') as PdfObject[];
    expect(new TextDecoder().decode((ku[0] as { bytes: Uint8Array }).bytes)).toBe('10XXXX0X1');
  });

  it('refuses a usage both required and forbidden', () => {
    expect(() => certDict({ keyUsage: [{ required: ['keyAgreement'], forbidden: ['keyAgreement'] }] }))
      .toThrow(RangeError);
  });

  it('reads a short string as X for the missing positions, and a long one to nine', () => {
    const d = (s: string): PdfDict => new Map<string, PdfObject>([['Cert', new Map([['KeyUsage', [str(s)]]])]]);
    expect(readSeedValue(ident, d('01'))?.cert?.keyUsage).toEqual([{ required: ['nonRepudiation'], forbidden: ['digitalSignature'] }]);
    expect(readSeedValue(ident, d('XXXXXXXX11'))?.cert?.keyUsage).toEqual([{ required: ['decipherOnly'] }]);
  });

  it('drops an entry with a character that is not 0, 1 or X, keeping the rest', () => {
    const d: PdfDict = new Map<string, PdfObject>([['Cert', new Map([['KeyUsage', [str('1Y'), str('1')]]])]]);
    expect(readSeedValue(ident, d)?.cert?.keyUsage).toEqual([{ required: ['digitalSignature'] }]);
  });
});

describe('seedValue.cert refusals leave the document byte-identical (puep.6)', () => {
  const bad: Array<[string, unknown, ErrorConstructor]> = [
    ['not an object', 'x', TypeError],
    ['required names an absent entry', { required: ['subject'] }, RangeError],
    ['required names oid', { required: ['oid'] }, RangeError],
    ['required repeats', { url: 'u', required: ['url', 'url'] }, RangeError],
    ['a certificate that is not bytes', { subject: ['MII...'] }, TypeError],
    ['an empty certificate', { issuer: [new Uint8Array(0)] }, RangeError],
    ['an empty subject list', { subject: [] }, RangeError],
    ['an empty DN entry', { subjectDN: [{}] }, RangeError],
    ['a DN value that is not a string', { subjectDN: [{ CN: 5 }] }, TypeError],
    ['an unknown key usage', { keyUsage: [{ required: ['signEverything'] }] }, RangeError],
    ['an empty key usage entry', { keyUsage: [{}] }, RangeError],
    ['an empty url', { url: '' }, RangeError],
    ['a urlType with no url', { urlType: 'Browser' }, RangeError],
  ];
  for (const [label, cert, err] of bad) {
    it(`refuses: ${label}`, () => {
      const doc = Document.Open(buildClassicPdf(1));
      const before = doc.Save();
      expect(() => doc.Form.AddSignatureField({
        page: 1, rect: RECT, name: 'S', seedValue: { cert: cert as SeedCertValue },
      })).toThrow(err);
      expect(doc.Save()).toEqual(before);
    });
  }
});

describe('a foreign /Cert reads leniently (puep.6)', () => {
  it('drops wrong-typed entries, the unsupported /OID and unknown bits', () => {
    const cert: PdfDict = new Map<string, PdfObject>([
      ['Subject', name('x')],                                  // not an array
      ['Issuer', [str('a'), 5]],                               // mixed: dropped
      ['SubjectDN', [new Map<string, PdfObject>([['CN', 5]])]], // non-string value: dropped
      ['URL', name('u')],
      ['OID', [str('1.2.3')]],
      ['Ff', 1 | 4 | 16 | 128],
    ]);
    const sv: SeedValue | undefined = readSeedValue(ident, new Map([['Cert', cert]]));
    expect(sv?.cert).toEqual({ required: ['subject'] });
  });

  it('reads a /Cert that is not a dict as no cert constraint', () => {
    expect(readSeedValue(ident, new Map([['Cert', 5]]))?.cert).toBeUndefined();
  });

  it('reports no /URLType when none is stated, rather than the spec default', () => {
    expect(roundTrip({ url: 'https://x' })).toEqual({ url: 'https://x' });
  });

  it('keeps a stated /URLType verbatim', () => {
    const cert: PdfDict = new Map<string, PdfObject>([['URL', str('https://x')], ['URLType', name('ASSP')]]);
    expect(readSeedValue(ident, new Map([['Cert', cert]]))?.cert).toEqual({ url: 'https://x', urlType: 'ASSP' });
  });
});
