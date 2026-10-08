/** `readDocx` (`m2fp.3`): a `.docx` package to a resolved `WmlDocument`,
 *  wiring `opcread.ts` to the pure `wml*` modules. The only module of the set
 *  that touches a package.
 *
 *  **Invariant:** styles, numbering and theme are found through the MAIN
 *  DOCUMENT's relationships, by type — never by a fixed path, since a producer
 *  may name them anything. Transitional and Strict relationship types are both
 *  accepted.
 *
 *  **Invariant:** an unreadable OPTIONAL part (styles, numbering, theme, the
 *  main document's relationships) degrades to its empty value and is recorded
 *  (`styles.xml: unreadable`): the document's text is still readable. A
 *  relationship naming a part the package does not hold degrades the same way
 *  and is recorded as `styles.xml: missing` (`m2fp.9`). An
 *  unreadable main document, or none, is `PdfParseError`.
 *
 *  `openDocx` (`m2fp.5`) is the same read plus what rendering needs and the
 *  model does not carry: a lazy part reader (image bytes, charged to the
 *  archive's limits), fontTable.xml's generic class per font name, and
 *  docProps/core.xml's title. Each degrades like the other optional parts. */
import { openOpc, OFFICE_DOCUMENT, STYLES, NUMBERING, type OpcPackage, type OpcRelationship } from './opcread.js';
import { parseTheme, parseStyles, emptyStyles, EMPTY_THEME, type ThemeFonts, type WmlStyles, parseDefaultTabStop } from './wmlstyles.js';
import { parseNumbering, EMPTY_NUMBERING, type WmlNumbering } from './wmlnumbering.js';
import { parseBody, parseNotes, type BodyRel, type WmlBlock, type WmlPage } from './wmlbody.js';
import { parseSettingsNotes, type WmlSectionNotes } from './wmlnotes.js';
import { LoadLimits } from './loadlimits.js';
import { PdfParseError, rethrowLimit } from './errors.js';
import { parseWml, W, wAttr, wChild, wChildren } from './wmlns.js';
import { parseNsXml, nsChild } from './xmlns.js';

export interface WmlDocument {
  blocks: WmlBlock[];
  page?: WmlPage;
  /** Every construct seen and not modelled, by qualified name, sorted by name. */
  unsupported: { name: string; count: number }[];
  /** Footnote / endnote bodies by w:id (v9j3.3.2); undefined when the document
   *  has no usable part — a missing or unreadable one is also recorded. */
  footnotes?: Map<string, WmlBlock[]>;
  endnotes?: Map<string, WmlBlock[]>;
  /** Note numbering properties: settings.xml's, and the LAST section's. */
  notePr: { settings: WmlSectionNotes; last: WmlSectionNotes };
  /** settings.xml's `w:defaultTabStop`, in points (v9j3.1); absent when unstated. */
  defaultTabStopPt?: number;
}

export type FontClass = 'serif' | 'sans-serif' | 'monospace';
export interface OpenedDocx {
  doc: WmlDocument;
  /** A part's bytes and content type; undefined for a part the package lacks
   *  or cannot decode (the caller reports it). Charged to the archive's limits. */
  readPart(part: string): { bytes: Uint8Array; contentType?: string } | undefined;
  /** fontTable.xml's w:family per font name, mapped to a generic class. */
  fontClass(name: string): FontClass | undefined;
  /** docProps/core.xml's dc:title, trimmed; undefined when absent or blank. */
  title?: string;
}

const FONT_TABLE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable';
const CORE = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';
const DC = 'http://purl.org/dc/elements/1.1/';
const FAMILY: Readonly<Record<string, FontClass>> = { roman: 'serif', swiss: 'sans-serif', modern: 'monospace' };

/** fontTable.xml's w:family per font (ECMA-376 17.8.3.10), to the generic a
 *  missing face falls back to — the producer's own classification, where
 *  cssfont.ts refuses to guess one from a name. script/decorative/auto have no
 *  Standard-14 analogue and take sans-serif. */
function parseFontTable(bytes: Uint8Array, limits: LoadLimits): Map<string, FontClass> {
  const root = parseWml(bytes, limits);
  if (root.ns !== W || root.local !== 'fonts') throw new PdfParseError('fontTable.xml: the root is not w:fonts');
  const out = new Map<string, FontClass>();
  for (const f of wChildren(root, 'font')) {
    const name = wAttr(f, 'name');
    const fam = wAttr(wChild(f, 'family'), 'val');
    if (name === undefined || fam === undefined || out.has(name)) continue;
    out.set(name, Object.hasOwn(FAMILY, fam) ? FAMILY[fam] : 'sans-serif');
  }
  return out;
}

const THEME = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme';
const FOOTNOTES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes';
const ENDNOTES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes';
const SETTINGS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings';
const STRICT_REL = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const strictTwin = (type: string): string => `${STRICT_REL}/${type.slice(type.lastIndexOf('/') + 1)}`;
const isType = (r: OpcRelationship, type: string): boolean => r.type === type || r.type === strictTwin(type);

/** The main document: the FIRST `officeDocument` relationship of the package
 *  root, in file order, transitional or Strict (m2fp.7). ECMA-376 Part 2 allows
 *  exactly one, so several is damage; we take the first rather than refuse, and
 *  do NOT fall through to a later one when the first names no held part — a
 *  reader that searched would disagree with one that did not about which
 *  document the package holds. This lives here, not in `opcread.ts`, because
 *  only this module knows the Strict twin of the type. */
function mainPart(pkg: OpcPackage): string {
  const main = pkg.relationships('').find((r) => isType(r, OFFICE_DOCUMENT));
  if (!main?.part || !pkg.has(main.part)) throw new PdfParseError('not a WordprocessingML document: no main document part');
  return main.part;
}

export function readDocx(bytes: Uint8Array, limits: LoadLimits = LoadLimits.defaults): WmlDocument {
  return openDocx(bytes, limits).doc;
}

export function openDocx(bytes: Uint8Array, limits: LoadLimits = LoadLimits.defaults): OpenedDocx {
  const pkg = openOpc(bytes, limits);
  const main = mainPart(pkg);
  const unsupported = new Map<string, number>();
  const note = (name: string, count = 1): void => { unsupported.set(name, (unsupported.get(name) ?? 0) + count); };

  let rels: readonly OpcRelationship[] = [];
  try { rels = pkg.relationships(main); } catch (caught) { rethrowLimit(caught); note('document.xml.rels: unreadable'); }
  const byId = new Map(rels.map((r) => [r.id, r]));
  const optional = <T>(role: string, type: string, parse: (b: Uint8Array) => T, empty: T): T => {
    const r = rels.find((x) => isType(x, type));
    if (r === undefined) return empty;
    // A relationship naming a part the package lacks is DAMAGE, not absence (m2fp.9).
    if (r.part === undefined || !pkg.has(r.part)) { note(`${role}: missing`); return empty; }
    const part = r.part;
    try { return parse(pkg.read(part)); } catch (caught) { rethrowLimit(caught); note(`${role}: unreadable`); return empty; }
  };

  const theme: ThemeFonts = optional('theme', THEME, (b) => parseTheme(b, limits), EMPTY_THEME);
  const styles: WmlStyles = optional('styles.xml', STYLES, (b) => parseStyles(b, theme, limits), emptyStyles(theme, limits));
  const numbering: WmlNumbering = optional('numbering.xml', NUMBERING, (b) => parseNumbering(b, limits), EMPTY_NUMBERING);
  const settingsNotes: WmlSectionNotes = optional('settings.xml', SETTINGS, (b) => parseSettingsNotes(b, limits), {});

  const defaultTabStop = optional('settings.xml', SETTINGS, (b) => parseDefaultTabStop(b, limits), undefined);
  const fontClasses = optional('fontTable.xml', FONT_TABLE, (b) => parseFontTable(b, limits), new Map<string, FontClass>());

  let title: string | undefined;
  let coreRel: OpcRelationship | undefined;
  try { coreRel = pkg.relationships('').find((x) => x.type === CORE); } catch (caught) { rethrowLimit(caught); }
  if (coreRel?.part !== undefined && pkg.has(coreRel.part)) {
    try {
      const t = nsChild(parseNsXml(pkg.read(coreRel.part), limits), DC, 'title')?.text.trim();
      if (t) title = t;
    } catch (caught) { rethrowLimit(caught); note('core.xml: unreadable'); }
  }

  const readPart = (part: string): { bytes: Uint8Array; contentType?: string } | undefined => {
    if (!pkg.has(part)) return undefined;
    try {
      const data = pkg.read(part);
      const contentType = pkg.contentType(part);
      return contentType === undefined ? { bytes: data } : { bytes: data, contentType };
    } catch (caught) { rethrowLimit(caught); return undefined; }
  };

  // opcread sets `part` for any internal target, held or not; a part the
  // package does not hold is no part, or m2fp.5's read of it throws (final review).
  const rel = (id: string): BodyRel | undefined => {
    const r = byId.get(id);
    if (r?.part === undefined || pkg.has(r.part)) return r;
    return { target: r.target, external: r.external };
  };
  // A notes part resolves r:ids against ITS OWN relationships (v9j3.3.2).
  const relOf = (part: string): ((id: string) => BodyRel | undefined) => {
    let prs: readonly OpcRelationship[] = [];
    try { prs = pkg.relationships(part); } catch (caught) { rethrowLimit(caught); note(`${part.slice(part.lastIndexOf('/') + 1)}.rels: unreadable`); }
    const ids = new Map(prs.map((x) => [x.id, x]));
    return (id) => {
      const x = ids.get(id);
      if (x?.part === undefined || pkg.has(x.part)) return x;
      return { target: x.target, external: x.external };
    };
  };
  const notesOf = (kind: 'footnote' | 'endnote', type: string): Map<string, WmlBlock[]> | undefined => {
    const role = `${kind}s.xml`;
    const r = rels.find((x) => isType(x, type));
    if (r === undefined) return undefined;
    if (r.part === undefined || !pkg.has(r.part)) { note(`${role}: missing`); return undefined; }
    try {
      const got = parseNotes(pkg.read(r.part), { styles, numbering, limits, rel: relOf(r.part) }, kind);
      for (const [name, count] of got.unsupported) note(name, count);
      return got.notes;
    } catch (caught) { rethrowLimit(caught); note(`${role}: unreadable`); return undefined; }
  };
  const footnotes = notesOf('footnote', FOOTNOTES);
  const endnotes = notesOf('endnote', ENDNOTES);
  const body = parseBody(pkg.read(main), { styles, numbering, limits, rel });
  for (const [name, count] of body.unsupported) note(name, count);
  const doc: WmlDocument = {
    blocks: body.blocks,
    unsupported: [...unsupported].map(([name, count]) => ({ name, count })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    notePr: { settings: settingsNotes, last: body.lastSection },
  };
  if (footnotes) doc.footnotes = footnotes;
  if (endnotes) doc.endnotes = endnotes;
  if (body.page) doc.page = body.page;
  if (defaultTabStop !== undefined) doc.defaultTabStopPt = defaultTabStop;
  const opened: OpenedDocx = { doc, readPart, fontClass: (name) => fontClasses.get(name) };
  if (title !== undefined) opened.title = title;
  return opened;
}
