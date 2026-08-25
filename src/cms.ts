// CMS / PKCS#7 SignedData for PDF digital signatures (RFC 5652). Detached
// signatures: the signed content (a PDF byte range) lives outside the CMS; the
// messageDigest signed attribute carries its hash. Built on the asn1.ts DER
// layer and node:crypto primitives. Baseline: RSA PKCS#1 v1.5 + SHA-256/384/512
// (other algorithms are layered on in A3).

import {
  KeyObject, X509Certificate, createHash, createCipheriv, createDecipheriv,
  publicEncrypt, privateDecrypt, randomBytes, constants as cryptoConstants,
  generateKeyPairSync, diffieHellman, createPublicKey,
} from 'node:crypto';
import {
  x963Kdf, eccCmsSharedInfo, aesKeyWrap, aesKeyUnwrap,
  KDF_HASH, WRAP_CIPHER, DH_SINGLE_PASS, AES_WRAP_OID,
} from './cmskdf.js';
import { der, parse, readOid, oidName, OID, Asn1Node } from './asn1.js';
import {
  SignatureScheme, DigestAlgorithm, SigAlg, detectScheme, signData, verifyData,
  signatureAlgorithmId, schemeFromSigAlg,
} from './sigalg.js';
import { buildTimeStampRequest, extractTimeStampToken, type TimestampProvider } from './rfc3161.js';
import { UnsupportedFeatureError } from './errors.js';

export type { DigestAlgorithm, SigAlg } from './sigalg.js';

export interface CmsSigner {
  certificate: Uint8Array;          // signer certificate (DER)
  chain?: Uint8Array[];             // intermediate certificates to embed (DER)
  /** Private key for in-process signing. Omit when supplying {@link sign}. */
  privateKey?: KeyObject;
  /** External signer: receives the to-be-signed bytes and the algorithm and
   *  returns the signature. Used for HSM/KMS/smartcard keys. Takes precedence
   *  over {@link privateKey}; requires {@link signatureScheme}. */
  sign?: (data: Uint8Array, alg: SigAlg) => Promise<Uint8Array> | Uint8Array;
  digestAlgorithm?: DigestAlgorithm; // default 'sha256'
  signatureScheme?: SignatureScheme; // default: detected from the key
  signingTime?: Date;                // default: now
  /** RFC 3161 timestamp provider; when set, the signature value is timestamped
   *  and the token embedded as an unsigned `id-aa-timeStampToken` attribute. */
  timestamp?: TimestampProvider;
  /** Digest algorithm for the timestamp message imprint. Default: the signer's
   *  {@link digestAlgorithm}. */
  timestampDigest?: DigestAlgorithm;
}

/** Optional encapsulated-content controls for {@link buildSignedData}. Default is
 *  a detached signature over external content (eContentType `id-data`). */
/** Standard CAdES commitment-type identifiers, or a custom dotted OID string. */
export type CommitmentType =
  | 'proof-of-origin' | 'proof-of-receipt' | 'proof-of-delivery'
  | 'proof-of-sender'  | 'proof-of-approval' | 'proof-of-creation'
  | (string & {});

/** CAdES `signer-location` signed attribute (all fields optional). */
export interface SignerLocation {
  country?: string;
  locality?: string;
  postalAddress?: string[]; // 1..6 lines
}

/** Optional CAdES signed attributes for a PAdES signature. */
export interface CadesAttributes {
  commitmentType?: CommitmentType;
  signerLocation?: SignerLocation;
}

export interface SignedDataOptions {
  /** eContentType OID for `encapContentInfo` (default `id-data`). */
  eContentType?: string;
  /** Embedded content; when set the content is carried in-line (e.g. the
   *  `TSTInfo` inside an RFC 3161 timestamp token) rather than detached. */
  eContent?: Uint8Array;
  /** Add the ESS `signing-certificate-v2` signed attribute (RFC 5035), binding
   *  the signer certificate by hash + issuer/serial into the signed attributes.
   *  Required for PAdES (CAdES-BES) signatures. Default false. */
  signingCertificateV2?: boolean;
  /** Optional CAdES signed attributes (commitment-type, signer-location).
   *  Emitted into the signed attribute set when present. */
  cades?: CadesAttributes;
}

const DIGEST_OID: Record<DigestAlgorithm, string> = {
  sha256: OID.sha256, sha384: OID.sha384, sha512: OID.sha512,
};

function digestAlgId(alg: DigestAlgorithm): Uint8Array {
  return der.sequence(der.oid(DIGEST_OID[alg]), der.null_());
}

// An Attribute is SEQUENCE { type OID, values SET OF value }.
function attribute(typeOid: string, value: Uint8Array): Uint8Array {
  return der.sequence(der.oid(typeOid), der.set(value));
}

// DER requires the elements of a SET OF to be sorted by their encoding.
function sortedSet(elements: Uint8Array[]): Uint8Array {
  const sorted = [...elements].sort((a, b) => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  });
  return der.set(...sorted);
}

// Re-tag a universal SET OF (0x31...) as an implicit [n] context tag (0xa0|n...):
// same constructed content, different identifier octet. Used for the [0]
// signedAttrs and [1] unsignedAttrs of a SignerInfo.
function implicitContext(setOf: Uint8Array, tagNumber: number): Uint8Array {
  const out = Uint8Array.from(setOf);
  out[0] = 0xa0 | tagNumber;
  return out;
}

function issuerAndSerial(certDer: Uint8Array): Uint8Array {
  const { issuer, serial } = certIssuerSerial(certDer);
  return der.sequence(issuer, serial);
}

/** The raw DER of a certificate's issuer `Name` and `serialNumber` INTEGER. */
function certIssuerSerial(certDer: Uint8Array): { issuer: Uint8Array; serial: Uint8Array } {
  const tbs = parse(certDer).children[0];
  let i = 0;
  if (tbs.children[0].tagClass === 2) i = 1; // skip explicit [0] version
  return { serial: tbs.children[i].raw, issuer: tbs.children[i + 2].raw };
}

/** ESS `SigningCertificateV2` (RFC 5035) over the signer certificate: a single
 *  `ESSCertIDv2` carrying the cert hash (under `alg`) and its `IssuerSerial`
 *  (issuer as a directoryName `GeneralName`, plus the serial). The
 *  `hashAlgorithm` is emitted only when it is not SHA-256 (the DER DEFAULT). */
function signingCertificateV2(certDer: Uint8Array, alg: DigestAlgorithm): Uint8Array {
  const certHash = new Uint8Array(createHash(alg).update(certDer).digest());
  const { issuer, serial } = certIssuerSerial(certDer);
  const issuerSerial = der.sequence(der.sequence(der.explicit(4, issuer)), serial);
  const essCertId = alg === 'sha256'
    ? der.sequence(der.octetString(certHash), issuerSerial)
    : der.sequence(digestAlgId(alg), der.octetString(certHash), issuerSerial);
  return der.sequence(der.sequence(essCertId)); // SigningCertificateV2 { certs SEQUENCE OF ESSCertIDv2 }
}

/** Friendly CAdES commitment-type name -> id-cti-ets-* OID. */
const COMMITMENT_OID: Record<string, string> = {
  'proof-of-origin': OID.ctiProofOfOrigin,
  'proof-of-receipt': OID.ctiProofOfReceipt,
  'proof-of-delivery': OID.ctiProofOfDelivery,
  'proof-of-sender': OID.ctiProofOfSender,
  'proof-of-approval': OID.ctiProofOfApproval,
  'proof-of-creation': OID.ctiProofOfCreation,
};
const COMMITMENT_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(COMMITMENT_OID).map(([name, oid]) => [oid, name]),
);

/** Resolve a commitment type to its OID: a known name maps to its id-cti OID,
 *  a well-formed dotted OID passes through; anything else throws. */
export function commitmentTypeOid(ct: string): string {
  if (ct in COMMITMENT_OID) return COMMITMENT_OID[ct];
  if (/^\d+(\.\d+)+$/.test(ct)) return ct;
  throw new UnsupportedFeatureError(`unknown commitmentType: ${ct}`);
}

/** CommitmentTypeIndication ::= SEQUENCE { commitmentTypeId OBJECT IDENTIFIER }. */
function commitmentTypeAttr(ct: string): Uint8Array {
  return attribute(OID.commitmentTypeIndication, der.sequence(der.oid(commitmentTypeOid(ct))));
}

/** True when a SignerLocation would emit at least one sub-field. */
function signerLocationEmits(loc: SignerLocation): boolean {
  return loc.country !== undefined || loc.locality !== undefined
    || (loc.postalAddress !== undefined && loc.postalAddress.length > 0);
}

/** SignerLocation ::= SEQUENCE { [0] country, [1] locality, [2] postalAddress },
 *  each context tag EXPLICIT over a UTF8String (or SEQUENCE OF for [2]). Returns
 *  undefined when no sub-field is present. */
function signerLocationAttr(loc: SignerLocation): Uint8Array | undefined {
  if (!signerLocationEmits(loc)) return undefined;
  const parts: Uint8Array[] = [];
  if (loc.country !== undefined) parts.push(der.explicit(0, der.utf8String(loc.country)));
  if (loc.locality !== undefined) parts.push(der.explicit(1, der.utf8String(loc.locality)));
  if (loc.postalAddress !== undefined && loc.postalAddress.length > 0) {
    parts.push(der.explicit(2, der.sequence(...loc.postalAddress.map((l) => der.utf8String(l)))));
  }
  return attribute(OID.signerLocation, der.sequence(...parts));
}

export async function buildSignedData(
  messageDigest: Uint8Array, signer: CmsSigner, opts: SignedDataOptions = {},
): Promise<Uint8Array> {
  const alg = signer.digestAlgorithm ?? 'sha256';
  const scheme = signer.signatureScheme ?? (signer.privateKey
    ? detectScheme(signer.privateKey)
    : (() => { throw new Error('cms: signatureScheme is required when no privateKey is given'); })());
  const contentType = opts.eContentType ?? OID.data;

  const signedAttrElements = [
    attribute(OID.contentType, der.oid(contentType)),
    attribute(OID.messageDigest, der.octetString(messageDigest)),
    attribute(OID.signingTime, der.utcTime(signer.signingTime ?? new Date())),
  ];
  if (opts.signingCertificateV2) {
    signedAttrElements.push(
      attribute(OID.signingCertificateV2, signingCertificateV2(signer.certificate, alg)));
  }
  if (opts.cades?.commitmentType) {
    signedAttrElements.push(commitmentTypeAttr(opts.cades.commitmentType));
  }
  if (opts.cades?.signerLocation) {
    const attr = signerLocationAttr(opts.cades.signerLocation);
    if (attr) signedAttrElements.push(attr);
  }
  const signedAttrsSet = sortedSet(signedAttrElements); // signed as SET OF (0x31)
  const signature = signer.sign
    ? new Uint8Array(await signer.sign(signedAttrsSet, { scheme, digest: alg }))
    : signData(signedAttrsSet, signer.privateKey!, scheme, alg);

  // Optional RFC 3161 signature timestamp, carried as an unsigned attribute.
  let unsignedAttrs: Uint8Array | undefined;
  if (signer.timestamp) {
    const tsAlg = signer.timestampDigest ?? alg;
    const imprint = new Uint8Array(createHash(tsAlg).update(signature).digest());
    const request = buildTimeStampRequest(imprint, tsAlg);
    const token = extractTimeStampToken(new Uint8Array(await signer.timestamp(request)));
    unsignedAttrs = implicitContext(sortedSet([attribute(OID.timeStampToken, token)]), 1);
  }

  const signerInfoParts = [
    der.integer(1),                                   // version (issuerAndSerialNumber)
    issuerAndSerial(signer.certificate),              // sid
    digestAlgId(alg),                                 // digestAlgorithm
    implicitContext(signedAttrsSet, 0),               // [0] signedAttrs
    signatureAlgorithmId(scheme, alg),                // signatureAlgorithm
    der.octetString(signature),                       // signature
  ];
  if (unsignedAttrs) signerInfoParts.push(unsignedAttrs); // [1] unsignedAttrs
  const signerInfo = der.sequence(...signerInfoParts);

  const certs = [signer.certificate, ...(signer.chain ?? [])];
  const certificates = der.explicit(0, ...certs);     // [0] IMPLICIT SET OF Certificate

  const encap = opts.eContent
    ? der.sequence(der.oid(contentType), der.explicit(0, der.octetString(opts.eContent)))
    : der.sequence(der.oid(contentType));             // detached: eContentType only

  const signedData = der.sequence(
    der.integer(1),                                   // version
    der.set(digestAlgId(alg)),                        // digestAlgorithms
    encap,                                            // encapContentInfo
    certificates,
    der.set(signerInfo),                              // signerInfos
  );

  return der.sequence(der.oid(OID.signedData), der.explicit(0, signedData)); // ContentInfo
}

export interface ParsedCms {
  digestAlgorithm: DigestAlgorithm;
  messageDigest: Uint8Array;        // from the messageDigest signed attribute
  signedAttrs: Uint8Array;          // the [0] signedAttrs node, raw
  signatureAlgorithm: string;       // OID name or dotted
  signature: Uint8Array;
  certificates: Uint8Array[];       // embedded certs (DER)
  signerCertificate: Uint8Array;    // the signer's cert (matched by issuer/serial)
  /** RFC 3161 timestamp token (a ContentInfo) from the `id-aa-timeStampToken`
   *  unsigned attribute, when present. */
  timestampToken?: Uint8Array;
  /** CAdES commitment-type: the friendly name for a known OID, else the OID. */
  commitmentType?: string;
  /** CAdES signer-location, when present. */
  signerLocation?: SignerLocation;
}

function findSignedData(cms: Uint8Array): Asn1Node {
  const contentInfo = parse(cms);
  const explicit0 = contentInfo.children[1]; // [0] EXPLICIT SignedData
  return explicit0.children[0];
}

function splitCerts(certificatesNode: Asn1Node): Uint8Array[] {
  const out: Uint8Array[] = [];
  const c = certificatesNode.content;
  let p = 0;
  while (p < c.length) { const node = parse(c, p); out.push(node.raw); p = node.end; }
  return out;
}

export function parseSignedData(cms: Uint8Array): ParsedCms {
  const sd = findSignedData(cms);
  let certificates: Uint8Array[] = [];
  let signerInfos: Asn1Node | undefined;
  for (let i = 3; i < sd.children.length; i++) {
    const ch = sd.children[i];
    if (ch.tagClass === 2 && ch.tag === 0) certificates = splitCerts(ch);
    else if (ch.tagClass === 0 && ch.tag === 0x11) signerInfos = ch;
  }
  const signerInfo = signerInfos!.children[0];
  const digestOid = readOid(signerInfo.children[2].children[0]);
  const digestAlgorithm = (oidName(digestOid) ?? digestOid) as DigestAlgorithm;

  const signedAttrsNode = signerInfo.children.find((c) => c.tagClass === 2 && c.tag === 0)!;
  // messageDigest attribute value
  let messageDigest: Uint8Array = new Uint8Array(0);
  for (const attr of signedAttrsNode.children) {
    if (readOid(attr.children[0]) === OID.messageDigest) messageDigest = attr.children[1].children[0].content;
  }

  // CAdES commitment-type-indication and signer-location, when present.
  let commitmentType: string | undefined;
  let signerLocation: SignerLocation | undefined;
  for (const attr of signedAttrsNode.children) {
    const attrOid = readOid(attr.children[0]);
    if (attrOid === OID.commitmentTypeIndication) {
      const oid = readOid(attr.children[1].children[0].children[0]); // SET -> SEQUENCE -> OID
      commitmentType = COMMITMENT_NAME[oid] ?? oid;
    } else if (attrOid === OID.signerLocation) {
      signerLocation = parseSignerLocation(attr.children[1].children[0]); // SET -> SEQUENCE
    }
  }

  // signature = the top-level OCTET STRING of the SignerInfo (the messageDigest
  // OCTET is nested inside signedAttrs, so this is unambiguous even when a [1]
  // unsignedAttrs follows); signatureAlgorithm is the SEQUENCE just before it.
  const sigIdx = signerInfo.children.findIndex(
    (c) => c.tagClass === 0 && c.tag === 0x04 && !c.constructed,
  );
  const sigOctet = signerInfo.children[sigIdx];
  const sigAlgNode = signerInfo.children[sigIdx - 1];
  const signatureAlgorithm = oidName(readOid(sigAlgNode.children[0])) ?? readOid(sigAlgNode.children[0]);

  const sid = signerInfo.children[1]; // issuerAndSerialNumber SEQUENCE
  const signerCertificate = matchCert(certificates, sid);

  // Optional [1] unsignedAttrs: pull out the id-aa-timeStampToken value, if any.
  let timestampToken: Uint8Array | undefined;
  const unsignedAttrs = signerInfo.children.find((c) => c.tagClass === 2 && c.tag === 1);
  if (unsignedAttrs) {
    for (const attr of unsignedAttrs.children) {
      if (readOid(attr.children[0]) === OID.timeStampToken)
        timestampToken = attr.children[1].children[0].raw;
    }
  }

  return {
    digestAlgorithm,
    messageDigest,
    signedAttrs: signedAttrsNode.raw,
    signatureAlgorithm,
    signature: sigOctet.content,
    certificates,
    signerCertificate,
    timestampToken,
    commitmentType,
    signerLocation,
  };
}

/** Decode a SignerLocation SEQUENCE (explicit [0]/[1]/[2] fields). */
function parseSignerLocation(node: Asn1Node): SignerLocation {
  const loc: SignerLocation = {};
  const td = new TextDecoder();
  for (const ch of node.children) {
    if (ch.tagClass !== 2) continue;
    if (ch.tag === 0) loc.country = td.decode(ch.children[0].content);
    else if (ch.tag === 1) loc.locality = td.decode(ch.children[0].content);
    else if (ch.tag === 2) loc.postalAddress = ch.children[0].children.map((c) => td.decode(c.content));
  }
  return loc;
}

function matchCert(certs: Uint8Array[], sid: Asn1Node): Uint8Array {
  const wantIssuer = sid.children[0].raw;
  const wantSerial = sid.children[1].content;
  for (const cert of certs) {
    const tbs = parse(cert).children[0];
    let i = 0; if (tbs.children[0].tagClass === 2) i = 1;
    const serial = tbs.children[i].content;
    const issuer = tbs.children[i + 2].raw;
    if (bytesEqual(issuer, wantIssuer) && bytesEqual(serial, wantSerial)) return cert;
  }
  return certs[0];
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface EnvelopeOptions {
  /** RSA key-transport padding for RSA recipients. Default 'pkcs1'. */
  keyWrap?: 'pkcs1' | 'oaep';
  /** OAEP hash when keyWrap is 'oaep'. Default 'sha256'. */
  oaepHash?: 'sha1' | 'sha256';
}

const OAEP_HASH_OID: Record<'sha1' | 'sha256', string> = {
  sha1: '1.3.14.3.2.26', sha256: OID.sha256,
};

/** RSAES-OAEP-params: hashAlgorithm [0], maskGenAlgorithm [1] = MGF1(hash). */
function oaepParams(hash: 'sha1' | 'sha256'): Uint8Array {
  const h = der.sequence(der.oid(OAEP_HASH_OID[hash]), der.null_());
  return der.sequence(
    der.explicit(0, h),
    der.explicit(1, der.sequence(der.oid(OID.mgf1), h)),
  );
}

/** A KeyTransRecipientInfo (RSA) for `pub`, wrapping `cek` with pkcs1 or OAEP. */
function keyTransRecipientInfo(
  certDer: Uint8Array, pub: KeyObject, cek: Uint8Array,
  keyWrap: 'pkcs1' | 'oaep', oaepHash: 'sha1' | 'sha256',
): Uint8Array {
  const { issuer, serial } = certIssuerSerial(certDer);
  const keyEncAlg = keyWrap === 'oaep'
    ? der.sequence(der.oid(OID.rsaesOaep), oaepParams(oaepHash))
    : der.sequence(der.oid(OID.rsaEncryption), der.null_());
  const encryptedKey = new Uint8Array(publicEncrypt(
    keyWrap === 'oaep'
      ? { key: pub, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash }
      : { key: pub, padding: cryptoConstants.RSA_PKCS1_PADDING },
    Buffer.from(cek)));
  return der.sequence(
    der.integer(0),                    // version
    der.sequence(issuer, serial),      // rid: IssuerAndSerialNumber
    keyEncAlg,                         // keyEncryptionAlgorithm
    der.octetString(encryptedKey),     // encryptedKey
  );
}

/** KeyAgreeRecipientInfo (ECDH-ES) for an EC recipient, one ephemeral key per
 *  recipient. Fixed scheme: dhSinglePass-stdDH-sha256kdf + aes128-wrap. Returns
 *  the SEQUENCE re-tagged as the RecipientInfo CHOICE alternative `kari [1]`. */
function keyAgreeRecipientInfo(certDer: Uint8Array, recipPub: KeyObject, cek: Uint8Array): Uint8Array {
  const namedCurve = recipPub.asymmetricKeyDetails?.namedCurve as string;
  const eph = generateKeyPairSync('ec', { namedCurve });
  const z = new Uint8Array(diffieHellman({ privateKey: eph.privateKey, publicKey: recipPub }));

  const wrapAlgId = der.sequence(der.oid(AES_WRAP_OID[16])); // aes128-wrap, no params
  const sharedInfo = eccCmsSharedInfo(wrapAlgId, 128);
  const kek = x963Kdf(z, 16, sharedInfo, 'sha256');
  const wrapped = aesKeyWrap(kek, cek);

  // originatorKey [1] IMPLICIT OriginatorPublicKey == the ephemeral SPKI
  // (SEQUENCE { algorithm, subjectPublicKey BIT STRING }) with a [1] tag.
  const spki = new Uint8Array(eph.publicKey.export({ format: 'der', type: 'spki' }));
  const originatorKey = Uint8Array.from(spki); originatorKey[0] = 0xa1;
  const originator = der.explicit(0, originatorKey);   // originator [0] EXPLICIT

  const keyEncAlg = der.sequence(der.oid(DH_SINGLE_PASS.sha256), wrapAlgId);
  const { issuer, serial } = certIssuerSerial(certDer);
  const rek = der.sequence(der.sequence(issuer, serial), der.octetString(wrapped)); // RecipientEncryptedKey
  const kari = der.sequence(
    der.integer(3),             // version
    originator,
    keyEncAlg,
    der.sequence(rek),          // recipientEncryptedKeys SEQUENCE OF
  );
  const out = Uint8Array.from(kari); out[0] = 0xa1; // RecipientInfo CHOICE: kari [1] IMPLICIT
  return out;
}

/** CMS EnvelopedData (RFC 5652) with KeyTransRecipientInfo (RSA PKCS#1 v1.5 or
 *  RSAES-OAEP key transport) or KeyAgreeRecipientInfo (ECDH-ES for EC recipients)
 *  and AES-128-CBC content encryption. Used by the PDF public-key security
 *  handler: `content` is the 24-byte seed+permissions payload. */
export function buildEnvelopedData(
  recipientCerts: Uint8Array[], content: Uint8Array, opts: EnvelopeOptions = {},
): Uint8Array {
  const cek = new Uint8Array(randomBytes(16));
  const iv = new Uint8Array(randomBytes(16));
  const cipher = createCipheriv('aes-128-cbc', cek, iv);
  const encryptedContent = new Uint8Array(
    Buffer.concat([cipher.update(Buffer.from(content)), cipher.final()]));

  const keyWrap = opts.keyWrap ?? 'pkcs1';
  const oaepHash = opts.oaepHash ?? 'sha256';
  const recipientInfos = recipientCerts.map((certDer) => {
    const pub = new X509Certificate(Buffer.from(certDer)).publicKey;
    if (pub.asymmetricKeyType === 'ec') return keyAgreeRecipientInfo(certDer, pub, cek);
    return keyTransRecipientInfo(certDer, pub, cek, keyWrap, oaepHash);
  });

  // encryptedContent is [0] IMPLICIT OCTET STRING (primitive): 0x80 tag.
  const encContentOctet = der.octetString(encryptedContent);
  encContentOctet[0] = 0x80;
  const encryptedContentInfo = der.sequence(
    der.oid(OID.data),
    der.sequence(der.oid(OID.aes128CBC), der.octetString(iv)),  // contentEncryptionAlgorithm
    encContentOctet,
  );

  const envelopedData = der.sequence(
    der.integer(0),                         // version
    der.set(...recipientInfos),             // recipientInfos SET OF
    encryptedContentInfo,
  );
  return der.sequence(der.oid(OID.envelopedData), der.explicit(0, envelopedData)); // ContentInfo
}

/** OAEP hash name from RSAES-OAEP-params (hashAlgorithm [0] EXPLICIT
 *  AlgorithmIdentifier); default sha1 (the DER DEFAULT). */
function oaepHashFromParams(params: Asn1Node | undefined): 'sha1' | 'sha256' {
  if (!params || params.children.length === 0) return 'sha1';
  // params -> [0] EXPLICIT -> SEQUENCE { oid, null } -> oid
  const hashOid = readOid(params.children[0].children[0].children[0]);
  return hashOid === OID.sha256 ? 'sha256' : 'sha1';
}

/** Recover the CEK from a KeyAgreeRecipientInfo (ECDH-ES) if one
 *  RecipientEncryptedKey matches `want` (issuer/serial) and our key agrees;
 *  else undefined. */
function openKeyAgree(
  ri: Asn1Node, privateKey: KeyObject, want: { issuer: Uint8Array; serial: Uint8Array },
): Uint8Array | undefined {
  // children: version, [0] originator, keyEncAlg SEQUENCE, recipientEncryptedKeys
  // (optional [1] ukm never emitted here). recipientEncryptedKeys is the last child.
  const originator = ri.children.find((c) => c.tagClass === 2 && c.tag === 0)!;
  const reks = ri.children[ri.children.length - 1];
  const keyEncAlg = ri.children[ri.children.length - 2]; // algid SEQUENCE before reks

  const rek = reks.children.find((k) =>
    bytesEqual(k.children[0].children[0].raw, want.issuer)
    && bytesEqual(k.children[0].children[1].raw, want.serial));
  if (!rek) return undefined;

  // Rebuild the ephemeral public key as SPKISEQUENCE { algorithm, publicKey }.
  // The originator's OriginatorPublicKey algorithm may omit the EC curve params
  // (openssl does), so take the algorithm identifier — which carries the curve —
  // from our own key and pair it with the ephemeral EC point (the BIT STRING).
  const origKey = originator.children[0];           // originatorKey [1] (constructed)
  const ephPoint = origKey.children[1].raw;         // publicKey BIT STRING
  const recipAlgId = parse(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }))
    .children[0].raw;                               // { id-ecPublicKey, namedCurve }
  const spki = der.sequence(recipAlgId, ephPoint);
  const ephPub = createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' });
  const z = new Uint8Array(diffieHellman({ privateKey, publicKey: ephPub }));

  const kdfOid = readOid(keyEncAlg.children[0]);
  const wrapOid = readOid(keyEncAlg.children[1].children[0]);
  const hash = KDF_HASH[kdfOid]; const wrap = WRAP_CIPHER[wrapOid];
  if (!hash || !wrap) return undefined;
  const sharedInfo = eccCmsSharedInfo(keyEncAlg.children[1].raw, wrap.keyLen * 8);
  const kek = x963Kdf(z, wrap.keyLen, sharedInfo, hash);
  return aesKeyUnwrap(kek, rek.children[1].content);
}

/** Recover the enveloped content if one RecipientInfo matches `certDer`
 *  (by issuer/serial) and decrypts with `privateKey`; else undefined. */
export function openEnvelopedData(
  envelope: Uint8Array, privateKey: KeyObject, certDer: Uint8Array,
): Uint8Array | undefined {
  const contentInfo = parse(envelope);
  const envelopedData = contentInfo.children[1].children[0];  // [0] EXPLICIT EnvelopedData
  const recipientInfos = envelopedData.children[1];           // SET OF RecipientInfo
  const eci = envelopedData.children[2];                      // EncryptedContentInfo

  const want = certIssuerSerial(certDer);
  let cek: Uint8Array | undefined;
  for (const ri of recipientInfos.children) {
    if (ri.tagClass === 2 && ri.tag === 1) {                  // KeyAgreeRecipientInfo [1]
      cek = openKeyAgree(ri, privateKey, want);
      if (cek) break;
      continue;
    }
    const rid = ri.children[1];                               // IssuerAndSerialNumber
    if (!bytesEqual(rid.children[0].raw, want.issuer)) continue;
    if (!bytesEqual(rid.children[1].raw, want.serial)) continue;
    const keyEncOid = readOid(ri.children[2].children[0]);    // keyEncryptionAlgorithm
    const encryptedKey = ri.children[3].content;
    if (keyEncOid === OID.rsaesOaep) {
      const oaepHash = oaepHashFromParams(ri.children[2].children[1]);
      cek = new Uint8Array(privateDecrypt(
        { key: privateKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash },
        Buffer.from(encryptedKey)));
    } else {
      cek = new Uint8Array(privateDecrypt(
        { key: privateKey, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(encryptedKey)));
    }
    break;
  }
  if (!cek) return undefined;

  const iv = eci.children[1].children[1].content;            // algorithm params OCTET STRING
  const encryptedContent = eci.children[2].content;          // [0] IMPLICIT OCTET STRING
  const decipher = createDecipheriv('aes-128-cbc', cek, iv);
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(encryptedContent)), decipher.final()]));
}

export interface CmsVerifyResult {
  signatureValid: boolean;  // signature over signedAttrs verifies against the signer cert
  digestMatches: boolean;   // messageDigest attribute equals the expected content digest
  signerCertificate: Uint8Array;
}

export function verifySignedData(cms: Uint8Array, expectedDigest: Uint8Array): CmsVerifyResult {
  const p = parseSignedData(cms);
  const digestMatches = bytesEqual(p.messageDigest, expectedDigest);

  // Signature is computed over the signedAttrs as a SET OF (0x31), not [0].
  const signedAttrsSet = Uint8Array.from(p.signedAttrs);
  signedAttrsSet[0] = 0x31;

  const cert = new X509Certificate(Buffer.from(p.signerCertificate));
  const scheme = schemeFromSigAlg(p.signatureAlgorithm);
  const signatureValid = verifyData(signedAttrsSet, cert.publicKey, p.signature, scheme, p.digestAlgorithm);

  return { signatureValid, digestMatches, signerCertificate: p.signerCertificate };
}
