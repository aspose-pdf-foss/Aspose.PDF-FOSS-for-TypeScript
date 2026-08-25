import { describe, it, expect } from 'vitest';
import { der, parse, readInteger, readOid, Tag, OID, oidName } from '../src/asn1.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('der primitive + structural encoders', () => {
  it('octetString wraps raw bytes (tag 04)', () => {
    expect(hex(der.octetString(Uint8Array.of(1, 2, 3)))).toBe('0403010203');
  });
  it('bitString prepends the unused-bits count (tag 03)', () => {
    expect(hex(der.bitString(Uint8Array.of(0x0a, 0x3b)))).toBe('0303000a3b');
  });
  it('null is 05 00', () => {
    expect(hex(der.null_())).toBe('0500');
  });
  it('boolean true is 01 01 ff, false is 01 01 00', () => {
    expect(hex(der.boolean(true))).toBe('0101ff');
    expect(hex(der.boolean(false))).toBe('010100');
  });
  it('sequence wraps children (tag 30, constructed)', () => {
    expect(hex(der.sequence(der.integer(1)))).toBe('3003020101');
  });
  it('set wraps children (tag 31, constructed)', () => {
    expect(hex(der.set(der.integer(1)))).toBe('3103020101');
  });
  it('explicit [0] context tag wraps a child (tag a0)', () => {
    expect(hex(der.explicit(0, der.integer(1)))).toBe('a003020101');
  });
});

describe('der string + time encoders', () => {
  const ascii = (s: string) => Buffer.from(s, 'latin1').toString('hex');
  it('utf8String (tag 0c)', () => {
    expect(hex(der.utf8String('AB'))).toBe('0c02' + ascii('AB'));
  });
  it('printableString (tag 13)', () => {
    expect(hex(der.printableString('AB'))).toBe('1302' + ascii('AB'));
  });
  it('ia5String (tag 16)', () => {
    expect(hex(der.ia5String('AB'))).toBe('1602' + ascii('AB'));
  });
  it('utcTime formats YYMMDDHHMMSSZ (tag 17)', () => {
    const d = new Date(Date.UTC(2026, 5, 23, 15, 0, 0));
    expect(hex(der.utcTime(d))).toBe('170d' + ascii('260623150000Z'));
  });
  it('generalizedTime formats YYYYMMDDHHMMSSZ (tag 18)', () => {
    const d = new Date(Date.UTC(2026, 5, 23, 15, 0, 0));
    expect(hex(der.generalizedTime(d))).toBe('180f' + ascii('20260623150000Z'));
  });
});

describe('der.oid', () => {
  it('encodes rsaEncryption 1.2.840.113549.1.1.1', () => {
    expect(hex(der.oid('1.2.840.113549.1.1.1'))).toBe('06092a864886f70d010101');
  });
  it('encodes sha256 2.16.840.1.101.3.4.2.1', () => {
    expect(hex(der.oid('2.16.840.1.101.3.4.2.1'))).toBe('0609608648016503040201');
  });
  it('combines the first two arcs (40*a + b)', () => {
    expect(hex(der.oid('1.2'))).toBe('06012a');
  });
});

describe('der.integer', () => {
  it('encodes 0 as 02 01 00', () => {
    expect(hex(der.integer(0))).toBe('020100');
  });
  it('encodes 127 as 02 01 7f', () => {
    expect(hex(der.integer(127))).toBe('02017f');
  });
  it('pads when high bit set: 128 -> 02 02 00 80', () => {
    expect(hex(der.integer(128))).toBe('02020080');
  });
  it('encodes 256 as 02 02 01 00', () => {
    expect(hex(der.integer(256))).toBe('02020100');
  });
  it('encodes bigint values', () => {
    expect(hex(der.integer(0x0102030405060708n))).toBe('02080102030405060708');
  });
});

describe('parse (DER decoder)', () => {
  it('parses a SEQUENCE into typed children', () => {
    const node = parse(der.sequence(der.integer(1), der.integer(256)));
    expect(node.tag).toBe(Tag.SEQUENCE);
    expect(node.constructed).toBe(true);
    expect(node.children.length).toBe(2);
    expect(readInteger(node.children[0])).toBe(1n);
    expect(readInteger(node.children[1])).toBe(256n);
  });
  it('round-trips a large INTEGER', () => {
    expect(readInteger(parse(der.integer(0x0102030405060708n)))).toBe(0x0102030405060708n);
  });
  it('round-trips an OID', () => {
    expect(readOid(parse(der.oid('1.2.840.113549.1.1.1')))).toBe('1.2.840.113549.1.1.1');
  });
  it('decodes long-form lengths (content > 127 bytes)', () => {
    const big = new Uint8Array(200).fill(0xab);
    const node = parse(der.octetString(big));
    expect(node.tag).toBe(Tag.OCTET_STRING);
    expect(node.length).toBe(200);
    expect(node.content.length).toBe(200);
  });
  it('identifies context-specific tags', () => {
    const node = parse(der.explicit(0, der.integer(7)));
    expect(node.tagClass).toBe(2); // context-specific
    expect(node.constructed).toBe(true);
    expect(node.tag).toBe(0);
    expect(readInteger(node.children[0])).toBe(7n);
  });
});

describe('OID registry', () => {
  it('exposes named OIDs used by CMS/X.509', () => {
    expect(OID.rsaEncryption).toBe('1.2.840.113549.1.1.1');
    expect(OID.sha256).toBe('2.16.840.1.101.3.4.2.1');
    expect(OID.signedData).toBe('1.2.840.113549.1.7.2');
    expect(OID.messageDigest).toBe('1.2.840.113549.1.9.4');
  });
  it('reverse-looks-up a dotted OID to its name', () => {
    expect(oidName('2.16.840.1.101.3.4.2.1')).toBe('sha256');
    expect(oidName('1.2.840.113549.1.7.2')).toBe('signedData');
  });
  it('returns undefined for unknown OIDs', () => {
    expect(oidName('9.9.9')).toBeUndefined();
  });
});

describe('parse node.raw', () => {
  it('exposes the exact TLV bytes of a node and its children', () => {
    const inner = der.integer(256);
    const node = parse(der.sequence(inner));
    expect(hex(node.children[0].raw)).toBe(hex(inner));
  });
});
