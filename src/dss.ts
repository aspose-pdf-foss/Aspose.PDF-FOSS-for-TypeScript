// LTV validation-data store (/DSS) for PAdES-B-LT (ISO 32000-2 §12.8.4.3 /
// ETSI EN 319 142). Embeds the certificates, OCSP responses, and CRLs needed to
// validate a document's signatures long after signing — so verification no
// longer depends on the issuing CA being reachable — and reads that data back
// for offline revocation checking. The actual OCSP/CRL bytes come from caller
// callbacks; this module only stores and indexes them. Built on the object model
// + flate.ts; zero runtime dependencies.

import { createHash } from 'node:crypto';
import type { Document } from './document.js';
import {
  PdfObject, PdfDict, PdfStream, PdfRef, isDict, isArray, isStream, name,
} from './types.js';
import { inflateStream } from './flate.js';
import type { RevocationMaterial } from './revocation.js';
import type { RevocationFetcher } from './sigverify.js';

/** Options for {@link Document.AddValidationData}: callbacks that fetch the
 *  OCSP response / CRL for each signer, plus any extra certificates to embed
 *  (e.g. a trust-anchor root not carried in the CMS). */
export interface ValidationDataOptions {
  getOCSP?: RevocationFetcher;
  getCRL?: RevocationFetcher;
  extraCerts?: Uint8Array[];
}

/** De-duplicate DER blobs by content, preserving first-seen order. */
export function dedupBlobs(blobs: Uint8Array[]): Uint8Array[] {
  const seen = new Set<string>();
  const out: Uint8Array[] = [];
  for (const b of blobs) {
    const k = sha1Hex(b);
    if (!seen.has(k)) { seen.add(k); out.push(b); }
  }
  return out;
}

/** The `/VRI` key for a signature: the uppercase base-16 SHA-1 of its `/Contents`
 *  value (the whole signature byte string, padding included). */
export function vriKey(contents: Uint8Array): string {
  return createHash('sha1').update(contents).digest('hex').toUpperCase();
}

/** Per-signature validation data to embed under one `/VRI` entry. */
export interface DssEntry {
  vriKey: string;
  certs: Uint8Array[];
  ocsps: Uint8Array[];
  crls: Uint8Array[];
}

/** A bare stream carrying one DER validation object (cert / OCSP / CRL). */
function valStream(data: Uint8Array): PdfStream {
  return { kind: 'stream', dict: new Map<string, PdfObject>(), raw: data };
}

function sha1Hex(b: Uint8Array): string {
  return createHash('sha1').update(b).digest('hex');
}

/** Build the `/DSS` object graph in `doc` and return its dictionary reference.
 *  Identical blobs are interned into one shared stream; a `/VRI` entry per
 *  signature points at the subset relevant to it, and the top-level `/Certs`,
 *  `/OCSPs`, `/CRLs` arrays hold the union. */
export function buildDss(doc: Document, entries: DssEntry[]): PdfRef {
  const certs = new Map<string, PdfRef>();
  const ocsps = new Map<string, PdfRef>();
  const crls = new Map<string, PdfRef>();
  const intern = (pool: Map<string, PdfRef>, blob: Uint8Array): PdfRef => {
    const k = sha1Hex(blob);
    let ref = pool.get(k);
    if (!ref) { ref = doc.allocObject(valStream(blob)); pool.set(k, ref); }
    return ref;
  };

  const vri: PdfDict = new Map<string, PdfObject>();
  for (const e of entries) {
    const certRefs = e.certs.map((c) => intern(certs, c));
    const ocspRefs = e.ocsps.map((o) => intern(ocsps, o));
    const crlRefs = e.crls.map((c) => intern(crls, c));
    const entry: PdfDict = new Map<string, PdfObject>([['Type', name('VRI')]]);
    if (certRefs.length) entry.set('Cert', certRefs);
    if (ocspRefs.length) entry.set('OCSP', ocspRefs);
    if (crlRefs.length) entry.set('CRL', crlRefs);
    vri.set(e.vriKey, entry);
  }

  const dss: PdfDict = new Map<string, PdfObject>([['Type', name('DSS')]]);
  if (certs.size) dss.set('Certs', [...certs.values()]);
  if (ocsps.size) dss.set('OCSPs', [...ocsps.values()]);
  if (crls.size) dss.set('CRLs', [...crls.values()]);
  if (vri.size) dss.set('VRI', vri);
  return doc.allocObject(dss);
}

/** Decode every validation stream referenced by `arr` (resolving refs, inflating
 *  any FlateDecode). */
function streamsOf(doc: Document, arr: PdfObject | undefined): Uint8Array[] {
  const a = doc.resolve(arr);
  if (!isArray(a)) return [];
  const out: Uint8Array[] = [];
  for (const r of a) { const s = doc.resolve(r); if (isStream(s)) out.push(inflateStream(s)); }
  return out;
}

/** All certificates embedded in the document's `/DSS` (top-level `/Certs`), DER. */
export function readDssCerts(doc: Document): Uint8Array[] {
  const dss = doc.resolve(doc.catalog().get('DSS'));
  return isDict(dss) ? streamsOf(doc, dss.get('Certs')) : [];
}

/** Read `/DSS` validation data into per-signature {@link RevocationMaterial},
 *  keyed by signature field name. Prefers each signature's `/VRI` entry, falling
 *  back to the top-level `/OCSPs`/`/CRLs`. Empty when there is no `/DSS`. */
export function readDssMaterial(doc: Document): Map<string, RevocationMaterial> {
  const out = new Map<string, RevocationMaterial>();
  const dss = doc.resolve(doc.catalog().get('DSS'));
  if (!isDict(dss)) return out;
  const vri = doc.resolve(dss.get('VRI'));
  const topOcsps = streamsOf(doc, dss.get('OCSPs'));
  const topCrls = streamsOf(doc, dss.get('CRLs'));

  for (const sig of doc.Signatures) {
    if (!sig.isSigned || !sig.contents) continue;
    let ocsps = topOcsps, crls = topCrls;
    if (isDict(vri)) {
      const entry = doc.resolve((vri as PdfDict).get(vriKey(sig.contents)));
      if (isDict(entry)) {
        ocsps = streamsOf(doc, (entry as PdfDict).get('OCSP'));
        crls = streamsOf(doc, (entry as PdfDict).get('CRL'));
      }
    }
    const m: RevocationMaterial = {};
    if (ocsps[0]) m.ocsp = ocsps[0];
    if (crls[0]) m.crl = crls[0];
    if (m.ocsp || m.crl) out.set(sig.name, m);
  }
  return out;
}
