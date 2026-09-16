/** ISO 14289-2 clauses 8.7, 8.8 and 8.14.1 — optional content, intra-document
 *  destinations and embedded files, five of the 11 rules `q7hc.4.4` added.
 *
 *  Transcribed from veraPDF/veraPDF-validation-profiles@integration
 *  `PDF_UA/2/8.7`, `PDF_UA/2/8.8` and `PDF_UA/2/8.14`, plus
 *  `veraPDF-parser`'s `PDDestination.java` and `PDAction.java`, which between
 *  them define what a structure destination IS. Fetched 2026-09-16. A
 *  TRANSCRIPTION and not a runnable oracle — `72nc.1`'s ceiling.
 *
 *  **Invariant:** its own module beside `uaannot.ts`, `uafont.ts` and
 *  `uatext.ts`, all four over `uarule.ts`. The split is by SUBJECT.
 *
 *  **Invariant:** NOTHING here is converted, and `ConvertToPdfUa` gains no
 *  pass. Synthesizing an optional-content `/Name` or an attachment `/Desc`
 *  invents text the document does not contain; stripping `/AS` is destructive,
 *  and `ocusage.ts` records that `/AS` is precisely what makes a `/Usage` do
 *  anything, so removing it silently changes what the document intends; and
 *  rewriting an outline destination is the trade-off `q7hc.4.4` declined.
 *  @internal */
import { isDict, isName, isString, type PdfDict, type PdfObject } from './types.js';
import { textOf, uaClause, type Rule, type UaCtx } from './uarule.js';
import { collectNameTree } from './nametree.js';
import type { ValidationIssue } from './validation.js';

// ---- 8.7 — optional content -------------------------------------------------

/** Every optional-content configuration dictionary: `/D` plus each `/Configs`
 *  entry, which is exactly the population veraPDF models as `PDOCConfig`. */
function ocConfigs(ctx: UaCtx): PdfDict[] {
  const props = ctx.doc.resolve(ctx.catalog.get('OCProperties'));
  if (!isDict(props)) return [];
  const out: PdfDict[] = [];
  const d = ctx.doc.resolve(props.get('D'));
  if (isDict(d)) out.push(d);
  const cfgs = ctx.doc.resolve(props.get('Configs'));
  if (Array.isArray(cfgs)) {
    for (const c of cfgs) {
      const r = ctx.doc.resolve(c);
      if (isDict(r)) out.push(r);
    }
  }
  return out;
}

/** 8.7-1: every optional-content configuration needs a non-empty /Name — but
 *  ONLY when the catalog's /OCProperties carries a /Configs entry.
 *
 *  Profile test:
 *  `gContainsConfigs == false || (Name != null && Name.length() > 0)`.
 *
 *  **Invariant, and the issue text got this wrong:** `gContainsConfigs` is a
 *  document-level VARIABLE over `PDOCProperties` (`containsConfigs`). A
 *  document carrying only a `/D` is exempt ENTIRELY. So "including the default"
 *  means `/D` is examined WHEN a `/Configs` array is present — not that `/D`
 *  always needs a name. A fixture with only a `/D` measures nothing whatever
 *  the code does. */
const ocConfigNameRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const props = ctx.doc.resolve(ctx.catalog.get('OCProperties'));
  // Presence on the RAW dict, since `doc.resolve(undefined)` is `null`.
  if (!isDict(props) || !props.has('Configs')) return [];
  const issues: ValidationIssue[] = [];
  for (const cfg of ocConfigs(ctx)) {
    const n = textOf(ctx, cfg.get('Name'));
    if (n !== undefined && n !== '') continue;
    issues.push({
      rule: 'OcConfigName', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.7' }),
      message: 'An optional content configuration dictionary has a missing or '
        + 'empty /Name entry.',
    });
  }
  return issues;
};

/** 8.7-2: /AS shall not appear in any configuration dictionary.
 *
 *  **Note what this prohibits outright:** `ocusage.ts` records that a `/Usage`
 *  ALONE IS INERT and that an `/AS` entry is what makes a usage application do
 *  anything. So PDF/UA-2 bans automatic usage application altogether — a
 *  document may still carry `/Usage`, and nothing will ever apply it.
 *
 *  Unlike 8.7-1 this is NOT gated on `/Configs`: the profile test is
 *  `AS == null` with no variable guarding it, so a `/D` alone is examined. */
const ocConfigAsRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const cfg of ocConfigs(ctx)) {
    if (!cfg.has('AS')) continue;
    issues.push({
      rule: 'OcConfigAs', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.7' }),
      message: 'An optional content configuration dictionary contains the '
        + 'prohibited /AS entry.',
    });
  }
  return issues;
};

// ---- 8.14.1 — descriptions for embedded files -------------------------------

/** 8.14.1-1: a file specification in /EmbeddedFiles needs a /Desc.
 *
 *  Profile test: `containsDesc == true || presentInEmbeddedFiles == false`. The
 *  escape is what keeps a `/FileAttachment` annotation's `/FS` — a file
 *  specification that is not in the name tree — out of the rule, so the walk
 *  starts FROM the name tree rather than from every filespec in the file. */
const embeddedFileDescRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const names = ctx.doc.resolve(ctx.catalog.get('Names'));
  if (!isDict(names)) return [];
  const issues: ValidationIssue[] = [];
  const entries: Array<[string, PdfObject]> = [];
  collectNameTree(ctx.doc, names.get('EmbeddedFiles') ?? null, entries);
  for (const [key, value] of entries) {
    const fs = ctx.doc.resolve(value);
    if (!isDict(fs) || fs.has('Desc')) continue;
    issues.push({
      rule: 'EmbeddedFileDesc', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.14.1' }),
      message: `The embedded file '${key}' has no /Desc entry describing it.`,
    });
  }
  return issues;
};

// ---- 8.8 — intra-document destinations --------------------------------------

/** Resolve a NAMED destination: a STRING through `/Root /Names /Dests`, a NAME
 *  through the catalog's own `/Dests` dictionary.
 *
 *  The two are DIFFERENT mechanisms and both are in the transcribed source —
 *  `PDDestination.getIsStructDestination` branches on the COS type. A name that
 *  resolves to nothing returns `undefined`, and the caller then reports, which
 *  is veraPDF's answer too (it logs and returns false). */
function resolveNamedDest(ctx: UaCtx, dest: PdfObject): PdfObject | undefined {
  if (isString(dest)) {
    const names = ctx.doc.resolve(ctx.catalog.get('Names'));
    if (!isDict(names)) return undefined;
    const want = decodeLatin1(dest.bytes);
    const entries: Array<[string, PdfObject]> = [];
    collectNameTree(ctx.doc, names.get('Dests') ?? null, entries);
    for (const [k, v] of entries) if (k === want) return ctx.doc.resolve(v);
    return undefined;
  }
  if (isName(dest)) {
    const dests = ctx.doc.resolve(ctx.catalog.get('Dests'));
    if (!isDict(dests)) return undefined;
    const v = dests.get(dest.name);
    return v === undefined ? undefined : ctx.doc.resolve(v);
  }
  return undefined;
}

/** A destination NAME is a byte string compared literally, never decoded as
 *  document text — `collectNameTree` keys are latin1 of the raw bytes. */
function decodeLatin1(b: Uint8Array): string {
  return String.fromCharCode(...b);
}

/** Is this destination a STRUCTURE destination?
 *
 *  Transcribed from `veraPDF-parser`'s `PDDestination.getIsStructDestination`:
 *  a NAME or STRING is resolved through the catalog's `/Dests` dictionary or
 *  the `/Names /Dests` name tree FIRST — and a name that does not resolve is
 *  NOT a structure destination — then a DICT qualifies by carrying `/SD`, and
 *  an ARRAY by its FIRST ELEMENT carrying `/S`.
 *
 *  **Invariant, and it is the whole rule:** `at(0).knownKey('S')` means the
 *  first element is a STRUCTURE ELEMENT rather than a page. A structure element
 *  dictionary always carries `/S`, its type; a page never does. Testing for
 *  `/Type /StructElem` instead would miss every element that omits that
 *  optional key. */
function isStructDestination(ctx: UaCtx, destObj: PdfObject | undefined): boolean {
  let dest = ctx.doc.resolve(destObj);
  if (isString(dest) || isName(dest)) {
    const resolved = resolveNamedDest(ctx, dest);
    if (resolved === undefined) return false;
    dest = resolved;
  }
  if (isDict(dest)) return dest.has('SD');
  if (Array.isArray(dest) && dest.length > 0) {
    const first = ctx.doc.resolve(dest[0]);
    return isDict(first) && first.has('S');
  }
  return false;
}

/** Every in-document destination, with a label for the message. */
function documentDestinations(ctx: UaCtx): { where: string; dest: PdfObject }[] {
  const out: { where: string; dest: PdfObject }[] = [];
  // The outline MODEL normalizes a destination into a page number, so the raw
  // /Dest is read from the dictionaries themselves -- only the raw value can
  // say whether the first array element is a page or a structure element.
  const outlineRoot = ctx.doc.resolve(ctx.catalog.get('Outlines'));
  if (isDict(outlineRoot)) {
    const visit = (nodeObj: PdfObject | undefined, depth: number): void => {
      if (depth > 64) return;
      const node = ctx.doc.resolve(nodeObj);
      if (!isDict(node)) return;
      const d = node.get('Dest');
      if (d !== undefined) out.push({ where: 'An outline item destination', dest: d });
      visit(node.get('First'), depth + 1);
      visit(node.get('Next'), depth + 1);
    };
    visit(outlineRoot.get('First'), 0);
  }
  // /OpenAction is a destination only when it is an ARRAY or a name; an action
  // dictionary goes through the GoTo rule instead.
  const open = ctx.catalog.get('OpenAction');
  const openR = ctx.doc.resolve(open);
  if (open !== undefined && !isDict(openR)) {
    out.push({ where: 'The document /OpenAction', dest: open });
  }
  const names = ctx.doc.resolve(ctx.catalog.get('Names'));
  if (isDict(names)) {
    const entries: Array<[string, PdfObject]> = [];
    collectNameTree(ctx.doc, names.get('Dests') ?? null, entries);
    for (const [k, v] of entries) {
      out.push({ where: `The named destination '${k}'`, dest: v });
    }
  }
  return out;
}

/** Every GoTo action dictionary in the document, with a label. */
function goToActions(ctx: UaCtx): { where: string; action: PdfDict }[] {
  const out: { where: string; action: PdfDict }[] = [];
  const add = (where: string, obj: PdfObject | undefined): void => {
    const a = ctx.doc.resolve(obj);
    if (!isDict(a)) return;
    const s = ctx.doc.resolve(a.get('S'));
    if (isName(s) && s.name === 'GoTo') out.push({ where, action: a });
  };
  add('The document /OpenAction', ctx.catalog.get('OpenAction'));
  for (const page of ctx.doc.Pages) {
    for (const annot of page.Annotations) add("An annotation's action", annot.Dict.get('A'));
  }
  const outlineRoot = ctx.doc.resolve(ctx.catalog.get('Outlines'));
  if (isDict(outlineRoot)) {
    const visit = (nodeObj: PdfObject | undefined, depth: number): void => {
      if (depth > 64) return;
      const node = ctx.doc.resolve(nodeObj);
      if (!isDict(node)) return;
      add("An outline item's action", node.get('A'));
      visit(node.get('First'), depth + 1);
      visit(node.get('Next'), depth + 1);
    };
    visit(outlineRoot.get('First'), 0);
  }
  return out;
}

/** 8.8-1: an in-document destination shall be a structure destination.
 *
 *  **Note this reports on documents THIS LIBRARY authors.** `SetOutlines`,
 *  `/OpenAction` and named destinations all emit page destinations, and
 *  `q7hc.4.4` deliberately did NOT change them: an outline item's `/Dest` is
 *  tested directly, so satisfying it means replacing the page reference with a
 *  structure element — a destination a PDF 1.7 viewer cannot resolve. Trading
 *  navigation in every existing viewer for a conformance line is the caller's
 *  decision, so the rule reports and conversion leaves it unresolved, exactly
 *  as `FontNotEmbedded` does. Only GoTo ACTIONS were changed, because `/SD`
 *  sits BESIDE `/D` there and costs no compatibility. */
const destinationRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { where, dest } of documentDestinations(ctx)) {
    if (isStructDestination(ctx, dest)) continue;
    issues.push({
      rule: 'DestinationNotStructure', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.8' }),
      message: `${where} targets a page rather than a structure element.`,
    });
  }
  return issues;
};

/** 8.8-2: a GoTo action shall carry a structure destination.
 *
 *  **Invariant, and it is NOT 8.8-1's test:**
 *  `PDAction.containsStructureDestination` answers true for `/SD`, or for a
 *  `/D` that is a NAME or STRING resolving to a structure destination — and
 *  FALLS THROUGH TO FALSE for a `/D` that is a direct ARRAY, even when that
 *  array IS a structure destination. So an action can satisfy this only through
 *  `/SD` or a named destination. Writing a structure-destination array into
 *  `/D` provably cannot satisfy it, which is why the authoring change adds
 *  `/SD` rather than rewriting `/D`. */
const goToActionRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { where, action } of goToActions(ctx)) {
    if (action.has('SD')) continue;
    const d = ctx.doc.resolve(action.get('D'));
    if ((isString(d) || isName(d)) && isStructDestination(ctx, d)) continue;
    issues.push({
      rule: 'GoToNotStructure', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.8' }),
      message: `${where} carries no structure destination (/SD).`,
    });
  }
  return issues;
};

export const DOC_RULES: Rule[] = [
  ocConfigNameRule, ocConfigAsRule, embeddedFileDescRule,
  destinationRule, goToActionRule,
];
