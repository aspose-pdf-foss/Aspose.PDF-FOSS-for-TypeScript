// Minimal DER (Distinguished Encoding Rules) encoder/decoder for the digital
// signature stack (CMS/PKCS#7, X.509, PKCS#12, RFC 3161, OCSP, CRL). Covers the
// subset of ASN.1 those formats use: INTEGER, OID, OCTET/BIT STRING, NULL,
// BOOLEAN, the common string/time types, SEQUENCE/SET, and context-tagged
// values. Zero runtime dependencies.

// Universal tag numbers (low 5 bits of the identifier octet).
export const Tag = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8String: 0x0c,
  SEQUENCE: 0x10,
  SET: 0x11,
  PrintableString: 0x13,
  IA5String: 0x16,
  UTCTime: 0x17,
  GeneralizedTime: 0x18,
} as const;

const CONSTRUCTED = 0x20;

/** Named OIDs used across the CMS/X.509/PKCS#12/RFC3161 signature stack. */
export const OID = {
  // algorithms
  rsaEncryption: '1.2.840.113549.1.1.1',
  rsaPss: '1.2.840.113549.1.1.10',
  rsaesOaep: '1.2.840.113549.1.1.7',
  mgf1: '1.2.840.113549.1.1.8',
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
  ecdsaWithSHA384: '1.2.840.10045.4.3.3',
  ecdsaWithSHA512: '1.2.840.10045.4.3.4',
  ed25519: '1.3.101.112',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  // PKCS#7 / CMS content types
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  envelopedData: '1.2.840.113549.1.7.3',
  aes128CBC: '2.16.840.1.101.3.4.1.2',
  // ECDH-ES key agreement (RFC 5753) + AES key wrap (RFC 3394)
  dhSinglePassStdDHsha1: '1.3.133.16.840.63.0.2', // X9.63; openssl's default KDF
  dhSinglePassStdDHsha256: '1.3.132.1.11.1',
  dhSinglePassStdDHsha384: '1.3.132.1.11.2',
  dhSinglePassStdDHsha512: '1.3.132.1.11.3',
  aes128Wrap: '2.16.840.1.101.3.4.1.5',
  aes192Wrap: '2.16.840.1.101.3.4.1.25',
  aes256Wrap: '2.16.840.1.101.3.4.1.45',
  // CMS signed attributes
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  // RFC 3161 timestamping
  tstInfo: '1.2.840.113549.1.9.16.1.4',          // id-ct-TSTInfo (eContentType)
  timeStampToken: '1.2.840.113549.1.9.16.2.14',  // id-aa-timeStampToken (unsigned attr)
  // CAdES signed attributes
  commitmentTypeIndication: '1.2.840.113549.1.9.16.2.16', // id-aa-ets-commitmentType
  signerLocation: '1.2.840.113549.1.9.16.2.17',           // id-aa-ets-signerLocation
  ctiProofOfOrigin: '1.2.840.113549.1.9.16.6.1',
  ctiProofOfReceipt: '1.2.840.113549.1.9.16.6.2',
  ctiProofOfDelivery: '1.2.840.113549.1.9.16.6.3',
  ctiProofOfSender: '1.2.840.113549.1.9.16.6.4',
  ctiProofOfApproval: '1.2.840.113549.1.9.16.6.5',
  ctiProofOfCreation: '1.2.840.113549.1.9.16.6.6',
} as const;

const OID_NAMES: ReadonlyMap<string, string> =
  new Map(Object.entries(OID).map(([name, dotted]) => [dotted, name]));

/** Reverse-lookup a dotted OID to its registered name, or undefined. */
export function oidName(dotted: string): string | undefined {
  return OID_NAMES.get(dotted);
}

function encodeLength(len: number): Uint8Array {
  if (len < 0x80) return Uint8Array.of(len);
  const bytes: number[] = [];
  for (let n = len; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Wrap `content` in a TLV with the given identifier octet. */
function tlv(identifier: number, content: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(identifier), encodeLength(content.length), content]);
}

function intContent(value: number | bigint): Uint8Array {
  let v = typeof value === 'bigint' ? value : BigInt(value);
  if (v < 0n) throw new Error('der.integer: negative values not supported');
  const bytes: number[] = [];
  do { bytes.unshift(Number(v & 0xffn)); v >>= 8n; } while (v > 0n);
  if (bytes[0] & 0x80) bytes.unshift(0x00); // keep sign positive
  return Uint8Array.from(bytes);
}

function base128(n: number): number[] {
  const out = [n & 0x7f];
  for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) out.unshift((v & 0x7f) | 0x80);
  return out;
}

function oidContent(dotted: string): Uint8Array {
  const arcs = dotted.split('.').map(Number);
  if (arcs.length < 2) throw new Error(`der.oid: need at least two arcs: ${dotted}`);
  const bytes: number[] = base128(arcs[0] * 40 + arcs[1]);
  for (let i = 2; i < arcs.length; i++) bytes.push(...base128(arcs[i]));
  return Uint8Array.from(bytes);
}

export const der = {
  integer(value: number | bigint): Uint8Array {
    return tlv(Tag.INTEGER, intContent(value));
  },
  oid(dotted: string): Uint8Array {
    return tlv(Tag.OID, oidContent(dotted));
  },
  octetString(bytes: Uint8Array): Uint8Array {
    return tlv(Tag.OCTET_STRING, bytes);
  },
  bitString(bytes: Uint8Array, unusedBits = 0): Uint8Array {
    return tlv(Tag.BIT_STRING, concat([Uint8Array.of(unusedBits), bytes]));
  },
  null_(): Uint8Array {
    return tlv(Tag.NULL, new Uint8Array(0));
  },
  boolean(value: boolean): Uint8Array {
    return tlv(Tag.BOOLEAN, Uint8Array.of(value ? 0xff : 0x00));
  },
  sequence(...children: Uint8Array[]): Uint8Array {
    return tlv(CONSTRUCTED | Tag.SEQUENCE, concat(children));
  },
  set(...children: Uint8Array[]): Uint8Array {
    return tlv(CONSTRUCTED | Tag.SET, concat(children));
  },
  /** Explicit (constructed) context-specific tag [n] wrapping one encoded value. */
  explicit(tagNumber: number, ...children: Uint8Array[]): Uint8Array {
    return tlv(0x80 | CONSTRUCTED | tagNumber, concat(children));
  },
  utf8String(s: string): Uint8Array {
    return tlv(Tag.UTF8String, utf8(s));
  },
  printableString(s: string): Uint8Array {
    return tlv(Tag.PrintableString, latin1(s));
  },
  ia5String(s: string): Uint8Array {
    return tlv(Tag.IA5String, latin1(s));
  },
  utcTime(date: Date): Uint8Array {
    const z = (n: number) => String(n).padStart(2, '0');
    const s = z(date.getUTCFullYear() % 100) + z(date.getUTCMonth() + 1) + z(date.getUTCDate())
      + z(date.getUTCHours()) + z(date.getUTCMinutes()) + z(date.getUTCSeconds()) + 'Z';
    return tlv(Tag.UTCTime, latin1(s));
  },
  generalizedTime(date: Date): Uint8Array {
    const z = (n: number) => String(n).padStart(2, '0');
    const s = String(date.getUTCFullYear()).padStart(4, '0') + z(date.getUTCMonth() + 1) + z(date.getUTCDate())
      + z(date.getUTCHours()) + z(date.getUTCMinutes()) + z(date.getUTCSeconds()) + 'Z';
    return tlv(Tag.GeneralizedTime, latin1(s));
  },
};

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export interface Asn1Node {
  tagClass: number;      // 0=universal, 1=application, 2=context, 3=private
  constructed: boolean;
  tag: number;           // tag number (low bits of the identifier)
  length: number;        // content length in bytes
  content: Uint8Array;   // view over the value bytes
  raw: Uint8Array;       // view over the full TLV (identifier..content)
  end: number;           // absolute offset just past this TLV
  children: Asn1Node[];  // parsed sub-nodes when constructed (else empty)
}

/** Parse a single DER TLV starting at `offset`. Constructed nodes recurse. */
export function parse(bytes: Uint8Array, offset = 0): Asn1Node {
  const id = bytes[offset];
  const tagClass = id >> 6;
  const constructed = (id & CONSTRUCTED) !== 0;
  let tag = id & 0x1f;
  let pos = offset + 1;
  if (tag === 0x1f) { // high-tag-number form
    tag = 0;
    let b: number;
    do { b = bytes[pos++]; tag = (tag << 7) | (b & 0x7f); } while (b & 0x80);
  }
  let length = bytes[pos++];
  if (length & 0x80) {
    const n = length & 0x7f;
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + bytes[pos++];
  }
  const content = bytes.subarray(pos, pos + length);
  const end = pos + length;
  const raw = bytes.subarray(offset, end);
  const children: Asn1Node[] = [];
  if (constructed) {
    let p = pos;
    while (p < end) { const child = parse(bytes, p); children.push(child); p = child.end; }
  }
  return { tagClass, constructed, tag, length, content, raw, end, children };
}

/** Read a (non-negative) INTEGER node's value as a bigint. */
export function readInteger(node: Asn1Node): bigint {
  let v = 0n;
  for (const b of node.content) v = (v << 8n) | BigInt(b);
  return v;
}

/** Read an OID node's value as a dotted string. */
export function readOid(node: Asn1Node): string {
  const c = node.content;
  const first = c[0];
  const arcs = [Math.floor(first / 40), first % 40];
  let v = 0;
  for (let i = 1; i < c.length; i++) {
    v = v * 128 + (c[i] & 0x7f);
    if (!(c[i] & 0x80)) { arcs.push(v); v = 0; }
  }
  return arcs.join('.');
}

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
