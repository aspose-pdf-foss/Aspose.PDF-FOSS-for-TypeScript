import { isIP } from 'node:net';
import { rethrowLimit } from './errors.js';
import {
  buildOcspRequest, checkRevocation, MAX_CRL_BYTES, MAX_OCSP_BYTES, revocationEndpoints, type RevocationStatus,
} from './revocation.js';

export interface RevocationTransportRequest {
  readonly url: string;
  readonly method: 'POST' | 'GET';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly redirect: 'error';
  readonly signal: AbortSignal;
  /** Cap on the decoded response body, in bytes. */
  readonly maxResponseBytes: number;
}

export interface RevocationTransportResponse {
  readonly status: number;
  /** The effective, absolute URL of the response. */
  readonly url: string;
  readonly redirected?: boolean;
  /** The decoded body, streamed in bounded chunks. */
  readonly body: AsyncIterable<Uint8Array>;
}

/** The caller's connection boundary. Only connect to the requested URL.
 *  Enforce the destination restrictions on the actual connection, including
 *  after DNS resolution. Reject private, loopback, link-local, and other
 *  non-public addresses, disable redirects, and honor the abort signal. */
export type RevocationTransport =
  (request: RevocationTransportRequest) => RevocationTransportResponse | Promise<RevocationTransportResponse>;

export interface RevocationDiscoveryOptions {
  /** Exact HTTP(S) origins, including any non-default port. */
  allowedOrigins: readonly string[];
  transport: RevocationTransport;
  /** Allow HTTP on explicitly listed origins. Defaults to HTTPS only. */
  allowHttp?: boolean;
  /** Abort all discovery for this verification. */
  signal?: AbortSignal;
  /** Total discovery time. Defaults to a maximum of 10 seconds. */
  timeoutMs?: number;
  /** Total attempts, including failed requests. Defaults to a maximum of 8. */
  maxRequests?: number;
  /** Simultaneous attempts. Defaults to a maximum of 2. */
  maxConcurrency?: number;
  /** Decoded bytes per OCSP response. Defaults to a maximum of 512 KiB. */
  maxOcspBytes?: number;
  /** Decoded bytes per CRL. Defaults to a maximum of 4 MiB. */
  maxCrlBytes?: number;
}

export interface RevocationTarget {
  cert: Uint8Array;
  issuer: Uint8Array;
}

type Kind = 'ocsp' | 'crl';
const KINDS: readonly Kind[] = ['ocsp', 'crl'];
const OCSP_HEADERS = Object.freeze({ 'Content-Type': 'application/ocsp-request', Accept: 'application/ocsp-response' });
const CRL_HEADERS = Object.freeze({ Accept: 'application/pkix-crl' });

function boundedLimit(value: number | undefined, ceiling: number, name: string): number {
  const limit = value ?? ceiling;
  if (!Number.isInteger(limit) || limit < 1 || limit > ceiling)
    throw new RangeError(name + ' must be an integer from 1 to ' + ceiling);
  return limit;
}

function networkUrl(value: string): URL | undefined {
  const authority = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (!authority || authority.includes('@') || /[\u0000-\u0020\u007f\\#]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return url;
  } catch (caught) { rethrowLimit(caught);
    // A certificate can advertise malformed or unsupported destinations.
  }
  return undefined;
}

function approvedUrl(value: string, origins: ReadonlySet<string>, allowHttp: boolean): URL | undefined {
  const url = networkUrl(value);
  if (!url || (url.protocol !== 'https:' && !allowHttp) || !origins.has(url.origin)) return undefined;
  const host = url.hostname.replace(/^\[|\]$|\.$/g, '');
  if (isIP(host) || !host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local')) return undefined;
  return url;
}

// The transport can ignore cancellation or stop producing bytes. Race its
// whole request and read against the shared signal without waiting for cleanup.
function beforeAbort<T>(signal: AbortSignal, pending: Promise<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    const finish = (value?: T): void => {
      signal.removeEventListener('abort', cancel);
      resolve(value);
    };
    const cancel = (): void => finish();
    signal.addEventListener('abort', cancel, { once: true });
    void pending.then(finish, cancel);
    if (signal.aborted) cancel();
  });
}

async function readBody(
  body: AsyncIterable<Uint8Array>, limit: number, signal: AbortSignal, active: () => boolean,
): Promise<Uint8Array | undefined> {
  const iterator = body[Symbol.asyncIterator]();
  let complete = false;
  let closing = false;
  let bytes = new Uint8Array(limit);
  const close = (): void => {
    if (complete || closing) return;
    closing = true;
    bytes = new Uint8Array();
    // Do not wait for the transport to finish closing the iterator.
    void Promise.resolve().then(() => iterator.return?.()).catch(() => {});
  };
  signal.addEventListener('abort', close, { once: true });
  let used = 0;
  try {
    while (active()) {
      const chunk = await iterator.next();
      if (!active()) return undefined;
      if (chunk.done) {
        complete = true;
        return bytes.subarray(0, used);
      }
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > limit - used) return undefined;
      bytes.set(chunk.value, used);
      used += chunk.value.byteLength;
    }
  } finally {
    signal.removeEventListener('abort', close);
    close();
  }
  return undefined;
}

async function fetchEvidence(
  transport: RevocationTransport, request: RevocationTransportRequest, active: () => boolean,
): Promise<Uint8Array | undefined> {
  if (!active()) return undefined;
  const response = await transport(request);
  if (!active() || response.status !== 200 || response.redirected || response.url !== request.url) return undefined;
  return readBody(response.body, request.maxResponseBytes, request.signal, active);
}

/** One bounded discovery phase shared by all eligible signer certificates.
 *  An untouched entry leaves the signer's existing verdict in place. @internal */
export async function discoverRevocations(
  targets: readonly RevocationTarget[], options: RevocationDiscoveryOptions, at?: Date,
): Promise<(RevocationStatus | undefined)[]> {
  const results = new Array<RevocationStatus | undefined>(targets.length);
  if (targets.length === 0 || options.signal?.aborted) return results;
  const { transport, signal: externalSignal } = options;
  if (typeof transport !== 'function') throw new TypeError('revocation discovery needs a transport');
  const timeoutMs = boundedLimit(options.timeoutMs, 10_000, 'timeoutMs');
  const maxRequests = boundedLimit(options.maxRequests, 8, 'maxRequests');
  const concurrency = boundedLimit(options.maxConcurrency, 2, 'maxConcurrency');
  const sizes: Record<Kind, number> = {
    ocsp: boundedLimit(options.maxOcspBytes, MAX_OCSP_BYTES, 'maxOcspBytes'),
    crl: boundedLimit(options.maxCrlBytes, MAX_CRL_BYTES, 'maxCrlBytes'),
  };
  const origins = new Set(options.allowedOrigins.map((origin) => {
    const url = networkUrl(origin);
    if (!url || !/^https?:\/\/[^/?#]+\/?$/i.test(origin)) throw new RangeError('expected an exact HTTP(S) origin');
    return url.origin;
  }));
  if (origins.size === 0) return results;
  const allowHttp = options.allowHttp === true;
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  const deadline = performance.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const active = (): boolean => {
    if (performance.now() >= deadline) controller.abort();
    return !signal.aborted;
  };

  let attempts = 0;
  let next = 0;
  const hasBudget = (): boolean => attempts < maxRequests && active();
  const worker = async (): Promise<void> => {
    while (next < targets.length && hasBudget()) {
      const index = next++;
      const target = targets[index];
      let endpoints: ReturnType<typeof revocationEndpoints>;
      let ocspBody: Uint8Array | undefined;
      try {
        endpoints = revocationEndpoints(target.cert);
        if (endpoints.ocsp.length) ocspBody = buildOcspRequest(target.cert, target.issuer);
      } catch (caught) { rethrowLimit(caught); continue; }

      for (const kind of KINDS) {
        if (results[index] === 'good' || results[index] === 'revoked') break;
        const seen = new Set<string>();
        for (const endpoint of endpoints[kind]) {
          if (!hasBudget()) break;
          const url = approvedUrl(endpoint, origins, allowHttp);
          if (!url || seen.has(url.href)) continue;
          seen.add(url.href);
          attempts++;
          results[index] = 'unknown';
          const requestController = new AbortController();
          const requestSignal = AbortSignal.any([signal, requestController.signal]);
          const requestActive = (): boolean => !requestSignal.aborted && active();
          const request: RevocationTransportRequest = Object.freeze({
            url: url.href, method: kind === 'ocsp' ? 'POST' : 'GET',
            headers: kind === 'ocsp' ? OCSP_HEADERS : CRL_HEADERS,
            body: kind === 'ocsp' && ocspBody ? new Uint8Array(ocspBody) : undefined,
            redirect: 'error', signal: requestSignal, maxResponseBytes: sizes[kind],
          });
          const body = await beforeAbort(signal, fetchEvidence(transport, request, requestActive));
          if (!body) requestController.abort();
          if (!body || !active()) continue;
          const { status } = checkRevocation(target.cert, target.issuer, { [kind]: body }, at);
          if ((status === 'good' || status === 'revoked') && active()) {
            results[index] = status;
            break;
          }
        }
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
    return results;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
