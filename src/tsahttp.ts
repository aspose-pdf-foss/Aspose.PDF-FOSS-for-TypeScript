/** An RFC 3161 timestamp authority reached over HTTP (`puep.3`): a
 *  {@link TimestampProvider} that POSTs a DER `TimeStampReq` and hands back the
 *  `TimeStampResp`, which `extractTimeStampToken` already unwraps.
 *
 *  Uses the runtime's built-in `fetch` (Node >= 22, per `engines`), so it adds
 *  no dependency. Signing calls it on the caller's behalf in exactly one case —
 *  a seed value that REQUIRES a timestamp when the caller supplied no TSA — and
 *  there the URL comes from the DOCUMENT. That is why it bounds what it will
 *  read and how long it will wait: an authority is a remote party, and one
 *  chosen by a file we did not write must not be able to exhaust memory or
 *  hang the signing call. */
import type { TimestampProvider } from './rfc3161.js';

/** Options for {@link httpTimestampProvider}. */
export interface HttpTimestampOptions {
  /** Extra request headers (e.g. `Authorization` for a paid TSA). */
  headers?: Record<string, string>;
  /** Give up after this many milliseconds. Default 30,000. */
  timeoutMs?: number;
  /** Refuse a response larger than this many bytes. Default 1 MiB — a
   *  timestamp token with its TSA certificate chain is a few kilobytes. */
  maxResponseBytes?: number;
}

/** A {@link TimestampProvider} that POSTs to the RFC 3161 authority at `url`
 *  (`http:` or `https:` only), as `application/timestamp-query`. Throws on a
 *  non-2xx status, a timeout, or a response past `maxResponseBytes`. */
export function httpTimestampProvider(url: string, opts: HttpTimestampOptions = {}): TimestampProvider {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url))
    throw new RangeError(`timestamp authority URL must be http(s): '${String(url)}'`);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const max = opts.maxResponseBytes ?? 1 << 20;
  if (!(timeoutMs > 0)) throw new RangeError('timeoutMs must be positive');
  if (!Number.isInteger(max) || max < 1) throw new RangeError('maxResponseBytes must be a positive integer');

  return async (request: Uint8Array): Promise<Uint8Array> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/timestamp-query',
        Accept: 'application/timestamp-reply',
        ...opts.headers,
      },
      // A copy: BodyInit takes an ArrayBuffer-backed view, and `request` may be
      // a view over a SharedArrayBuffer-typed buffer.
      body: new Uint8Array(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`timestamp authority ${url} answered HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (declared > max) throw new Error(`timestamp authority ${url} response exceeds ${max} bytes`);
    // Read incrementally so a lying or absent Content-Length is bounded too.
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > max) {
          await reader.cancel();
          throw new Error(`timestamp authority ${url} response exceeds ${max} bytes`);
        }
        chunks.push(value);
      }
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  };
}
