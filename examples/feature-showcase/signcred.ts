// Signing credentials, minted fresh on every run: an RSA keypair plus a
// self-signed X.509 certificate, assembled with the library's own DER encoder.
// No checked-in secrets, and nothing that can expire.
//
// This mirrors test/helpers/build-signer.ts. It is duplicated rather than
// imported because examples must not depend on test/ — the published package
// ships neither, but an example that breaks when a test helper is refactored is
// a bad example.

import { generateKeyPairSync, sign as cryptoSign, KeyObject } from 'node:crypto';
import { der } from '../../src/asn1.js';

const SHA256_WITH_RSA = '1.2.840.113549.1.1.11';
const CN = '2.5.4.3';

function name(commonName: string): Uint8Array {
  return der.sequence(der.set(der.sequence(der.oid(CN), der.utf8String(commonName))));
}

export interface MintedSigner {
  certificate: Uint8Array;
  privateKey: KeyObject;
  commonName: string;
}

/** An RSA-2048 keypair and a self-signed certificate naming `commonName`. */
export function mintSigner(commonName: string): MintedSigner {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certAlgId = der.sequence(der.oid(SHA256_WITH_RSA), der.null_());
  const spki = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }));

  const tbs = der.sequence(
    der.explicit(0, der.integer(2)),                       // version v3
    der.integer(BigInt(Date.now())),                       // serialNumber
    certAlgId,                                             // signature
    name(commonName),                                      // issuer
    der.sequence(
      der.utcTime(new Date(Date.UTC(2020, 0, 1))),
      der.utcTime(new Date(Date.UTC(2049, 11, 31))),
    ),                                                     // validity
    name(commonName),                                      // subject (self-signed)
    spki,                                                  // subjectPublicKeyInfo
  );

  const sig = new Uint8Array(cryptoSign('sha256', tbs, privateKey));
  const certificate = der.sequence(tbs, certAlgId, der.bitString(sig));
  return { certificate, privateKey, commonName };
}
