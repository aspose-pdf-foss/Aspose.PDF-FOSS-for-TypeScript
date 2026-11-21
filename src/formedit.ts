import type { Document } from './document.js';
import type { Page } from './page.js';
import type { ContentAddr } from './editcontent.js';
import {
  parseContentStream, readContentForSplice, type ContentOp, type ContentOpSource,
  type ContentSplice, type ContentTokenBudget, type ContentWrap,
} from './content.js';
import { inflateStream } from './flate.js';
import { decodePageContentStreams, ensureOwnSubdict, MAX_XOBJECT_DEPTH, pageContentStreams } from './pagecontent.js';
import { isArray, isDict, isName, isStream, name, type PdfDict, type PdfObject, type PdfStream } from './types.js';
import { rethrowLimit, UnsupportedFeatureError } from './errors.js';
import { referencedNames } from './resprune.js';
import { pagePatternPaint, pathConstruction, trackPatternPaint, trackPatternSites, type PatternBinding, type PatternPaintState } from './formpattern.js';

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
      if (key.startsWith(ALIAS_PREFIX)) names.add(key);
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
  patterns?: PdfDict;
}

type Invocation = { kind: 'form'; opIndex: number }
  | { kind: 'pattern'; site: ContentWrap; binding: PatternBinding };

interface Occurrence {
  stream: PdfStream;
  source: ContentOpSource;
  scope: ResourceScope;
  ownsResources: boolean;
  parent?: Occurrence;
  invocation: Invocation;
  editedPath?: ContentSplice;
  splices: (ContentSplice | ContentWrap)[];
  sites: ContentWrap[];
  backEdges: { caller: Occurrence; invocation: Invocation }[];
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
  const aliases: { owner: PdfDict; key: string; target: Occurrence }[] = [];
  let aliasIndex = 0;
  const newAlias = (scope: ResourceScope, category: 'XObject' | 'Pattern') => {
    const copy = scope.copy ??= new Map(scope.original);
    const owner = category === 'XObject' ? (scope.xobjects ??= ensureOwnSubdict(doc, copy, category))
      : (scope.patterns ??= ensureOwnSubdict(doc, copy, category));
    let key: string;
    do { key = `${ALIAS_PREFIX}${aliasIndex++}`; } while (owner.has(key) || reserved.has(key));
    return { owner, key };
  };
  const aliasCopy = (scope: ResourceScope, category: 'XObject' | 'Pattern', target: Occurrence): string => {
    const { owner, key } = newAlias(scope, category);
    aliases.push({ owner, key, target });
    return key;
  };
  const replacement = (scope: ResourceScope, opIndex: number, target: Occurrence): ContentSplice => {
    const key = aliasCopy(scope, 'XObject', target);
    return { first: opIndex, end: opIndex + 1, ops: [{ operator: 'Do', operands: [name(key)] }] };
  };
  const selectPattern = (op: ContentOp, key: string): ContentOp =>
    ({ operator: op.operator, operands: [...op.operands.slice(0, -1), name(key)] });
  const redirect = (caller: Occurrence, invocation: Invocation, target: Occurrence) => {
    if (invocation.kind === 'form') {
      caller.splices.push(replacement(caller.scope, invocation.opIndex, target));
      return;
    }
    const { binding, site } = invocation;
    site.before.push(selectPattern(binding.selection, aliasCopy(caller.scope, 'Pattern', target)));
    const originalName = binding.selection.operands.at(-1);
    const originalPatterns = dictOf(doc, caller.scope.original?.get('Pattern'));
    if (isName(originalName) && doc.resolve(originalPatterns?.get(originalName.name)) === binding.stream) {
      site.after.push(binding.selection);
    } else {
      const { owner, key } = newAlias(caller.scope, 'Pattern');
      owner.set(key, binding.resource);
      site.after.push(selectPattern(binding.selection, key));
    }
  };

  const parsed = new Map<PdfStream, { source: ContentOpSource; tokens: number }>();
  const active = new Map<PdfDict, Occurrence>();
  const copies = new Set<Occurrence>();
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
    stream: PdfStream, invocation: Invocation, initialPaint?: PatternPaintState, parent?: Occurrence, selection?: number,
  ): Occurrence | undefined => {
    let source: ContentOpSource;
    try { source = readSource(stream); }
    catch (caught) {
      rethrowLimit(caught);
      if (selection !== undefined) throw caught;
      return undefined;
    }

    const own = dictOf(doc, stream.dict.get('Resources'));
    const scope: ResourceScope = own ? { original: own } : parent?.scope ?? pageScope;
    const next = selection === undefined ? undefined : invocations[selection + 1];
    const editedPath = selection !== undefined && !next ? edit(source) : undefined;
    const occurrence: Occurrence = {
      stream, source, scope, ownsResources: own !== undefined, parent, invocation, editedPath,
      splices: editedPath ? [editedPath] : [], sites: [], backEdges: [],
    };
    if (selection !== undefined) copies.add(occurrence);
    active.set(stream.dict, occurrence);
    let followedSelection = false;
    if (active.size < MAX_XOBJECT_DEPTH) {
      const paint = trackPatternPaint(doc, scope.original, initialPaint);
      const paintSite = trackPatternSites();
      const visit = (target: PdfStream, link: Invocation, state?: PatternPaintState, nextSelection?: number) => {
        const ancestor = active.get(target.dict);
        if (ancestor) {
          ancestor.backEdges.push({ caller: occurrence, invocation: link });
          return undefined;
        }
        return collect(target, link, state, occurrence, nextSelection);
      };
      const visitPatterns = (first: number, end: number, bindings: PatternBinding[]) => {
        if (!bindings.length) return;
        const site: ContentWrap = { first, end, before: [], after: [] };
        occurrence.sites.push(site);
        for (const binding of bindings) visit(binding.stream, { kind: 'pattern', site, binding });
      };
      for (let opIndex = 0; opIndex < source.ops.length; opIndex++) {
        if (editedPath?.first === opIndex) {
          // Removal or recoloring may replace the pattern. Follow only the
          // channels that the edited paint still uses.
          for (const op of editedPath.ops) {
            paint.update(op);
            const used = paintSite(op, opIndex, paint.state);
            if (used) visitPatterns(editedPath.first, editedPath.end, used.bindings);
          }
          opIndex = editedPath.end - 1;
          continue;
        }
        const op = source.ops[opIndex];
        paint.update(op);
        const target = calledForm(scope, op);
        if (target) {
          const followsSelection = next?.opIndex === opIndex;
          const child = visit(target, { kind: 'form', opIndex }, paint.state, followsSelection ? selection! + 1 : undefined);
          if (child && followsSelection) followedSelection = true;
        }
        const used = paintSite(op, opIndex, paint.state);
        if (used) visitPatterns(used.first, used.end, used.bindings);
      }
    }
    active.delete(stream.dict);
    if (next && !followedSelection) throw new RangeError('missing nested Form draw');
    return occurrence;
  };

  const initialPaint = pagePatternPaint(doc, page, invocations[0], top);
  const root = collect(selected, { kind: 'form', opIndex: topIndex }, initialPaint, undefined, 0)!;
  // A back-edge only needs repair when its target is being copied. Copy the
  // invoking branch as far as the nearest existing copy. Set iteration also
  // visits those new copies so their own incoming back-edges are repaired.
  for (const target of copies) {
    for (const { caller, invocation } of target.backEdges) {
      redirect(caller, invocation, target);
      for (let node: Occurrence | undefined = caller; node && !copies.has(node); node = node.parent) copies.add(node);
    }
  }
  for (const target of copies) {
    if (target.parent) redirect(target.parent, target.invocation, target);
  }
  const topSplice = replacement(pageScope, topIndex, root);

  for (const occurrence of copies) {
    const { stream, source, editedPath, splices, sites, ownsResources, scope } = occurrence;
    if (stream.dict.has('StructParents') || stream.dict.has('StructParent'))
      throw new UnsupportedFeatureError('cannot edit a Form occurrence with a structure-parent entry');

    for (const { first, end, before, after } of sites) {
      if (!before.length) continue;
      // Use the path boundary for standard streams. When a damaged stream
      // interleaves state operations, keep them and rebind at the actual paint.
      const start = source.ops.slice(first, end - 1).every((op) => pathConstruction.has(op.operator)) ? first : end - 1;
      if (editedPath?.first === start && editedPath.end === end) {
        editedPath.ops = [...before, ...editedPath.ops, ...after];
      } else {
        splices.push({ first: start, end, before, after });
      }
    }
    const raw = source.replaceAll(splices);
    const dict = new Map(stream.dict);
    for (const key of ['Filter', 'DecodeParms', 'F', 'FFilter', 'FDecodeParms', 'DL']) dict.delete(key);
    dict.set('Length', raw.length);
    if (ownsResources && scope.copy) dict.set('Resources', scope.copy);
    occurrence.clone = { kind: 'stream', dict, raw };
  }
  const additions = aliases.map(({ owner, key, target }) => ({ owner, key, form: target.clone! }));
  return { bytes: top.replaceAll([topSplice]), resources: pageScope.copy!, additions };
}
