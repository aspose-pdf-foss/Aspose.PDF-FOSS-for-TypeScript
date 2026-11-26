import { captureResourceLimit, PdfParseError, rethrowLimit, UnsupportedFeatureError } from './errors.js';
import { DecodeBudget, registerStream } from './decodebudget.js';
import { Lexer, isPdfWhitespace } from './lexer.js';
import { ObjectParser } from './object-parser.js';
import { sourceObjectStream } from './objstm.js';
import { isDict, isName, isRef, isStream, type PdfObject, type PdfRef } from './types.js';
import type { LimitField, LoadLimits } from './loadlimits.js';
import { readXref, revisionFooterEnd } from './xref.js';

type Stage = 'input' | 'header' | 'xref' | 'trailer' | 'object';
interface Location { stage: Stage; objectNumber?: number; offset?: number }
export type SourcePreflightFinding = Location & { message: string } & (
  | { category: 'malformed' | 'unsupported' }
  | { category: 'limit'; limit: LimitField; allowed: number; reached: number }
);
export interface SourcePreflightReport { findings: SourcePreflightFinding[] }

/** Open accepts a version marker anywhere in the leading 1024 bytes. */
export function sourceHeader(bytes: Uint8Array): RegExpExecArray | null {
  return /%PDF-(\d+\.\d+)/.exec(new TextDecoder('latin1').decode(bytes.subarray(0, 1024)));
}

function sourceFailure(error: unknown): 'malformed' | 'unsupported' {
  if (error instanceof UnsupportedFeatureError) return 'unsupported';
  if (error instanceof PdfParseError) return 'malformed';
  // Structural streams can fail in Node's synchronous Flate or Brotli decoder.
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR' || code === 'Z_NEED_DICT' ||
      code?.startsWith('ERR__') || code?.startsWith('ERR_PADDING_')) return 'malformed';
  throw error;
}

export function inspectSource(bytes: Uint8Array, limits: LoadLimits): SourcePreflightReport {
  const findings: SourcePreflightFinding[] = [];
  let location: Location = { stage: 'input' };
  // Keep the innermost location if a limit unwinds the inspection.
  function check<T>(at: Location, inspect: () => T, decoded = false): T | undefined {
    const parent = location;
    location = at;
    let value: T | undefined;
    try {
      value = inspect();
    } catch (e) {
      rethrowLimit(e);
      const category = sourceFailure(e);
      const offset = !decoded && e instanceof PdfParseError ? e.offset ?? at.offset : at.offset;
      const finding: SourcePreflightFinding = { ...at, category, message: (e as Error).message };
      if (offset !== undefined && offset >= 0 && offset < bytes.length) finding.offset = offset;
      else delete finding.offset;
      findings.push(finding);
    }
    location = parent;
    return value;
  }
  const stopped = captureResourceLimit(() => {
    limits.enforce('maxFileBytes', bytes.length, 'input');
    const header = sourceHeader(bytes);
    if (!header || header.index !== 0 || !/^\d\.\d$/.test(header[1]) ||
        (bytes[header[0].length] !== 10 && bytes[header[0].length] !== 13))
      findings.push({ stage: 'header', offset: 0, category: 'malformed', message: 'Expected a PDF version header on the first line' });
    const budget = new DecodeBudget(limits);
    const xref = check({ stage: 'xref' }, () => readXref(bytes, limits, budget, true));
    if (!xref) return;
    for (const revision of xref.revisions) {
      if (revisionFooterEnd(revision) === undefined)
        findings.push({ stage: 'xref', offset: revision.xrefOffset, category: 'malformed', message: 'Missing or inconsistent revision footer' });
    }

    const { entries, trailer } = xref;
    const objects = new Map<number, PdfObject | undefined>();
    const containers = new Map<number, ReturnType<typeof sourceObjectStream> | undefined>();
    const encrypted = trailer.has('Encrypt') && trailer.get('Encrypt') !== null;
    const matchesRef = (ref: PdfRef) => {
      const e = entries.get(ref.num);
      return e?.type === 'offset' ? e.gen === ref.gen : e?.type === 'compressed' && ref.gen === 0;
    };

    function readContainer(num: number, depth: number) {
      if (!containers.has(num)) {
        const section = entries.get(num);
        const at: Location = { stage: 'object', objectNumber: num, offset: section?.type === 'offset' ? section.offset : undefined };
        const reader = check(at, () => {
          if (section?.type !== 'offset') throw new PdfParseError('missing object-stream container');
          const stream = read(num, depth);
          if (stream === undefined) return undefined;
          const type = isStream(stream) ? stream.dict.get('Type') : undefined;
          if (!isStream(stream) || !isName(type) || type.name !== 'ObjStm')
            throw new PdfParseError('expected an /ObjStm container');
          if (encrypted) throw new UnsupportedFeatureError('encrypted object stream requires decryption');
          return sourceObjectStream(stream, num, limits);
        }, true);
        containers.set(num, reader);
      }
      return containers.get(num);
    }

    function read(num: number, depth = 1): PdfObject | undefined {
      if (objects.has(num)) return objects.get(num);
      const entry = entries.get(num);
      if (!entry || entry.type === 'free') return undefined;
      objects.set(num, undefined); // also terminates a cycle through an indirect /Length
      const at: Location = { stage: 'object', objectNumber: num };
      if (entry.type === 'offset') at.offset = entry.offset;
      const value = check(at, () => {
        limits.enforce('maxNestingDepth', depth, 'source object references');
        if (entry.type === 'compressed') return readContainer(entry.streamObj, depth + 1)?.(num, entry.index);
        if (!Number.isSafeInteger(entry.offset) || entry.offset < 0 || entry.offset >= bytes.length ||
            isPdfWhitespace(bytes[entry.offset]) || bytes[entry.offset] === 37)
          throw new PdfParseError('xref offset misses object header');
        const parser = new ObjectParser(new Lexer(bytes, entry.offset), ref => {
          const length = isRef(ref) && matchesRef(ref) ? read(ref.num, depth + 1) : undefined;
          return typeof length === 'number' ? length : undefined;
        }, limits);
        const object = parser.parseSourceIndirectObject();
        if (object.num !== num || object.gen !== entry.gen) throw new PdfParseError('xref and object header disagree');
        if (isStream(object.value)) registerStream(object.value, budget);
        return object.value;
      }, entry.type === 'compressed');
      objects.set(num, value);
      return value;
    }

    for (const num of entries.keys()) read(num);
    const root = trailer.get('Root');
    if (!isRef(root) || !matchesRef(root)) {
      findings.push({ stage: 'trailer', category: 'malformed', message: '/Root must reference a live catalog' });
    } else {
      const value = read(root.num);
      const type = isDict(value) ? value.get('Type') : undefined;
      if (value !== undefined && !(isName(type) && type.name === 'Catalog'))
        findings.push({ stage: 'trailer', category: 'malformed', message: '/Root does not reference a catalog', objectNumber: root.num });
    }
  });
  if (stopped) findings.push({ ...location, category: 'limit', message: stopped.message,
    limit: stopped.limit, allowed: stopped.allowed, reached: stopped.reached });
  return { findings };
}
