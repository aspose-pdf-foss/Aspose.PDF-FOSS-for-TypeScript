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
import {
  pagePatternPaint, pathConstruction, shownStrings, trackPatternPaint, trackPatternSites,
  type FontBinding, type PatternBinding, type PatternPaintState,
} from './formpattern.js';
import { resolveSimpleEncoding } from './font.js';
import { MAX_OFFSCREEN_DEPTH } from './pagerender.js';

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
function reserveAliasNames(doc: Document, page: Page, pageResources: PdfDict | undefined): Set<string> {
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
    for (const key of refs.get('Font') ?? []) {
      if (key.startsWith(ALIAS_PREFIX)) names.add(key);
      queueFont(fonts?.get(key), depth + 1);
    }
    const states = dictOf(doc, scope?.get('ExtGState'));
    for (const key of refs.get('ExtGState') ?? []) {
      if (key.startsWith(ALIAS_PREFIX)) names.add(key);
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

type ResourceCategory = 'XObject' | 'Pattern' | 'ExtGState' | 'Font';

interface ResourceScope {
  original?: PdfDict;
  copy?: PdfDict;
  subdicts?: Partial<Record<ResourceCategory, PdfDict>>;
}

type Invocation = { kind: 'form'; opIndex: number }
  | { kind: 'pattern'; site: ContentWrap; binding: PatternBinding }
  | { kind: 'mask'; opIndex: number; state: PdfDict; mask: PdfDict }
  | { kind: 'glyph'; site: GlyphSite; key: string };

interface GlyphSite {
  font: FontBinding;
  size: number;
  scope: ResourceScope;
  ownResources: boolean;
  procs: PdfDict;
  indices: number[];
  children: Occurrence[];
  copy?: PdfDict;
  copiedProcs?: PdfDict;
}

interface Addition { owner: PdfDict; key: string; object: PdfStream | PdfDict; }

interface Occurrence {
  stream: PdfStream;
  source: ContentOpSource;
  scope: ResourceScope;
  ownsResources: boolean;
  parent?: Occurrence;
  invocations: Invocation[];
  editedPath?: ContentSplice;
  splices: (ContentSplice | ContentWrap)[];
  sites: ContentWrap[];
  backEdges: { caller: Occurrence; invocation: Invocation }[];
  readsInheritedFont: boolean;
  entryFont?: ContentOp;
  clone?: PdfStream;
}

/** Plan the selected occurrence and any cycle edges made reachable by cloning.
 * No changes reach the document until the caller publishes the staged result. */
export function planFormEdit(
  doc: Document, page: Page, top: ContentOpSource, invocations: readonly ContentAddr[],
  edit: (source: ContentOpSource) => ContentSplice, tokens: ContentTokenBudget,
): { bytes: Uint8Array; resources: PdfDict; additions: Addition[] } {
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

  const reserved = reserveAliasNames(doc, page, pageScope.original);
  const aliases: { owner: PdfDict; key: string; target: Occurrence }[] = [];
  const additions: Addition[] = [];
  let aliasIndex = 0;
  const newAlias = (scope: ResourceScope, category: ResourceCategory) => {
    const copy = scope.copy ??= new Map(scope.original);
    const subdicts = scope.subdicts ??= {};
    const owner = subdicts[category] ??= ensureOwnSubdict(doc, copy, category);
    let key: string;
    do { key = `${ALIAS_PREFIX}${aliasIndex++}`; } while (owner.has(key) || reserved.has(key));
    return { owner, key };
  };
  const aliasCopy = (scope: ResourceScope, category: 'XObject' | 'Pattern', target: Occurrence): string => {
    const { owner, key } = newAlias(scope, category);
    aliases.push({ owner, key, target });
    return key;
  };
  const replaceName = (opIndex: number, operator: 'Do' | 'gs', key: string): ContentSplice =>
    ({ first: opIndex, end: opIndex + 1, ops: [{ operator, operands: [name(key)] }] });
  const replacement = (scope: ResourceScope, opIndex: number, target: Occurrence): ContentSplice => {
    const key = aliasCopy(scope, 'XObject', target);
    return replaceName(opIndex, 'Do', key);
  };
  const selectPattern = (op: ContentOp, key: string): ContentOp =>
    ({ operator: op.operator, operands: [...op.operands.slice(0, -1), name(key)] });
  const selectFont = (key: string, size: number): ContentOp => ({ operator: 'Tf', operands: [name(key), size] });
  const restoredFonts = new Map<ResourceScope, Map<PdfDict, string>>();
  const restoreFont = (scope: ResourceScope, binding: FontBinding, size: number): ContentOp => {
    const fonts = dictOf(doc, scope.original?.get('Font'));
    if (binding.name !== undefined && doc.resolve(fonts?.get(binding.name)) === binding.dict) {
      return selectFont(binding.name, size);
    }
    let names = restoredFonts.get(scope);
    if (!names) restoredFonts.set(scope, names = new Map());
    let key = names.get(binding.dict);
    if (key === undefined) {
      const alias = newAlias(scope, 'Font');
      key = alias.key;
      alias.owner.set(key, binding.resource);
      names.set(binding.dict, key);
    }
    return selectFont(key, size);
  };
  const copiedGlyphSites = new Set<GlyphSite>();
  const redirect = (caller: Occurrence, invocation: Invocation, target: Occurrence) => {
    if (invocation.kind === 'form') {
      caller.splices.push(replacement(caller.scope, invocation.opIndex, target));
      return;
    }
    if (invocation.kind === 'mask') {
      const { owner, key } = newAlias(caller.scope, 'ExtGState');
      const state = new Map(invocation.state);
      const mask = new Map(invocation.mask);
      state.set('SMask', mask);
      owner.set(key, state);
      // The group and every recursive name must share one indirect stream.
      aliases.push({ owner: mask, key: 'G', target });
      caller.splices.push(replaceName(invocation.opIndex, 'gs', key));
      return;
    }
    if (invocation.kind === 'glyph') {
      const { site } = invocation;
      if (!site.copiedProcs) {
        const { owner, key } = newAlias(caller.scope, 'Font');
        site.copy = new Map(site.font.dict);
        site.copiedProcs = new Map(site.procs);
        site.copy.set('CharProcs', site.copiedProcs);
        additions.push({ owner, key, object: site.copy });
        copiedGlyphSites.add(site);
        const before = [selectFont(key, site.size)];
        const after = [restoreFont(caller.scope, site.font, site.size)];
        for (const first of site.indices) caller.splices.push({ first, end: first + 1, before, after });
      }
      aliases.push({ owner: site.copiedProcs, key: invocation.key, target });
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
  const encodings = new Map<PdfDict, (string | undefined)[]>();
  const patternIds = new Map<PatternBinding, number>();
  const patternId = (binding: PatternBinding | undefined): number => {
    if (!binding) return 0;
    const id = patternIds.get(binding) ?? patternIds.size + 1;
    patternIds.set(binding, id);
    return id;
  };
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
    stream: PdfStream, invocation: Invocation, depth: number,
    initialPaint?: PatternPaintState, parent?: Occurrence, selection?: number,
  ): Occurrence | undefined => {
    let source: ContentOpSource;
    try { source = readSource(stream); }
    catch (caught) {
      rethrowLimit(caught);
      if (selection !== undefined) throw caught;
      return undefined;
    }

    const own = invocation.kind === 'glyph' ? undefined : dictOf(doc, stream.dict.get('Resources'));
    const scope: ResourceScope = invocation.kind === 'glyph' ? invocation.site.scope
      : own ? { original: own } : parent?.scope ?? pageScope;
    const next = selection === undefined ? undefined : invocations[selection + 1];
    const editedPath = selection !== undefined && !next ? edit(source) : undefined;
    const occurrence: Occurrence = {
      stream, source, scope, ownsResources: own !== undefined, parent, invocations: [invocation], editedPath,
      splices: editedPath ? [editedPath] : [], sites: [], backEdges: [], readsInheritedFont: false,
    };
    if (selection !== undefined) copies.add(occurrence);
    active.set(stream.dict, occurrence);
    let followedSelection = false;
    if (depth < MAX_XOBJECT_DEPTH) {
      const paint = trackPatternPaint(doc, scope.original, initialPaint);
      const paintSite = trackPatternSites();
      const states = dictOf(doc, scope.original?.get('ExtGState'));
      let maskGroups: Map<PdfStream, Occurrence> | undefined;
      let glyphSites: Map<PdfDict, Map<string, GlyphSite>> | undefined;
      const visit = (target: PdfStream, link: Invocation, state?: PatternPaintState, nextSelection?: number) => {
        const ancestor = active.get(target.dict);
        if (ancestor) {
          ancestor.backEdges.push({ caller: occurrence, invocation: link });
          return undefined;
        }
        const child = collect(target, link, depth + (link.kind === 'mask' ? 2 : 1), state, occurrence, nextSelection);
        if (state?.font === initialPaint?.font && child?.readsInheritedFont) occurrence.readsInheritedFont = true;
        return child;
      };
      const visitPatterns = (first: number, end: number, bindings: PatternBinding[]) => {
        if (!bindings.length || depth >= MAX_OFFSCREEN_DEPTH) return;
        const site: ContentWrap = { first, end, before: [], after: [] };
        occurrence.sites.push(site);
        for (const binding of bindings) visit(binding.stream, { kind: 'pattern', site, binding });
      };
      const visitGlyphs = (op: ContentOp, index: number, state: PatternPaintState) => {
        const { font, fontSize, textMode } = state;
        if (!font?.type3 || (textMode & 3) === 3) return;
        const strings = shownStrings(op);
        if (!strings.some(({ bytes }) => bytes.length > 0)) return;
        const procs = dictOf(doc, font.dict.get('CharProcs'));
        if (!procs) return;
        let encoding = encodings.get(font.dict);
        if (!encoding) {
          encoding = resolveSimpleEncoding(font.dict, (value) => doc.resolve(value)).names;
          encodings.set(font.dict, encoding);
        }
        const shown = new Set<string>();
        for (const { bytes } of strings) for (const code of bytes) {
          const key = encoding[code];
          if (key !== undefined && procs.has(key)) shown.add(key);
        }
        if (!shown.size) return;
        if (font === initialPaint?.font) occurrence.readsInheritedFont = true;

        // Same caller, font, incoming paint and glyph names need one repaired
        // font and set of procedures, regardless of where the glyphs land.
        const byFont = glyphSites ??= new Map<PdfDict, Map<string, GlyphSite>>();
        let sites = byFont.get(font.dict);
        if (!sites) byFont.set(font.dict, sites = new Map());
        const signature = JSON.stringify([fontSize, textMode, patternId(state.fill), patternId(state.stroke), [...shown].sort()]);
        const prior = sites.get(signature);
        if (prior) { prior.indices.push(index); return; }

        const resources = dictOf(doc, font.dict.get('Resources'));
        const site: GlyphSite = {
          font, size: fontSize, scope: resources ? { original: resources } : scope,
          ownResources: resources !== undefined, procs, indices: [index], children: [],
        };
        sites.set(signature, site);
        const children = new Map<PdfStream, Occurrence>();
        for (const key of shown) {
          const proc = doc.resolve(procs.get(key));
          if (!isStream(proc)) continue;
          const link: Invocation = { kind: 'glyph', site, key };
          const priorChild = children.get(proc);
          if (priorChild) priorChild.invocations.push(link);
          else {
            const child = visit(proc, link, state);
            if (!child) continue;
            children.set(proc, child);
            site.children.push(child);
          }
        }
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
        // The renderer realizes a soft mask at gs with fresh paint. Inherited
        // masks have already run, and only the resource lookup is inherited.
        if (op.operator === 'gs' && depth < MAX_OFFSCREEN_DEPTH && depth + 1 < MAX_XOBJECT_DEPTH) {
          const key = op.operands[0];
          const state = isName(key) ? dictOf(doc, states?.get(key.name)) : undefined;
          const mask = dictOf(doc, state?.get('SMask'));
          const group = doc.resolve(mask?.get('G'));
          if (state && mask && isStream(group)) {
            // Repeated uses in this caller share scope and active ancestors.
            // Keep their gs sites separate and reuse the repaired group bytes.
            const groups = maskGroups ??= new Map<PdfStream, Occurrence>();
            const link: Invocation = { kind: 'mask', opIndex, state, mask };
            const prior = groups.get(group);
            if (prior) prior.invocations.push(link);
            else {
              const child = visit(group, link);
              if (child) groups.set(group, child);
            }
          }
        }
        const target = calledForm(scope, op);
        if (target) {
          const followsSelection = next?.opIndex === opIndex;
          const child = visit(target, { kind: 'form', opIndex }, paint.state, followsSelection ? selection! + 1 : undefined);
          if (child && followsSelection) followedSelection = true;
        }
        const used = paintSite(op, opIndex, paint.state);
        if (used) visitPatterns(used.first, used.end, used.bindings);
        visitGlyphs(op, opIndex, paint.state);
      }
    }
    active.delete(stream.dict);
    if (next && !followedSelection) throw new RangeError('missing nested Form draw');
    return occurrence;
  };

  const initialPaint = pagePatternPaint(doc, page, invocations[0], top);
  const root = collect(selected, { kind: 'form', opIndex: topIndex }, 1, initialPaint, undefined, 0)!;
  const markCopies = (caller: Occurrence) => {
    for (let node: Occurrence | undefined = caller; node && !copies.has(node); node = node.parent) copies.add(node);
  };
  const markGlyphSiblings = (invocation: Invocation) => {
    if (invocation.kind !== 'glyph') return;
    // A font switch is visible to the procedures it executes. Siblings that
    // use the inherited font also need a copy that restores the original.
    for (const child of invocation.site.children) if (child.readsInheritedFont) markCopies(child);
  };
  // A back-edge only needs repair when its target is being copied. Set
  // iteration reaches newly marked callers and their incoming back-edges.
  for (const target of copies) {
    for (const { caller, invocation } of target.backEdges) {
      markCopies(caller);
      markGlyphSiblings(invocation);
    }
    for (const invocation of target.invocations) markGlyphSiblings(invocation);
  }
  for (const target of copies) {
    for (const { caller, invocation } of target.backEdges) redirect(caller, invocation, target);
  }
  for (const target of copies) {
    if (target.parent) for (const invocation of target.invocations) redirect(target.parent, invocation, target);
    const entry = target.invocations[0];
    if (entry.kind === 'glyph' && target.readsInheritedFont) {
      target.entryFont = restoreFont(target.scope, entry.site.font, entry.site.size);
    }
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
    const first = source.ops[0]?.operator;
    const prefix = occurrence.entryFont
      ? { afterFirst: first === 'd0' || first === 'd1', op: occurrence.entryFont }
      : undefined;
    const raw = source.replaceAll(splices, prefix);
    const dict = new Map(stream.dict);
    for (const key of ['Filter', 'DecodeParms', 'F', 'FFilter', 'FDecodeParms', 'DL']) dict.delete(key);
    dict.set('Length', raw.length);
    if (ownsResources && scope.copy) dict.set('Resources', scope.copy);
    occurrence.clone = { kind: 'stream', dict, raw };
  }
  for (const site of copiedGlyphSites) {
    if (site.ownResources && site.scope.copy) site.copy!.set('Resources', site.scope.copy);
  }
  for (const { owner, key, target } of aliases) additions.push({ owner, key, object: target.clone! });
  return { bytes: top.replaceAll([topSplice]), resources: pageScope.copy!, additions };
}
