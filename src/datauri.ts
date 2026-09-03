/** Decoding a `data:` URI's payload.
 *
 *  Invariant: a PURE LEAF importing NOTHING. Two consumers — mdflow.ts's
 *  resolveImage path and cssflow.ts's — and two copies is how they would come
 *  to disagree about one payload. The extraction colornames.ts, preformat.ts
 *  and bordersides.ts each already made.
 *
 *  Invariant: it NEVER throws. A payload it cannot decode is `undefined` —
 *  including a malformed one, which is a destination we cannot resolve rather
 *  than an error. */

/** The bytes of a `data:` URI, or undefined for anything else. */
export function decodeDataUri(dest: string): Uint8Array | undefined {
  const comma = dest.indexOf(',');
  if (!dest.startsWith('data:') || comma < 0) return undefined;
  const meta = dest.slice(5, comma);
  const payload = dest.slice(comma + 1);
  try {
    if (/;base64$/i.test(meta)) return new Uint8Array(Buffer.from(payload, 'base64'));
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return undefined;
  }
}
