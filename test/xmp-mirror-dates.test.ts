import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { decodePdfText } from '../src/metadata.js';
import { inflateStream } from '../src/flate.js';
import { isStream, isString } from '../src/types.js';
import { parseRdfPacket } from '../src/xmprdf.js';

const XMP = 'http://ns.adobe.com/xap/1.0/';
const doc1 = () => { const d = Document.New(); d.AddPage(PageFormat.A4); return d; };
const xmpText = (d: Document, name: string): string | undefined => {
  const md = d.resolve(d.catalog().get('Metadata'));
  if (!isStream(md)) return undefined;
  const p = parseRdfPacket(inflateStream(md)).properties.find((q) => q.ns === XMP && q.name === name);
  return p?.value.kind === 'simple' ? p.value.value : undefined;
};
const infoText = (d: Document, key: string): string | undefined => {
  const v = d.resolve(d.ensureInfo().get(key));
  return isString(v) ? decodePdfText(v.bytes) : undefined;
};

describe('date mirrors', () => {
  it('SetMetadata converts a D: string before writing it to XMP', () => {
    const d = doc1();
    d.SetMetadata({ creationDate: "D:20240603123045+02'00'", modDate: 'D:20240603Z' });
    expect(xmpText(d, 'CreateDate')).toBe('2024-06-03T12:30:45+02:00');
    // A zone with no time does not read, so it passes through as before.
    expect(xmpText(d, 'ModifyDate')).toBe('D:20240603Z');
  });

  it('SetXmp converts an ISO string before writing it to /Info', () => {
    const d = doc1();
    d.SetXmp({ createDate: '2024-06-03T12:30:45-05:30' });
    expect(infoText(d, 'CreationDate')).toBe("D:20240603123045-05'30'");
  });

  it('writes a date string given in the OTHER side\'s syntax in this side\'s syntax', () => {
    // An ISO string handed to SetMetadata is not a D: date and would be an
    // invalid /CreationDate; a D: string handed to SetXmp is not an XMP date.
    const d = doc1();
    d.SetMetadata({ creationDate: '2024-06-03' });
    expect(infoText(d, 'CreationDate')).toBe('D:20240603');
    expect(xmpText(d, 'CreateDate')).toBe('2024-06-03');
    const e = doc1();
    e.SetXmp({ createDate: 'D:20240603123045Z' });
    expect(xmpText(e, 'CreateDate')).toBe('2024-06-03T12:30:45Z');
    expect(infoText(e, 'CreationDate')).toBe('D:20240603123045Z');
  });

  it('leaves a date string that reads in neither syntax exactly as given', () => {
    const d = doc1();
    d.SetMetadata({ modDate: 'yesterday' });
    expect(infoText(d, 'ModDate')).toBe('yesterday');
    expect(xmpText(d, 'ModifyDate')).toBe('yesterday');
  });

  it('leaves the Date-object path byte-identical', () => {
    const at = new Date(Date.UTC(2024, 5, 3, 12, 30, 45));
    const d = doc1();
    d.SetMetadata({ creationDate: at });
    expect(xmpText(d, 'CreateDate')).toBe('2024-06-03T12:30:45.000Z');
    expect(infoText(d, 'CreationDate')).toBe("D:20240603123045+00'00'");
    const e = doc1();
    e.SetXmp({ modifyDate: at });
    expect(infoText(e, 'ModDate')).toBe("D:20240603123045+00'00'");
  });
});
