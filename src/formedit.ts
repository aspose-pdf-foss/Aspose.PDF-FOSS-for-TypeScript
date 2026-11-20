import type { Document } from './document.js';
import type { Page } from './page.js';
import type { ContentAddr } from './editcontent.js';
import {
  parseContentStream, readContentForSplice, type ContentOp, type ContentOpSource,
  type ContentSplice, type ContentTokenBudget,
} from './content.js';
import { inflateStream } from './flate.js';
import { decodePageContentStreams, ensureOwnSubdict, MAX_XOBJECT_DEPTH, pageContentStreams } from './pagecontent.js';
import { isArray, isDict, isName, isStream, name, type PdfDict, type PdfObject, type PdfStream } from './types.js';
import { rethrowLimit, UnsupportedFeatureError } from './errors.js';
import { referencedNames } from './resprune.js';

const ALIAS_PREFIX = 'PathEdit';

function dictOf(doc: Document, value: PdfObject | undefined): PdfDict | undefined {
  const dict = doc.resolve(value);
  return isDict(dict) ? dict : undefined;
}

function isImage(doc: Document, stream: PdfStream): boolean {
  const subtype = doc.resolve(stream.dict.get('Subtype'));
  return isName(subtype) && subtype.name === 'Image';
}

function drawName(op: ContentOp | undefined): string | undefined {
  if (op?.operator !== 'Do') return undefined;
  const target = op.operands[0];
  return isName(target) ? target.name : undefined;
}

/** Reserve unresolved names in joined page content and reachable resource streams. */
function reserveDrawNames(doc: Document, page: Page, pageResources: PdfDict | undefined): Set<string> {
  const names = new Set<string>();
  const tokens: ContentTokenBudget = { tokens: 0 };
  const scopes = new Map([[pageResources, 0]]);
  const inheritedPrograms = new Set<PdfStream>();
  const visited = new Map<PdfStream, Map<PdfDict | undefined, number>>();
  const pending: { stream: PdfStream; scope: PdfDict | undefined; depth: number }[] = [];
  const queue = (stream: PdfStream, scope: PdfDict | undefined, depth: number) => {
    if (depth > MAX_XOBJECT_DEPTH) return;
    let visitedScopes = visited.get(stream);
    if (!visitedScopes) visited.set(stream, visitedScopes = new Map());
    if ((visitedScopes.get(scope) ?? Infinity) <= depth) return;
    visitedScopes.set(scope, depth);
    pending.push({ stream, scope, depth });
    if ((scopes.get(scope) ?? Infinity) <= depth) return;
    scopes.set(scope, depth);
    for (const program of inheritedPrograms) queue(program, scope, depth + 1);
  };
  // A pattern, glyph or mask without resources can use the scope where it
  // paints, even when it was selected in an enclosing scope.
  const queueProgram = (stream: PdfStream, own: PdfDict | undefined, depth: number) => {
    if (depth > MAX_XOBJECT_DEPTH) return;
    if (own) { queue(stream, own, depth); return; }
    if (inheritedPrograms.has(stream)) return;
    inheritedPrograms.add(stream);
    for (const [scope, scopeDepth] of scopes) queue(stream, scope, scopeDepth + 1);
  };
  const queueFont = (value: PdfObject | undefined, depth: number) => {
    const font = dictOf(doc, value);
    const procs = dictOf(doc, font?.get('CharProcs'));
    if (!procs) return;
    const own = dictOf(doc, font?.get('Resources'));
    for (const proc of procs.values()) {
      const stream = doc.resolve(proc);
      if (isStream(stream)) queueProgram(stream, own, depth);
    }
  };
  const scan = (refs: ReturnType<typeof referencedNames>, scope: PdfDict | undefined, depth: number) => {
    const xobjects = dictOf(doc, scope?.get('XObject'));
    for (const key of refs.get('XObject') ?? []) {
      if (key.startsWith(ALIAS_PREFIX)) names.add(key);
      const target = doc.resolve(xobjects?.get(key));
      if (isStream(target) && !isImage(doc, target)) queue(target, dictOf(doc, target.dict.get('Resources')) ?? scope, depth + 1);
    }
    const patterns = dictOf(doc, scope?.get('Pattern'));
    for (const key of refs.get('Pattern') ?? []) {
      const pattern = doc.resolve(patterns?.get(key));
      if (isStream(pattern)) queueProgram(pattern, dictOf(doc, pattern.dict.get('Resources')), depth + 1);
    }
    const fonts = dictOf(doc, scope?.get('Font'));
    for (const key of refs.get('Font') ?? []) queueFont(fonts?.get(key), depth + 1);
    const states = dictOf(doc, scope?.get('ExtGState'));
    for (const key of refs.get('ExtGState') ?? []) {
      const state = dictOf(doc, states?.get(key));
      const mask = doc.resolve(dictOf(doc, state?.get('SMask'))?.get('G'));
      if (isStream(mask)) queueProgram(mask, dictOf(doc, mask.dict.get('Resources')), depth + 1);
      const font = doc.resolve(state?.get('Font'));
      if (isArray(font)) queueFont(font[0], depth + 1);
    }
  };
  scan(referencedNames(parseContentStream(page.Contents, doc.loadLimits, tokens)), pageResources, 0);
  // Rendering reads the joined bytes. Extraction addresses operators in each
  // stream independently, so damaged operands can yield a second set of draws.
  const pageStreams = pageContentStreams(doc, page);
  if (pageStreams.length > 1) {
    const addressTokens: ContentTokenBudget = { tokens: 0 };
    for (const bytes of decodePageContentStreams(pageStreams)) {
      scan(referencedNames(parseContentStream(bytes, doc.loadLimits, addressTokens)), pageResources, 0);
    }
  }

  const queueAppearance = (value: PdfObject | undefined) => {
    const stream = doc.resolve(value);
    if (isStream(stream)) queue(stream, dictOf(doc, stream.dict.get('Resources')) ?? pageResources, 1);
  };
  const annots = doc.resolve(page.Dict.get('Annots'));
  if (isArray(annots)) for (const item of annots) {
    const appearance = dictOf(doc, dictOf(doc, item)?.get('AP'));
    for (const key of ['N', 'R', 'D']) {
      const entry = doc.resolve(appearance?.get(key));
      if (isDict(entry)) for (const value of entry.values()) queueAppearance(value);
      else queueAppearance(entry);
    }
  }

  const parsed = new Map<PdfStream, { refs: ReturnType<typeof referencedNames>; tokens: number } | null>();
  for (const { stream, scope, depth } of pending) {
    if (visited.get(stream)?.get(scope) !== depth) continue;
    let entry = parsed.get(stream);
    if (entry === null) continue;
    if (entry) doc.loadLimits.enforce('maxContentTokens', tokens.tokens += entry.tokens, 'Form edit alias scan');
    else {
      const before = tokens.tokens;
      let refs: ReturnType<typeof referencedNames>;
      try { refs = referencedNames(parseContentStream(inflateStream(stream), doc.loadLimits, tokens)); }
      catch (caught) { rethrowLimit(caught); parsed.set(stream, null); continue; }
      entry = { refs, tokens: tokens.tokens - before };
      parsed.set(stream, entry);
    }
    scan(entry.refs, scope, depth);
  }
  return names;
}

interface ResourceScope {
  original?: PdfDict;
  copy?: PdfDict;
  xobjects?: PdfDict;
}

interface FormOccurrence {
  form: PdfStream;
  source: ContentOpSource;
  scope: ResourceScope;
  ownsResources: boolean;
  parent?: FormOccurrence;
  opIndex: number;
  splices: ContentSplice[];
  backEdges: { caller: FormOccurrence; opIndex: number }[];
  clone?: PdfStream;
}

/** Plan the selected occurrence and any cycle edges made reachable by cloning.
 * No changes reach the document until the caller publishes the staged result. */
export function planFormEdit(
  doc: Document, page: Page, top: ContentOpSource, invocations: readonly ContentAddr[],
  edit: (source: ContentOpSource) => ContentSplice, tokens: ContentTokenBudget,
): { bytes: Uint8Array; resources: PdfDict; additions: { owner: PdfDict; key: string; form: PdfStream }[] } {
  const pageScope: ResourceScope = { original: page.Resources };
  const calledForm = (scope: ResourceScope, op: ContentOp | undefined): PdfStream | undefined => {
    const key = drawName(op);
    if (key === undefined) return undefined;
    const target = doc.resolve(dictOf(doc, scope.original?.get('XObject'))?.get(key));
    return isStream(target) && !isImage(doc, target) ? target : undefined;
  };
  const topIndex = invocations[0].opIndex;
  const selected = calledForm(pageScope, top.ops[topIndex]);
  if (!selected) throw new RangeError('missing Form draw');

  const reserved = reserveDrawNames(doc, page, pageScope.original);
  const aliases: { owner: PdfDict; key: string; target: FormOccurrence }[] = [];
  let aliasIndex = 0;
  const replacement = (scope: ResourceScope, opIndex: number, target: FormOccurrence): ContentSplice => {
    const copy = scope.copy ??= new Map(scope.original);
    const owner = scope.xobjects ??= ensureOwnSubdict(doc, copy, 'XObject');
    let key: string;
    do { key = `${ALIAS_PREFIX}${aliasIndex++}`; } while (owner.has(key) || reserved.has(key));
    aliases.push({ owner, key, target });
    return { first: opIndex, end: opIndex + 1, ops: [{ operator: 'Do', operands: [name(key)] }] };
  };

  const parsed = new Map<PdfStream, { source: ContentOpSource; tokens: number }>();
  const active = new Map<PdfDict, FormOccurrence>();
  const copies = new Set<FormOccurrence>();
  const readSource = (form: PdfStream): ContentOpSource => {
    const cached = parsed.get(form);
    if (cached) {
      // Reusing parsed bytes saves allocations, but each scan of the operators
      // still counts against the shared occurrence walk budget.
      doc.loadLimits.enforce('maxContentTokens', tokens.tokens += cached.tokens, 'Form path edit');
      return cached.source;
    }
    const before = tokens.tokens;
    const source = readContentForSplice(inflateStream(form), doc.loadLimits, tokens);
    parsed.set(form, { source, tokens: tokens.tokens - before });
    return source;
  };
  const collect = (
    form: PdfStream, opIndex: number, parent?: FormOccurrence, selection?: number,
  ): FormOccurrence | undefined => {
    let source: ContentOpSource;
    try { source = readSource(form); }
    catch (caught) {
      rethrowLimit(caught);
      if (selection !== undefined) throw caught;
      return undefined;
    }

    const own = dictOf(doc, form.dict.get('Resources'));
    const scope: ResourceScope = own ? { original: own } : parent?.scope ?? pageScope;
    const occurrence: FormOccurrence = {
      form, source, scope, ownsResources: own !== undefined, parent, opIndex, splices: [], backEdges: [],
    };
    const next = selection === undefined ? undefined : invocations[selection + 1];
    if (selection !== undefined) {
      copies.add(occurrence);
      if (!next) occurrence.splices.push(edit(source));
    }
    active.set(form.dict, occurrence);
    let followedSelection = false;
    if (active.size < MAX_XOBJECT_DEPTH) {
      for (const [opIndex, op] of source.ops.entries()) {
        const target = calledForm(scope, op);
        if (!target) continue;
        const ancestor = active.get(target.dict);
        if (ancestor) {
          ancestor.backEdges.push({ caller: occurrence, opIndex });
          continue;
        }
        const followsSelection = next?.opIndex === opIndex;
        const child = collect(target, opIndex, occurrence, followsSelection ? selection! + 1 : undefined);
        if (child && followsSelection) followedSelection = true;
      }
    }
    active.delete(form.dict);
    if (next && !followedSelection) throw new RangeError('missing nested Form draw');
    return occurrence;
  };

  const root = collect(selected, topIndex, undefined, 0)!;
  // A back-edge only needs repair when its target is being copied. Copy the
  // invoking branch as far as the nearest existing copy. Set iteration also
  // visits those new copies so their own incoming back-edges are repaired.
  for (const target of copies) {
    for (const { caller, opIndex } of target.backEdges) {
      caller.splices.push(replacement(caller.scope, opIndex, target));
      for (let node: FormOccurrence | undefined = caller; node && !copies.has(node); node = node.parent) copies.add(node);
    }
  }
  for (const target of copies) {
    const { parent, opIndex } = target;
    if (parent) parent.splices.push(replacement(parent.scope, opIndex, target));
  }
  const topSplice = replacement(pageScope, topIndex, root);

  for (const occurrence of copies) {
    const { form, source, splices, ownsResources, scope } = occurrence;
    if (form.dict.has('StructParents') || form.dict.has('StructParent'))
      throw new UnsupportedFeatureError('cannot edit a Form occurrence with a structure-parent entry');

    const raw = source.replaceAll(splices);
    const dict = new Map(form.dict);
    for (const key of ['Filter', 'DecodeParms', 'F', 'FFilter', 'FDecodeParms', 'DL']) dict.delete(key);
    dict.set('Length', raw.length);
    if (ownsResources && scope.copy) dict.set('Resources', scope.copy);
    occurrence.clone = { kind: 'stream', dict, raw };
  }
  const additions = aliases.map(({ owner, key, target }) => ({ owner, key, form: target.clone! }));
  return { bytes: top.replaceAll([topSplice]), resources: pageScope.copy!, additions };
}
