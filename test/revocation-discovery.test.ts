import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Document, type RevocationDiscoveryOptions, type RevocationTransportRequest } from '../src/index.js';
import { parseSignedData } from '../src/cms.js';
import { buildClassicPdf } from './helpers/build-pdf.js';

const vectors: Record<string, string> = JSON.parse(
  readFileSync(new URL('./fixtures/revocation-discovery/evidence.json', import.meta.url), 'utf8'),
);
const bytes = (name: string) => new Uint8Array(Buffer.from(vectors[name], 'base64'));
const at = new Date(vectors.at);
const issuer = bytes('issuer');
const signer = {
  certificate: bytes('leaf'),
  privateKey: createPrivateKey({ key: Buffer.from(vectors.fixtureKey, 'base64'), format: 'der', type: 'pkcs8' }),
};
const origin = 'https://revocation.test';

function reply(request: RevocationTransportRequest, payload: Uint8Array) {
  return {
    status: 200, url: request.url,
    body: (async function* () { yield payload.subarray(0, 5); yield payload.subarray(5); })(),
  };
}

async function sign(pdf: Uint8Array, fieldName: string, includeIssuer = true): Promise<Uint8Array> {
  const doc = Document.Open(pdf);
  await doc.Sign({ ...signer, chain: includeIssuer ? [issuer] : [] }, { fieldName });
  return doc.Save();
}

function discovery(transport: RevocationDiscoveryOptions['transport'], limits: Partial<RevocationDiscoveryOptions> = {}) {
  return { transport, allowedOrigins: [origin], ...limits };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('VerifySignatures opt-in revocation discovery', () => {
  let signed: Uint8Array;
  beforeAll(async () => { signed = await sign(buildClassicPdf(1), 'Signer'); });

  it('makes no requests by default even when the signer advertises endpoints', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected HTTP request'));
    const [report] = await Document.Open(signed).VerifySignatures({ at });
    expect(report).toMatchObject({ integrity: 'valid', signature: 'valid', revocation: 'unchecked' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses an independent OCSP request vector and falls back in certificate order', async () => {
    const transport = vi.fn((request: RevocationTransportRequest) => {
      const vector = request.url.endsWith('/ocsp') ? 'wrongOcsp'
        : request.url.endsWith('/ocsp2') ? 'staleOcsp' : 'crl';
      return reply(request, bytes(vector));
    });
    const [report] = await Document.Open(signed).VerifySignatures({
      at, trustAnchors: [issuer],
      revocationDiscovery: discovery(transport, {
        allowedOrigins: ['https://REVOCATION.test:443', 'https://127.0.0.1', 'https://[::1]', 'https://local.local'],
      }),
    });
    expect(report).toMatchObject({ integrity: 'valid', signature: 'valid', chain: 'trusted', revocation: 'revoked' });
    const requests = transport.mock.calls.map(([r]) => r);
    expect(requests.map((r) => r.url)).toEqual([origin + '/ocsp', origin + '/ocsp2', origin + '/crl']);
    expect(requests[0]).toMatchObject({
      method: 'POST', body: bytes('request'), redirect: 'error',
      headers: { 'Content-Type': 'application/ocsp-request', Accept: 'application/ocsp-response' },
    });
    expect(requests[2]).toMatchObject({ method: 'GET', redirect: 'error', headers: { Accept: 'application/pkix-crl' } });
    expect(requests[2].body).toBeUndefined();
  });

  it('stops at the first authenticated OCSP response', async () => {
    const transport = vi.fn((request: RevocationTransportRequest) => reply(request, bytes('goodOcsp')));
    const [report] = await Document.Open(signed).VerifySignatures({ at, revocationDiscovery: discovery(transport) });
    expect(report.revocation).toBe('good');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(['offline', 'callback', 'DSS'])('uses conclusive %s evidence before discovery', async (source) => {
    const transport = vi.fn(() => { throw new Error('unexpected discovery'); });
    const ocsp = bytes('goodOcsp');
    const opts = { at, revocationDiscovery: discovery(transport) };
    let doc = Document.Open(signed);
    if (source === 'DSS') {
      await doc.AddValidationData({ getOCSP: () => ocsp });
      doc = Document.Open(doc.Save());
    }
    const [report] = await doc.VerifySignatures({
      ...opts,
      offline: source === 'offline' ? new Map([['Signer', { ocsp }]]) : undefined,
      getOCSP: source === 'callback' ? () => ocsp : undefined,
    });
    expect(report.revocation).toBe('good');
    expect(transport).not.toHaveBeenCalled();
  });

  it('runs discovery after inconclusive existing evidence', async () => {
    const transport = vi.fn((request: RevocationTransportRequest) => reply(request, bytes('goodOcsp')));
    const [report] = await Document.Open(signed).VerifySignatures({
      at, offline: new Map([['Signer', { ocsp: bytes('staleOcsp') }]]), revocationDiscovery: discovery(transport),
    });
    expect(report.revocation).toBe('good');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('keeps the verified certificate pair isolated from mutable callback inputs', async () => {
    const transport = vi.fn((request: RevocationTransportRequest) => reply(request, bytes('goodOcsp')));
    const anchor = bytes('issuer');
    const withoutIssuer = await sign(buildClassicPdf(1), 'Signer', false);
    const [report] = await Document.Open(withoutIssuer).VerifySignatures({
      at, trustAnchors: [anchor], revocationDiscovery: discovery(transport),
      getOCSP(cert, ca) {
        expect(this.at).toBe(at);
        cert.fill(0);
        ca.fill(0);
        return undefined;
      },
    });
    expect(report).toMatchObject({ integrity: 'valid', signature: 'valid', chain: 'trusted', revocation: 'good' });
    expect(anchor).toEqual(issuer);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('uses the origins authorized before existing callbacks run', async () => {
    const transport = vi.fn((request: RevocationTransportRequest) => reply(request, bytes('goodOcsp')));
    const allowedOrigins = [origin];
    await Document.Open(signed).VerifySignatures({
      at, revocationDiscovery: discovery(transport, { allowedOrigins }),
      getOCSP() {
        (this.revocationDiscovery!.allowedOrigins as string[]).push('https://denied.test');
        return undefined;
      },
    });
    expect(transport.mock.calls.map(([r]) => r.url)).toEqual([origin + '/ocsp']);
  });

  it('requires valid PDF integrity and a matched issuer before discovery', async () => {
    const transport = vi.fn(() => { throw new Error('unexpected discovery'); });
    const tampered = signed.slice();
    tampered[7] = tampered[7] === 0x36 ? 0x37 : 0x36; // Change the covered PDF header version.
    const unmatched = await sign(buildClassicPdf(1), 'No issuer', false);
    const opts = { at, revocationDiscovery: discovery(transport) };
    expect((await Document.Open(tampered).VerifySignatures(opts))[0].integrity).toBe('tampered');
    expect((await Document.Open(unmatched).VerifySignatures(opts))[0].revocation).toBe('unchecked');
    expect(transport).not.toHaveBeenCalled();
  });

  it('requires a valid CMS signature even when the covered digest matches', async () => {
    const transport = vi.fn(() => { throw new Error('unexpected discovery'); });
    const field = Document.Open(signed).Signatures[0];
    const contents = field.contents!.subarray(0, field.cmsLength);
    const signature = parseSignedData(contents).signature;
    const cmsOffset = Buffer.from(contents).indexOf(signature);
    expect(cmsOffset).toBeGreaterThan(0);
    const invalid = signed.slice();
    const hexOffset = field.byteRange![1] + 2 * cmsOffset;
    invalid[hexOffset] = invalid[hexOffset] === 0x30 ? 0x31 : 0x30;

    const [report] = await Document.Open(invalid).VerifySignatures({ at, revocationDiscovery: discovery(transport) });
    expect(report).toMatchObject({ integrity: 'valid', signature: 'invalid', revocation: 'unchecked' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('requires an exact allowed origin and explicit permission for HTTP', async () => {
    const transport = vi.fn((request: RevocationTransportRequest) => reply(request, bytes('goodOcsp')));
    const allowedOrigins = ['http://legacy.test', origin + ':444'];
    const doc = Document.Open(signed);
    const [denied] = await doc.VerifySignatures({ at, revocationDiscovery: discovery(transport, { allowedOrigins }) });
    expect(denied.revocation).toBe('unchecked');
    expect(transport).not.toHaveBeenCalled();
    const [allowed] = await doc.VerifySignatures({
      at, revocationDiscovery: discovery(transport, { allowedOrigins, allowHttp: true }),
    });
    expect(allowed.revocation).toBe('good');
    expect(transport.mock.calls.map(([r]) => r.url)).toEqual(['http://legacy.test/check']);
  });

  it('rejects redirects and caps decoded body bytes while streaming', async () => {
    const crl = bytes('crl');
    const started = vi.fn();
    const closed = vi.fn();
    const transport = vi.fn((request: RevocationTransportRequest) => {
      if (request.url.endsWith('/ocsp')) return { ...reply(request, bytes('goodOcsp')), status: 302 };
      if (request.url.endsWith('/ocsp2')) return { ...reply(request, bytes('goodOcsp')), url: origin + '/different' };
      if (request.url.endsWith('/crl')) return {
        status: 200, url: request.url, body: (async function* () {
          try {
            started();
            yield new Uint8Array(crl.length);
            yield Uint8Array.of(1);
            throw new Error('the oversized body must not be read again');
          } finally { closed(); }
        })(),
      };
      return reply(request, crl);
    });
    const [report] = await Document.Open(signed).VerifySignatures({
      at, revocationDiscovery: discovery(transport, { maxCrlBytes: crl.length }),
    });
    expect(report.revocation).toBe('revoked');
    expect(transport.mock.calls.map(([r]) => r.url)).toEqual([
      origin + '/ocsp', origin + '/ocsp2', origin + '/crl', origin + '/crl2',
    ]);
    expect(started).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
    expect(transport.mock.calls[2][0].signal.aborted).toBe(true);
  });

  it('shares request and concurrency budgets across signers', async () => {
    const triple = await sign(await sign(signed, 'Second'), 'Third');
    const releases: (() => void)[] = [];
    let active = 0;
    let maximum = 0;
    const transport = vi.fn(async (request: RevocationTransportRequest) => {
      maximum = Math.max(maximum, ++active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return reply(request, bytes('wrongOcsp'));
    });
    const verifying = Document.Open(triple).VerifySignatures({
      at, revocationDiscovery: discovery(transport, { maxRequests: 3, maxConcurrency: 2 }),
    });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    releases[0]();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(3));
    releases[1]();
    releases[2]();
    const reports = await verifying;
    expect(maximum).toBe(2);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(reports.map((r) => r.revocation)).toEqual(['unknown', 'unknown', 'unchecked']);
  });

  it('returns at the shared deadline when the body read stays pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    const close = vi.fn(() => Promise.resolve({ done: true, value: undefined } as IteratorResult<Uint8Array>));
    const transport = vi.fn((request: RevocationTransportRequest) => ({
      status: 200, url: request.url, body: {
        [Symbol.asyncIterator]() { return this; },
        next() { reading(); return new Promise<IteratorResult<Uint8Array>>(() => {}); },
        return: close,
      },
    }));
    const verifying = Document.Open(signed).VerifySignatures({
      at, revocationDiscovery: discovery(transport, { timeoutMs: 25 }),
    });
    await started;
    await vi.advanceTimersByTimeAsync(25);
    expect((await verifying)[0].revocation).toBe('unknown');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0].signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it('returns on caller cancellation even when transport ignores the signal', async () => {
    const caller = new AbortController();
    let dispatch!: (request: RevocationTransportRequest) => void;
    const started = new Promise<RevocationTransportRequest>((resolve) => { dispatch = resolve; });
    const transport = vi.fn((request: RevocationTransportRequest) => {
      dispatch(request);
      return new Promise<never>(() => {});
    });
    const verifying = Document.Open(signed).VerifySignatures({
      at, revocationDiscovery: discovery(transport, { signal: caller.signal }),
    });
    const request = await started;
    caller.abort();
    const [report] = await verifying;
    expect(report).toMatchObject({ integrity: 'valid', signature: 'valid', revocation: 'unknown' });
    expect(request.signal.aborted).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
