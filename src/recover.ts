// Brute-force recovery scan: find every `N G obj` header in a buffer, without
// trusting (or reading) the cross-reference structure. Pure byte work — no
// object parsing, so it stays testable on hand-built buffers.

/** One `N G obj` header found in the file. */
export interface ObjCandidate {
  /** Byte offset of the object number — where an xref entry would point. */
  offset: number;
  gen: number;
}

export interface SweepResult {
  /** Object number -> every candidate found, ascending by file offset. */
  candidates: Map<number, ObjCandidate[]>;
  /** Byte offsets just past each `trailer` keyword, latest first. */
  trailerOffsets: number[];
}

const isWs = (b: number) =>
  b === 0 || b === 9 || b === 10 || b === 12 || b === 13 || b === 32;
const isDigit = (b: number) => b >= 48 && b <= 57;
const isDelim = (b: number) =>
  b === 40 || b === 41 || b === 60 || b === 62 || b === 91 ||
  b === 93 || b === 123 || b === 125 || b === 47 || b === 37;

/** Object and generation numbers longer than this are not plausible and are
 *  rejected, so a long digit run in stream data cannot become a candidate. */
const MAX_DIGITS = 10;

const TRAILER = [0x74, 0x72, 0x61, 0x69, 0x6C, 0x65, 0x72]; // 'trailer'

function digits(buf: Uint8Array, start: number, end: number): number {
  let v = 0;
  for (let i = start; i <= end; i++) v = v * 10 + (buf[i] - 48);
  return v;
}

/** Backtrack from the `obj` keyword at `objAt` over `N G `. */
function matchHeader(
  buf: Uint8Array, objAt: number,
): (ObjCandidate & { num: number }) | undefined {
  let p = objAt - 1;
  while (p >= 0 && isWs(buf[p])) p--;
  if (p < 0 || !isDigit(buf[p])) return undefined;
  const genEnd = p;
  while (p >= 0 && isDigit(buf[p])) p--;
  const genStart = p + 1;
  if (genEnd - genStart + 1 > MAX_DIGITS) return undefined;
  if (p < 0 || !isWs(buf[p])) return undefined;          // need whitespace between N and G
  while (p >= 0 && isWs(buf[p])) p--;
  if (p < 0 || !isDigit(buf[p])) return undefined;
  const numEnd = p;
  while (p >= 0 && isDigit(buf[p])) p--;
  const numStart = p + 1;
  if (numEnd - numStart + 1 > MAX_DIGITS) return undefined;
  // The object number must start the token: whitespace before it, or start of file.
  if (p >= 0 && !isWs(buf[p])) return undefined;
  const num = digits(buf, numStart, numEnd);
  if (num <= 0) return undefined;
  return { num, gen: digits(buf, genStart, genEnd), offset: numStart };
}

function matches(buf: Uint8Array, at: number, kw: number[]): boolean {
  if (at + kw.length > buf.length) return false;
  for (let i = 0; i < kw.length; i++) if (buf[at + i] !== kw[i]) return false;
  return true;
}

/** Scan the whole buffer for object headers and `trailer` keywords. O(n). */
export function sweepObjects(buf: Uint8Array): SweepResult {
  const candidates = new Map<number, ObjCandidate[]>();
  const trailerOffsets: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x6F && buf[i + 1] === 0x62 && buf[i + 2] === 0x6A) { // 'obj'
      const after = i + 3;
      if (after < buf.length && !isWs(buf[after]) && !isDelim(buf[after])) continue;
      const hit = matchHeader(buf, i);
      if (!hit) continue;
      let list = candidates.get(hit.num);
      if (!list) { list = []; candidates.set(hit.num, list); }
      list.push({ offset: hit.offset, gen: hit.gen });
      continue;
    }
    if (b === 0x74 && matches(buf, i, TRAILER)) trailerOffsets.push(i + TRAILER.length);
  }
  for (const list of candidates.values()) list.sort((a, b) => a.offset - b.offset);
  trailerOffsets.reverse();
  return { candidates, trailerOffsets };
}
