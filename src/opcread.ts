/** Reading an OPC package (`m2fp.2`): content types and relationships, for the
 *  DOCX importer. Note the direction: `ooxml.ts` WRITES packages; the two share
 *  exactly one rule, `relsPath` — where a source's `.rels` lives.
 *
 *  **Invariant:** LAZY, `zipread.ts`'s shape one level up. `[Content_Types].xml`
 *  is read at open; each source's `.rels` is parsed the first time that source
 *  is asked about and cached. A FAILED parse is cached too and thrown on every
 *  query of that source, while every other source stays usable — so one broken
 *  part costs that part, and `m2fp.5` can report it.
 *
 *  **Invariant:** part names compare ASCII-case-insensitively (OPC). Lookup is
 *  exact first, then through a case-folded index, and two ZIP entries whose
 *  names differ only by case are refused at open: two readers would pick
 *  different bytes, which is `zipread.ts`'s duplicate-name rule one level up.
 *
 *  **Invariant:** an internal target resolves as an RFC 3986 reference against
 *  the SOURCE part's URI, never the package root — the rule `ooxml.ts` records
 *  for writing. `..` past the root CLAMPS, as `remove_dot_segments` defines and
 *  `System.IO.Packaging` does; refusing would disagree with the format owner's
 *  reader about which part a link names.
 *
 *  **Invariant:** an external target is kept verbatim and never resolved or
 *  fetched (3ywf.1).
 *
 *  **Note, a DECISION (m2fp.7):** a backslash in a target (`media\image1.png`)
 *  is an ordinary character, not a separator — the target names a part whose
 *  name contains it, which is normally none, so `has` answers false and the
 *  reference degrades like any dangling one. OPC part names are `/`-separated
 *  and `zipread.ts` keeps a backslash literal too; translating it here alone
 *  would let the two layers disagree about which part a name means.
 *
 *  **Note:** XML parts are decoded as UTF-8 (`parseXml`); a UTF-16 content-types
 *  or `.rels` file is refused as not well-formed. Strict OOXML relationship
 *  types are kept verbatim and mapped by nothing. Interleaved parts
 *  (`/[0].piece`) are not supported.
 *
 *  **Note, measured:** `resolveTarget`'s empty-target guard and its
 *  root-or-directory guard are REDUNDANT DEFENCES — an empty target merges to
 *  the source's directory, which the second guard declines anyway. Removing
 *  either alone reddens nothing; removing both reddens two cases. And taking
 *  an extension from the LAST segment covers nothing observable: a last segment
 *  with no dot gives a whole-name "extension" containing `/`, which no valid
 *  `Default` can match. Both are kept as the honest spelling of their rules.
 *
 *  A leaf over `zipread.js`, `xml.js`, `loadlimits.js`, `errors.js`, and
 *  `relsPath` from `ooxml.js`. */
import { openZip, type ZipArchive } from './zipread.js';
import { parseXml, type XmlNode } from './xml.js';
import { LoadLimits } from './loadlimits.js';
import { PdfParseError, rethrowLimit } from './errors.js';
import { relsPath } from './ooxml.js';

const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/** Transitional relationship types the DOCX importer follows. */
export const OFFICE_DOCUMENT = `${REL_BASE}/officeDocument`;
export const STYLES = `${REL_BASE}/styles`;
export const NUMBERING = `${REL_BASE}/numbering`;
export const IMAGE = `${REL_BASE}/image`;
export const HYPERLINK = `${REL_BASE}/hyperlink`;

export interface OpcRelationship {
  readonly id: string;
  readonly type: string;
  /** Verbatim from the file. */
  readonly target: string;
  /** TargetMode="External". Never resolved, never fetched. */
  readonly external: boolean;
  /** Internal only: the resolved package path (no leading slash). Absent for
   *  an external target, or an internal one that names no part. */
  readonly part?: string;
}

export interface OpcPackage {
  readonly zip: ZipArchive;
  /** Override for the part, else Default for its extension, else undefined.
   *  NOT an existence test: a Default answers for any name with a matching
   *  extension, held or not — ask `has` for that. */
  contentType(part: string): string | undefined;
  /** The source's relationships in FILE order; '' is the package root. A source
   *  with no `.rels` has none. */
  relationships(source: string): readonly OpcRelationship[];
  /** Lookup by Id within one source — what an `r:id`/`r:embed` names. */
  relationship(source: string, id: string): OpcRelationship | undefined;
  /** Every relationship of the source with this type, in file order. */
  byType(source: string, type: string): OpcRelationship[];
  has(part: string): boolean;
  /** Decode one part. `RangeError` for a part the package does not hold. */
  read(part: string): Uint8Array;
}

const CONTENT_TYPES = '[Content_Types].xml';

/** ASCII-only case fold — OPC's comparison, deliberately not `toLowerCase`,
 *  which folds non-ASCII letters OPC treats as distinct. */
const fold = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** UTF-8 percent-decoding; `undefined` for a malformed escape. */
function pctDecode(s: string): string | undefined {
  try { return decodeURIComponent(s); } catch (caught) { rethrowLimit(caught); return undefined; }
}

/** RFC 3986 5.2.4 over an absolute path. `..` past the root CLAMPS: popping an
 *  empty stack is a no-op, which is the specification's own behaviour. */
function removeDotSegments(path: string): string {
  const segs = path.split('/');           // path starts with '/', so segs[0] === ''
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i];
    const last = i === segs.length - 1;
    if (s === '.' || s === '..') {
      if (s === '..') out.pop();
      if (last) out.push('');
      continue;
    }
    out.push(s);
  }
  return '/' + out.join('/');
}

/** Resolve an INTERNAL relationship target against its source part (RFC 3986
 *  5.2.2, merge per 5.2.3). `source` has no leading slash; `''` is the package
 *  root. `undefined` when the target names no part: a query or fragment, a
 *  scheme or network path, an empty reference (which RFC 3986 makes the source
 *  itself, not its directory), a malformed escape, or a result that is the root
 *  or a directory. */
export function resolveTarget(source: string, target: string): string | undefined {
  if (target === '' || /[?#]/.test(target) || target.startsWith('//')) return undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return undefined;
  // Decode FIRST (final review I1): an encoded dot is a dot to every reader
  // that normalizes per RFC 3986 6.2.2.2, so `%2e%2e` must be `..` here too,
  // not a literal segment that survives into the part name. An encoded
  // separator has no such reading — part names may not contain one — so it
  // names no part rather than becoming a real separator.
  if (/%(2f|5c)/i.test(target)) return undefined;
  const decoded = pctDecode(target);
  if (decoded === undefined) return undefined;
  let path: string;
  if (decoded.startsWith('/')) path = decoded;
  else {
    const base = '/' + source;
    path = base.slice(0, base.lastIndexOf('/') + 1) + decoded;
  }
  const resolved = removeDotSegments(path).slice(1);
  if (resolved === '' || resolved.endsWith('/')) return undefined;
  return resolved;
}

/** Could this decoded name be an OPC part name at all? No empty, `.` or `..`
 *  segment — the shapes on which two readers would disagree about which part
 *  an Override describes. A literal backslash is an ordinary character here,
 *  as it is to `zipread.ts`. */
function isPartName(name: string): boolean {
  return name.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function parseRoot(bytes: Uint8Array, limits: LoadLimits, what: string, root: string): XmlNode {
  let node: XmlNode;
  try { node = parseXml(bytes, limits); } catch (caught) {
    rethrowLimit(caught);
    throw new PdfParseError(`${what} is not well-formed: ${(caught as Error).message}`);
  }
  if (node.name !== root) throw new PdfParseError(`${what}: root element is <${node.name}>, not <${root}>`);
  return node;
}

interface ContentTypes { defaults: Map<string, string>; overrides: Map<string, string>; }

function parseContentTypes(bytes: Uint8Array, limits: LoadLimits): ContentTypes {
  const root = parseRoot(bytes, limits, CONTENT_TYPES, 'Types');
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  let n = 0;
  for (const c of root.children) {
    if (c.name !== 'Default' && c.name !== 'Override') continue;
    limits.enforce('maxContainerItems', ++n, 'content-type entries');
    const ct = c.attrs.get('ContentType');
    if (c.name === 'Default') {
      const ext = c.attrs.get('Extension');
      if (ext === undefined || ct === undefined)
        throw new PdfParseError(`${CONTENT_TYPES}: Default needs Extension and ContentType`);
      const key = fold(ext);
      if (defaults.has(key)) throw new PdfParseError(`${CONTENT_TYPES}: duplicate Default for .${ext}`);
      defaults.set(key, ct);
    } else {
      const name = c.attrs.get('PartName');
      if (name === undefined || ct === undefined)
        throw new PdfParseError(`${CONTENT_TYPES}: Override needs PartName and ContentType`);
      const encoded = name.startsWith('/') ? name.slice(1) : name;
      const decoded = /%(2f|5c)/i.test(encoded) ? undefined : pctDecode(encoded);
      if (decoded === undefined || !isPartName(decoded)) throw new PdfParseError(`${CONTENT_TYPES}: PartName ${name} is not a part name`);
      const key = fold(decoded);
      if (overrides.has(key)) throw new PdfParseError(`${CONTENT_TYPES}: duplicate Override for ${name}`);
      overrides.set(key, ct);
    }
  }
  return { defaults, overrides };
}

/** The extension of a part name's LAST segment, or undefined. */
function extensionOf(part: string): string | undefined {
  const leaf = part.slice(part.lastIndexOf('/') + 1);
  const dot = leaf.lastIndexOf('.');
  return dot < 0 ? undefined : leaf.slice(dot + 1);
}

function parseRels(source: string, bytes: Uint8Array, limits: LoadLimits): OpcRelationship[] {
  const what = `relationships of ${source === '' ? 'the package' : source}`;
  const root = parseRoot(bytes, limits, what, 'Relationships');
  const out: OpcRelationship[] = [];
  const ids = new Set<string>();
  let n = 0;
  for (const c of root.children) {
    if (c.name !== 'Relationship') continue;
    limits.enforce('maxContainerItems', ++n, what);
    const id = c.attrs.get('Id');
    const type = c.attrs.get('Type');
    const target = c.attrs.get('Target');
    if (id === undefined || type === undefined || target === undefined)
      throw new PdfParseError(`${what}: a Relationship needs Id, Type and Target`);
    const mode = c.attrs.get('TargetMode') ?? 'Internal';
    if (mode !== 'Internal' && mode !== 'External')
      throw new PdfParseError(`${what}: unknown TargetMode ${mode}`);
    if (ids.has(id)) throw new PdfParseError(`${what}: duplicate Id ${id}`);
    ids.add(id);
    const external = mode === 'External';
    const part = external ? undefined : resolveTarget(source, target);
    out.push(part === undefined ? { id, type, target, external } : { id, type, target, external, part });
  }
  return out;
}

export function openOpc(bytes: Uint8Array, limits: LoadLimits = LoadLimits.defaults): OpcPackage {
  const zip = openZip(bytes, limits);
  const folded = new Map<string, string>();
  for (const e of zip.entries) {
    const key = fold(e.path);
    const prior = folded.get(key);
    if (prior !== undefined) throw new PdfParseError(`part names ${prior} and ${e.path} differ only by case`);
    folded.set(key, e.path);
  }
  const locate = (part: string): string | undefined => (zip.has(part) ? part : folded.get(fold(part)));

  const ctPath = locate(CONTENT_TYPES);
  if (ctPath === undefined) throw new PdfParseError(`not an OPC package: no ${CONTENT_TYPES}`);
  const { defaults, overrides } = parseContentTypes(zip.read(ctPath), limits);

  // A PdfParseError is cached as the answer for that source; a limit is not,
  // since it describes this call's policy rather than the file.
  // Each list travels with an Id index: m2fp.3 resolves every r:id through
  // `relationship`, and a scan there makes N links cost N^2 (final review I2).
  interface Parsed { list: readonly OpcRelationship[]; byId: Map<string, OpcRelationship>; }
  const rels = new Map<string, Parsed | PdfParseError>();
  // A source is CANONICALIZED to the package's own spelling before anything
  // else (m2fp.7): keyed on the caller's casing, `WORD/document.xml` parsed a
  // second time and resolved every `part` under the caller's prefix.
  const parsed = (asked: string): Parsed => {
    const source = asked === '' ? '' : locate(asked) ?? asked;
    const key = fold(source);
    const hit = rels.get(key);
    if (hit instanceof PdfParseError) throw hit;
    if (hit !== undefined) return hit;
    try {
      const path = locate(relsPath(source));
      const list = path === undefined ? [] : parseRels(source, zip.read(path), limits);
      const entry = { list, byId: new Map(list.map((r) => [r.id, r] as const)) };
      rels.set(key, entry);
      return entry;
    } catch (caught) {
      rethrowLimit(caught);
      if (caught instanceof PdfParseError) rels.set(key, caught);
      throw caught;
    }
  };

  return {
    zip,
    contentType(part) {
      const o = overrides.get(fold(part));
      if (o !== undefined) return o;
      const ext = extensionOf(part);
      return ext === undefined ? undefined : defaults.get(fold(ext));
    },
    relationships: (source) => parsed(source).list,
    relationship: (source, id) => parsed(source).byId.get(id),
    byType: (source, type) => parsed(source).list.filter((r) => r.type === type),
    has: (part) => locate(part) !== undefined,
    read(part) {
      const path = locate(part);
      if (path === undefined) throw new RangeError(`package holds no part ${part}`);
      return zip.read(path);
    },
  };
}
