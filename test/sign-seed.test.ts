import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { buildTimeStampToken } from '../src/rfc3161.js';
import { parseSignedData, type CmsSigner } from '../src/cms.js';
import { Document } from '../src/document.js';
import { SeedValueError } from '../src/errors.js';
import { httpTimestampProvider } from '../src/tsahttp.js';
import type { SeedValue } from '../src/sigseed.js';
import type { DigestAlgorithm } from '../src/sigalg.js';
import { isDict, isArray } from '../src/types.js';

const RECT: [number, number, number, number] = [20, 120, 180, 170];
const signerOf = (t: TestSigner, digestAlgorithm?: DigestAlgorithm): CmsSigner =>
  ({ certificate: t.certificate, privateKey: t.privateKey, ...(digestAlgorithm ? { digestAlgorithm } : {}) });

/** A document holding one prepared field `S` carrying `sv`, saved and reopened
 *  (so signing takes the incremental path, as a recipient's would). */
function prepared(sv: SeedValue): Uint8Array {
  const doc = Document.Open(buildClassicPdf(1));
  doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'S', seedValue: sv });
  return doc.Save();
}

/** The parsed CMS of the first SIGNED field in `bytes`. */
function cmsOf(bytes: Uint8Array) {
  const sig = Document.Open(bytes).Signatures.find((s) => s.isSigned)!;
  return parseSignedData(sig.contents!.subarray(0, sig.cmsLength!));
}

async function expectRefusal(sv: SeedValue, sign: (d: Document) => Promise<void>, entry: string) {
  const base = prepared(sv);
  const doc = Document.Open(base);
  const err = await sign(doc).then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(SeedValueError);
  expect((err as SeedValueError).entry).toBe(entry);
  expect(doc.Save()).toEqual(base); // nothing was allocated
}

describe('Sign honours a required /DigestMethod (puep.3 acceptance)', () => {
  const sv: SeedValue = { digestMethod: ['SHA384'], required: ['digestMethod'] };

  it('raises when the signer states SHA-256', async () => {
    await expectRefusal(sv, (d) => d.Sign(signerOf(buildSigner(), 'sha256'), { fieldName: 'S' }), 'digestMethod');
  });

  it('succeeds with SHA-384 and signs with it', async () => {
    const doc = Document.Open(prepared(sv));
    await doc.Sign(signerOf(buildSigner(), 'sha384'), { fieldName: 'S' });
    const out = doc.Save();
    expect(cmsOf(out).digestAlgorithm).toBe('sha384');
    const [r] = await Document.Open(out).VerifySignatures();
    expect([r.integrity, r.signature]).toEqual(['valid', 'valid']);
  });

  it('FOLLOWS the seed value when the signer states no digest', async () => {
    const doc = Document.Open(prepared({ digestMethod: ['SHA512'] }));
    await doc.Sign(signerOf(buildSigner()), { fieldName: 'S' });
    const out = doc.Save();
    expect(cmsOf(out).digestAlgorithm).toBe('sha512');
    const [r] = await Document.Open(out).VerifySignatures();
    expect(r.signature).toBe('valid');
  });

  it('refuses a field that requires only SHA-1 rather than substituting', async () => {
    await expectRefusal({ digestMethod: ['SHA1'], required: ['digestMethod'] },
      (d) => d.Sign(signerOf(buildSigner()), { fieldName: 'S' }), 'digestMethod');
  });
});

describe('Sign follows and checks the other entries (puep.3)', () => {
  it('takes the seed value\'s subfilter when the caller states none', async () => {
    const doc = Document.Open(prepared({ subFilter: ['ETSI.CAdES.detached'] }));
    await doc.Sign(signerOf(buildSigner()), { fieldName: 'S' });
    expect(Document.Open(doc.Save()).Signatures[0].subFilter).toBe('ETSI.CAdES.detached');
  });

  it('refuses a stated subfilter a required list does not put first', async () => {
    await expectRefusal({ subFilter: ['ETSI.CAdES.detached'], required: ['subFilter'] },
      (d) => d.Sign(signerOf(buildSigner()), { fieldName: 'S', subFilter: 'CMS' }), 'subFilter');
  });

  it('checks a required reason', async () => {
    const sv: SeedValue = { reasons: ['Approved'], required: ['reasons'] };
    await expectRefusal(sv, (d) => d.Sign(signerOf(buildSigner()), { fieldName: 'S', reason: 'Because' }), 'reasons');
    const doc = Document.Open(prepared(sv));
    await doc.Sign(signerOf(buildSigner()), { fieldName: 'S', reason: 'Approved' });
    expect(Document.Open(doc.Save()).Signatures[0].isSigned).toBe(true);
  });

  it('refuses a required named appearance and required Adobe revocation info', async () => {
    await expectRefusal({ appearanceFilter: 'Stamp', required: ['appearanceFilter'] },
      (d) => d.Sign(signerOf(buildSigner()), { fieldName: 'S' }), 'appearanceFilter');
    await expectRefusal({ addRevInfo: true, required: ['addRevInfo'] },
      (d) => d.Sign(signerOf(buildSigner()), { fieldName: 'S' }), 'addRevInfo');
  });

  it('ignores the seed value of a field it does not fill', async () => {
    const doc = Document.Open(prepared({ digestMethod: ['SHA384'], required: ['digestMethod'] }));
    await doc.Sign(signerOf(buildSigner(), 'sha256'), { fieldName: 'Other' });
    expect(cmsOf(doc.Save()).digestAlgorithm).toBe('sha256');
  });
});

describe('/MDP and /LockDocument (puep.3)', () => {
  /** The DocMDP /P a certification wrote into its /Reference. */
  function docMdpP(bytes: Uint8Array): unknown {
    const out = Document.Open(bytes);
    const v = out.Signatures[0].valueDict;
    const ref = out.resolve(v.get('Reference'));
    const first = isArray(ref) ? out.resolve(ref[0]) : undefined;
    const tp = isDict(first) ? out.resolve(first.get('TransformParams')) : undefined;
    return isDict(tp) ? tp.get('P') : undefined;
  }

  it('Certify takes the field\'s DocMDP level when none is stated', async () => {
    const doc = Document.Open(prepared({ mdp: 'form-fill-and-annotate' }));
    await doc.Certify(signerOf(buildSigner()), { fieldName: 'S' });
    expect(docMdpP(doc.Save())).toBe(3);
  });

  it('Sign refuses a field meant for a certification', async () => {
    await expectRefusal({ mdp: 'form-fill' }, (d) => d.Sign(signerOf(buildSigner()), { fieldName: 'S' }), 'mdp');
  });

  it('Certify refuses a field meant for an approval signature', async () => {
    await expectRefusal({ mdp: 'approval' }, (d) => d.Certify(signerOf(buildSigner()), { fieldName: 'S' }), 'mdp');
  });

  it('a required lock makes Certify no-changes, and a required unlock form-fill', async () => {
    const locked = Document.Open(prepared({ lockDocument: 'true', required: ['lockDocument'] }));
    await locked.Certify(signerOf(buildSigner()), { fieldName: 'S' });
    expect(docMdpP(locked.Save())).toBe(1);
    const unlocked = Document.Open(prepared({ lockDocument: 'false', required: ['lockDocument'] }));
    await unlocked.Certify(signerOf(buildSigner()), { fieldName: 'S' });
    expect(docMdpP(unlocked.Save())).toBe(2);
  });

  // puep.7 reversed this: Sign now honours a required lock through /Lock /P.
  it('Sign honours a required lock by writing /Lock /P 1 into the field', async () => {
    const doc = Document.Open(prepared({ lockDocument: 'true', required: ['lockDocument'] }));
    await doc.Sign(signerOf(buildSigner()), { fieldName: 'S' });
    const out = Document.Open(doc.Save());
    expect(out.Signatures[0].lock).toEqual({ action: 'include', fields: [], permissions: 'no-changes' });
    const [r] = await out.VerifySignatures();
    expect([r.signature, r.docMDP]).toEqual(['valid', 'ok']);
  });
});

describe('a required /TimeStamp calls the /SV URL (puep.3 acceptance)', () => {
  let server: Server | undefined;
  afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = undefined; });

  /** A local RFC 3161 authority; resolves to its URL and records each request. */
  async function localTsa(seen: Array<{ type?: string; bytes: number }>): Promise<string> {
    const tsa = buildSigner({ commonName: 'Local TSA' });
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        const body = new Uint8Array(Buffer.concat(chunks));
        seen.push({ type: req.headers['content-type'], bytes: body.length });
        const token = await buildTimeStampToken(body, { certificate: tsa.certificate, privateKey: tsa.privateKey });
        res.writeHead(200, { 'Content-Type': 'application/timestamp-reply' });
        res.end(Buffer.from(token));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/tsa`;
  }

  it('timestamps through the /SV URL when the caller supplies no TSA', async () => {
    const seen: Array<{ type?: string; bytes: number }> = [];
    const url = await localTsa(seen);
    const doc = Document.Open(prepared({ timestamp: { url, required: true } }));
    await doc.Sign(signerOf(buildSigner()), { fieldName: 'S', placeholderBytes: 16384 });
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('application/timestamp-query');
    const out = doc.Save();
    expect(cmsOf(out).timestampToken).toBeDefined();
    const [r] = await Document.Open(out).VerifySignatures();
    expect(r.signature).toBe('valid');
    expect(r.timestamp).toBeDefined();
  });

  it('does NOT call an advisory /SV URL', async () => {
    const seen: Array<{ type?: string; bytes: number }> = [];
    const url = await localTsa(seen);
    const doc = Document.Open(prepared({ timestamp: { url, required: false } }));
    await doc.Sign(signerOf(buildSigner()), { fieldName: 'S' });
    expect(seen).toHaveLength(0);
    expect(cmsOf(doc.Save()).timestampToken).toBeUndefined();
  });

  it('uses the caller\'s own TSA over the /SV URL', async () => {
    const seen: Array<{ type?: string; bytes: number }> = [];
    const url = await localTsa(seen);
    const tsa = buildSigner({ commonName: 'Caller TSA' });
    const doc = Document.Open(prepared({ timestamp: { url, required: true } }));
    await doc.Sign(signerOf(buildSigner()), {
      fieldName: 'S', placeholderBytes: 16384,
      timestamp: (req) => buildTimeStampToken(req, { certificate: tsa.certificate, privateKey: tsa.privateKey }),
    });
    expect(seen).toHaveLength(0);
    expect(cmsOf(doc.Save()).timestampToken).toBeDefined();
  });

  it('refuses a required timestamp whose URL is not http(s)', async () => {
    await expectRefusal({ timestamp: { url: 'file:///etc/passwd', required: true } },
      (d) => d.Sign(signerOf(buildSigner()), { fieldName: 'S' }), 'timestamp');
  });
});

describe('httpTimestampProvider bounds a remote authority (puep.3)', () => {
  let server: Server | undefined;
  afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = undefined; });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`;
  }

  it('refuses a non-http(s) URL up front', () => {
    expect(() => httpTimestampProvider('ftp://x')).toThrow(RangeError);
  });

  it('throws on a non-2xx status', async () => {
    const url = await serve((_q, res) => { res.writeHead(503); res.end(); });
    await expect(httpTimestampProvider(url)(new Uint8Array(4))).rejects.toThrow(/HTTP 503/);
  });

  it('refuses a response past maxResponseBytes, even with no Content-Length', async () => {
    const url = await serve((_q, res) => {
      res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
      for (let i = 0; i < 8; i++) res.write(Buffer.alloc(1024));
      res.end();
    });
    await expect(httpTimestampProvider(url, { maxResponseBytes: 4096 })(new Uint8Array(4)))
      .rejects.toThrow(/exceeds 4096 bytes/);
  });

  it('gives up after timeoutMs', async () => {
    const url = await serve(() => { /* never answers */ });
    await expect(httpTimestampProvider(url, { timeoutMs: 100 })(new Uint8Array(4))).rejects.toThrow();
  });
});
