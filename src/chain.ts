// X.509 certificate-path validation for PDF signature verification (V2): build a
// chain from the signer certificate up to a caller-supplied trust anchor through
// the certificates embedded in the CMS (and any /DSS), verifying each link's
// signature, name chaining, validity period, basic-constraints CA flag, and a
// basic key-usage check. Reports trusted | untrusted. Uses node:crypto's
// X509Certificate for signature/validity, with deterministic DER parsing for
// names and key usage. Zero runtime dependencies.

import { X509Certificate } from 'node:crypto';
import { parse, readOid, Asn1Node } from './asn1.js';

export interface ChainOptions {
  /** Trusted root/intermediate certificates (DER). */
  trustAnchors: Uint8Array[];
  /** Validation time for validity-period checks. Default: now. */
  at?: Date;
}

export interface ChainResult {
  status: 'trusted' | 'untrusted';
  /** The built path, leaf-first, ending at the trust anchor (when trusted). */
  path: Uint8Array[];
  /** Why the path is untrusted, for diagnostics. */
  reason?: string;
}

const KEY_USAGE_OID = '2.5.29.15';
const MAX_DEPTH = 10;

// --- DER field helpers ---------------------------------------------------

function tbsOf(certDer: Uint8Array): Asn1Node { return parse(certDer).children[0]; }
function serialIndex(tbs: Asn1Node): number { return tbs.children[0].tagClass === 2 ? 1 : 0; }
function issuerRaw(certDer: Uint8Array): Uint8Array { const t = tbsOf(certDer); return t.children[serialIndex(t) + 2].raw; }
function subjectRaw(certDer: Uint8Array): Uint8Array { const t = tbsOf(certDer); return t.children[serialIndex(t) + 4].raw; }
function spkiRaw(certDer: Uint8Array): Uint8Array { const t = tbsOf(certDer); return t.children[serialIndex(t) + 5].raw; }

/** The KeyUsage bit set (digitalSignature=0 … cRLSign=6), or undefined when the
 *  certificate carries no KeyUsage extension. */
function keyUsage(certDer: Uint8Array): Set<number> | undefined {
  const tbs = tbsOf(certDer);
  const extsCtx = tbs.children.find((c) => c.tagClass === 2 && c.tag === 3); // [3] extensions
  if (!extsCtx) return undefined;
  for (const ext of extsCtx.children[0].children) {
    if (readOid(ext.children[0]) !== KEY_USAGE_OID) continue;
    const extnValue = ext.children[ext.children.length - 1].content; // OCTET STRING
    const bits = parse(extnValue);                                   // BIT STRING
    const set = new Set<number>();
    const bytes = bits.content.subarray(1); // drop the unused-bits octet
    for (let i = 0; i < bytes.length * 8; i++)
      if (bytes[i >> 3] & (0x80 >> (i & 7))) set.add(i);
    return set;
  }
  return undefined;
}

// --- Path validation -----------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function x509(certDer: Uint8Array): X509Certificate {
  return new X509Certificate(Buffer.from(certDer));
}

function withinValidity(cert: X509Certificate, at: Date): boolean {
  return at >= new Date(cert.validFrom) && at <= new Date(cert.validTo);
}

/** Whether `issuer` issued `cert`: issuer-name chaining plus a signature that
 *  verifies against the issuer's public key. */
function issued(certDer: Uint8Array, issuerDer: Uint8Array): boolean {
  if (!bytesEqual(issuerRaw(certDer), subjectRaw(issuerDer))) return false;
  try { return x509(certDer).verify(x509(issuerDer).publicKey); }
  catch { return false; }
}

/** Two certificates identify the same trust anchor (same subject + same key). */
function sameEntity(a: Uint8Array, b: Uint8Array): boolean {
  return bytesEqual(subjectRaw(a), subjectRaw(b)) && bytesEqual(spkiRaw(a), spkiRaw(b));
}

/** Build and validate a path from `leaf` to a trust anchor through `pool`
 *  (intermediates from the CMS / `/DSS`). */
export function verifyCertChain(leaf: Uint8Array, pool: Uint8Array[], opts: ChainOptions): ChainResult {
  const at = opts.at ?? new Date();
  const untrusted = (reason: string, path: Uint8Array[]): ChainResult => ({ status: 'untrusted', path, reason });

  // Leaf key usage: when present, it must permit signing (digitalSignature or
  // contentCommitment/nonRepudiation).
  const ku = keyUsage(leaf);
  if (ku && !ku.has(0) && !ku.has(1))
    return untrusted('signer key usage does not permit digital signatures', [leaf]);

  const path: Uint8Array[] = [leaf];
  let cur = leaf;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (!withinValidity(x509(cur), at))
      return untrusted('a certificate in the path is expired or not yet valid', path);

    // Directly trusted (the cert itself is an anchor).
    if (opts.trustAnchors.some((a) => sameEntity(a, cur))) return { status: 'trusted', path };

    // An anchor that issued the current certificate completes the path.
    const anchor = opts.trustAnchors.find((a) => issued(cur, a));
    if (anchor) {
      if (!withinValidity(x509(anchor), at)) return untrusted('the trust anchor is expired', path);
      return { status: 'trusted', path: [...path, anchor] };
    }

    // Self-signed but not an anchor: the chain ends at an unknown root.
    if (issued(cur, cur)) return untrusted('chain terminates at an untrusted root', path);

    // Otherwise climb through an intermediate CA from the pool.
    const next = pool.find((p) => !bytesEqual(p, cur) && issued(cur, p));
    if (!next) return untrusted('incomplete chain: issuer certificate not found', path);
    if (!x509(next).ca) return untrusted('a path certificate is not a CA', path);
    path.push(next);
    cur = next;
  }
  return untrusted('certificate path too long', path);
}
