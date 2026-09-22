/** A signature field's lock (`/Lock`, 32000-1 12.7.4.5): the form fields a
 *  signature in that field FREEZES, carried into the signature itself as a
 *  FieldMDP transform (`puep.4`).
 *
 *  A pure LEAF over `types.js` and `metadata.js`'s text codec, `resolve` as an
 *  argument, so every rule is drivable from hand-built dicts. The shapes are
 *  pyHanko's `FieldMDPSpec` — `as_sig_field_lock` for the field, and
 *  `fieldmdp_reference_dictionary` for the signature's `/Reference` entry,
 *  whose `/Data` points at the catalog — and the locking rule is its
 *  `is_locked`.
 *
 *  Note what this is NOT: `docmdp.ts` also knows the key `/Lock`, as one of the
 *  keys a DocMDP level-2 signature permits to CHANGE. That is a question about
 *  whether writing a lock is allowed, not about what a lock freezes. */
import { PdfDict, PdfObject, PdfRef, isArray, isDict, isName, isString, name } from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import type { DocMdpPermission } from './signature.js';

/** Which fields a signature in the field freezes: every field, the listed
 *  ones, or every field except the listed ones. A listed name also covers the
 *  subtree beneath it — `grp` locks `grp.child`.
 *
 *  `permissions` (PDF 2.0, `/Lock /P`, `puep.7`) is a DocMDP-style level the
 *  signature imposes on the whole document even as an APPROVAL signature. A lock
 *  that exists only for its level lists no fields: `{ action: 'include',
 *  fields: [], permissions }`, pyHanko's shape. */
export type FieldLock = (
  | { action: 'all' }
  | { action: 'include' | 'exclude'; fields: string[] }
) & { permissions?: DocMdpPermission };

/** `/P` 1..3, in order — `signature.ts`'s `docMdpP`, restated here because
 *  this module is a leaf and imports it as a type only. */
const P_LEVELS: readonly DocMdpPermission[] = ['no-changes', 'form-fill', 'form-fill-and-annotate'];

/** The `/P` number for a level. */
export function lockLevelP(p: DocMdpPermission): 1 | 2 | 3 {
  return (P_LEVELS.indexOf(p) + 1) as 1 | 2 | 3;
}

const ACTION_NAME = { all: 'All', include: 'Include', exclude: 'Exclude' } as const;
const ACTION_OF: Record<string, FieldLock['action']> = { All: 'all', Include: 'include', Exclude: 'exclude' };

const text = (s: string): PdfObject => ({ kind: 'string', bytes: encodePdfText(s) });

/** The `/Action` + `/Fields` pair both dictionaries share. */
function lockEntries(lock: FieldLock): Array<[string, PdfObject]> {
  const out: Array<[string, PdfObject]> = [['Action', name(ACTION_NAME[lock.action])]];
  if (lock.action !== 'all') out.push(['Fields', lock.fields.map(text)]);
  if (lock.permissions !== undefined) out.push(['P', lockLevelP(lock.permissions)]);
  return out;
}

/** Validate `lock` and build its `/Lock` dictionary (`/Type /SigFieldLock`).
 *  Throws — `TypeError` for the wrong kind of thing, `RangeError` for a value
 *  outside its set — and allocates nothing. Field names are NOT checked against
 *  the form: a preparer may lock fields it adds afterwards. */
export function encodeFieldLock(lock: FieldLock): PdfDict {
  if (typeof lock !== 'object' || lock === null) throw new TypeError('lock must be an object');
  const action = (lock as { action?: unknown }).action;
  if (action !== 'all' && action !== 'include' && action !== 'exclude')
    throw new RangeError("lock.action must be one of all, include, exclude");
  const fields = (lock as { fields?: unknown }).fields;
  if (action === 'all') {
    if (fields !== undefined) throw new RangeError("lock.fields is not allowed with action 'all'");
  } else {
    if (!Array.isArray(fields) || fields.some((f) => typeof f !== 'string'))
      throw new TypeError(`lock.fields must be an array of field names for action '${action}'`);
    // An empty list is meaningful only beside a level: with none it locks
    // nothing (include) or restates 'all' (exclude).
    if (fields.length === 0 && (lock as { permissions?: unknown }).permissions === undefined)
      throw new RangeError(`lock.fields must not be empty for action '${action}' unless the lock sets permissions`);
    if (fields.some((f) => f === '')) throw new RangeError('lock.fields must not contain an empty name');
  }
  const permissions = (lock as { permissions?: unknown }).permissions;
  if (permissions !== undefined && !P_LEVELS.includes(permissions as DocMdpPermission))
    throw new RangeError(`lock.permissions must be one of ${P_LEVELS.join(', ')}`);
  return new Map<string, PdfObject>([['Type', name('SigFieldLock')], ...lockEntries(lock)]);
}

/** Read a `/Lock` dictionary or FieldMDP `/TransformParams` — the two share
 *  `/Action` and `/Fields`. LENIENT: an unknown action, or a listing action with
 *  no well-formed list, is no lock at all; `/All` ignores a stray `/Fields`. */
export function readFieldLock(
  resolve: (o: PdfObject | undefined) => PdfObject, raw: PdfObject | undefined,
): FieldLock | undefined {
  const d = resolve(raw);
  if (!isDict(d)) return undefined;
  const a = resolve(d.get('Action'));
  const action = isName(a) ? ACTION_OF[a.name] : undefined;
  if (action === undefined) return undefined;
  const p = resolve(d.get('P'));
  const level = typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 3 ? P_LEVELS[p - 1] : undefined;
  const perms = level === undefined ? {} : { permissions: level };
  if (action === 'all') return { action, ...perms };
  const f = resolve(d.get('Fields'));
  if (!isArray(f)) return undefined;
  const items = f.map((x) => resolve(x));
  if (!items.every(isString)) return undefined;
  return { action, fields: items.map((s) => decodePdfText(s.bytes)), ...perms };
}

/** The level a `/Lock` dictionary states in `/P`, read ON ITS OWN — whatever
 *  its `/Action` says, the way pyHanko reads `lock_dict['/P']`. A signer that
 *  records a level on the field and nowhere else is still honoured. */
export function readLockLevel(
  resolve: (o: PdfObject | undefined) => PdfObject, raw: PdfObject | undefined,
): DocMdpPermission | undefined {
  const d = resolve(raw);
  if (!isDict(d)) return undefined;
  const p = resolve(d.get('P'));
  return typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 3 ? P_LEVELS[p - 1] : undefined;
}

/** The FieldMDP entry for a signature value's `/Reference` array, `/Data`
 *  naming the catalog (pyHanko's `fieldmdp_reference_dictionary`). A lock's
 *  level is carried as `/TransformParams /P` too, which pyHanko's own source
 *  flags as "NOT spec-compatible, but emulates Acrobat" — it is what lets a
 *  verifier read an approval signature's level from what the SIGNER signed. */
export function fieldMdpReference(lock: FieldLock, catalog: PdfRef): PdfDict {
  const params: PdfDict = new Map<string, PdfObject>([
    ['Type', name('TransformParams')], ...lockEntries(lock), ['V', name('1.2')],
  ]);
  return new Map<string, PdfObject>([
    ['Type', name('SigRef')],
    ['TransformMethod', name('FieldMDP')],
    ['Data', catalog],
    ['TransformParams', params],
  ]);
}

/** The lock a signature carries in its `/Reference` FieldMDP entry, or
 *  undefined. Read from the SIGNATURE rather than from the field's `/Lock`,
 *  because the signature is what the signer's digest covers. */
export function readFieldMdpLock(
  sigDict: PdfDict, resolve: (o: PdfObject | undefined) => PdfObject,
): FieldLock | undefined {
  const refs = resolve(sigDict.get('Reference'));
  if (!isArray(refs)) return undefined;
  for (const r of refs) {
    const sr = resolve(r);
    if (!isDict(sr)) continue;
    const tm = sr.get('TransformMethod');
    if (isName(tm) && tm.name === 'FieldMDP') return readFieldLock(resolve, sr.get('TransformParams'));
  }
  return undefined;
}

/** Whether `lock` freezes the field named `fullName` (pyHanko's `is_locked`).
 *  A listed name matches itself and everything beneath it (`grp` covers
 *  `grp.x`) but never a mere name prefix (`a` does not cover `ab`). */
export function isLocked(lock: FieldLock, fullName: string): boolean {
  if (lock.action === 'all') return true;
  const listed = lock.fields.some((f) => fullName === f || fullName.startsWith(`${f}.`));
  return lock.action === 'include' ? listed : !listed;
}
