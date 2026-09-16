/** ISO 14289-2 clauses 8.4.3, 8.4.4 and 8.6 — PUA and natural language, six of
 *  the 11 rules `q7hc.4.4` added.
 *
 *  Transcribed from veraPDF/veraPDF-validation-profiles@integration
 *  `PDF_UA/2/8.4 Text representation for content/8.4.3`, `.../8.4.4` and
 *  `PDF_UA/2/8.6`, plus `PUAHelper.java` for the ranges and
 *  `MarkedContentHelper.java` for the `/ActualText` lookup, fetched 2026-09-16.
 *  A TRANSCRIPTION and not a runnable oracle — `72nc.1`'s ceiling.
 *
 *  **Invariant:** its own module beside `uaannot.ts`, `uafont.ts` and
 *  `uadoc.ts`, all four over `uarule.ts`. The split is by SUBJECT.
 *
 *  **Invariant:** NOTHING here is converted, with ONE exception that is not
 *  this module's doing: `ConvertToPdfUa` already sets the catalog `/Lang` from
 *  `opts.lang`, so `CatalogLangMissing` resolves for any caller supplying one.
 *  It is the only rule in the whole epic that an EXISTING pass fixes, which is
 *  why `test/pdfua2-text.test.ts` asserts it rather than leaving it to be
 *  noticed. Every other rule lands in `unresolved` — a private-use code point's
 *  meaning and a language tag are things only the author knows. @internal */
import { textOf, uaClause, type Rule, type UaCtx } from './uarule.js';
import { distinctGlyphs } from './uaglyph.js';
import type { ValidationIssue } from './validation.js';

/** The Unicode private use areas, transcribed from veraPDF's `PUAHelper`:
 *  `{0xE000, 0xF8FF, 0xF0000, 0xFFFFD, 0x100000, 0x10FFFD}`.
 *
 *  **Invariant: THREE ranges, and both supplementary bounds end at `FFFD`.**
 *  The last two code points of each plane are noncharacters and sit outside the
 *  private use area; a single-range check silently passes every supplementary
 *  PUA code point, which is the everyday shape for a symbol font that ran out
 *  of BMP room. Asserted by SIZE in `test/pdfua2-misc-coverage.test.ts`, the
 *  rule `htmlforeign.ts` sets for its five tables. */
const PUA_RANGES: readonly (readonly [number, number])[] = [
  [0xe000, 0xf8ff], [0xf0000, 0xffffd], [0x100000, 0x10fffd],
];

/** Exported for the census, which asserts the COUNT. @internal */
export const PUA_RANGE_COUNT = PUA_RANGES.length;

/** Does this text contain a private-use code point?
 *
 *  **Note it iterates by CODE POINT** where veraPDF indexes by UTF-16 unit and
 *  calls `codePointAt(i)` at every index. The two agree: at a lead surrogate
 *  both read the full code point, and at a trail surrogate veraPDF reads a
 *  value in `0xDC00..0xDFFF`, which is below every range here and so never
 *  matches. */
export function containsPua(s: string | undefined): boolean {
  if (s === undefined || s === '') return false;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    for (const [lo, hi] of PUA_RANGES) if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

// ---- 8.4.3 — replacements and alternatives ----------------------------------

/** 8.4.3-1: real content mapping to PUA needs an /ActualText or /Alt.
 *
 *  Profile test:
 *  `isRealContent == false || unicodePUA == false || actualTextPresent == true
 *   || altPresent == true`.
 *
 *  **Invariant, and the obvious reading is WRONG:** the lookup reads the
 *  glyph's OWN structure element, never its ancestors —
 *  `MarkedContentHelper.containsStringKey` calls `structureElement.getKey(key)`
 *  directly and requires a non-empty STRING. So an `/Alt` on a grandparent does
 *  NOT excuse a PUA glyph. It checks the inherited MARKED-CONTENT attribute
 *  FIRST, which is what `GlyphEvent.mcProps` supplies — and that half matters,
 *  because a `BDC` may carry `/ActualText` with no `/MCID` at all.
 *
 *  **Invariant:** `isRealContent` maps to `!artifact`. That term is a
 *  constructor parameter threaded down from veraPDF's operator layer rather
 *  than a quotable expression, so it is transcribed by INFERENCE — recorded
 *  here as such rather than presented as certain. */
const puaWithoutReplacementRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const g of distinctGlyphs(ctx)) {
    if (g.artifact === true) continue;
    if (!containsPua(g.text)) continue;
    if (g.mcProps?.actualText !== undefined || g.mcProps?.alt !== undefined) continue;
    // The glyph's OWN element, resolved by the walk. Read DIRECTLY, never up
    // the ancestor chain — see the invariant above.
    if (g.element !== undefined) {
      const at = textOf(ctx, g.element.Dict.get('ActualText'));
      const alt = textOf(ctx, g.element.Dict.get('Alt'));
      if ((at !== undefined && at !== '') || (alt !== undefined && alt !== '')) continue;
    }
    issues.push({
      rule: 'PuaWithoutReplacement', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.3' }),
      ...(g.element !== undefined ? { element: g.element } : {}),
      message: `Code ${g.code} maps to a Unicode private-use value with no `
        + '/ActualText or /Alt to say what it means.',
    });
  }
  return issues;
};

/** 8.4.3-2 and 8.4.3-3: an /ActualText or /Alt shall not itself contain PUA.
 *
 *  Both over every structure element — `ctx.nodes` is the tree walk every
 *  structure rule already shares, so this adds no second walk. */
const structStringPuaRules: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    for (const [key, rule] of [
      ['ActualText', 'ActualTextPua'],
      ['Alt', 'AltPua'],
    ] as const) {
      if (!containsPua(textOf(ctx, element.Dict.get(key)))) continue;
      issues.push({
        rule, severity: 'error',
        clause: uaClause(ctx.part, { 2: '8.4.3' }), element,
        message: `The /${key} entry contains a Unicode private-use value.`,
      });
    }
  }
  return issues;
};

// ---- 8.6 — text string objects ----------------------------------------------

/** 8.6-1: a human-readable text string shall not use the PUA.
 *
 *  **Invariant: a CURATED set of entries, and that is a DECISION.** veraPDF
 *  decides "intended to be human readable" by which strings its model wraps as
 *  `CosTextString`; we have no such model, and sweeping every string in the
 *  document would report on `/ID`, the encryption `/O` and `/U`, and a
 *  signature's `/Contents` — binary values that are not text at all, so every
 *  encrypted or signed file would report. The set below is what this library
 *  already models as human-readable, which is the README's existing framing of
 *  these validators as a curated, machine-checkable subset. The narrowing is
 *  stated rather than left to be discovered. */
const textStringPuaRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  const hit = (where: string, v: string | undefined): void => {
    if (!containsPua(v)) return;
    issues.push({
      rule: 'TextStringPua', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.6' }),
      message: `${where} contains a Unicode private-use value.`,
    });
  };

  const m = ctx.doc.GetMetadata();
  hit('/Info /Title', m.title);
  hit('/Info /Author', m.author);
  hit('/Info /Subject', m.subject);
  hit('/Info /Keywords', m.keywords);
  hit('/Info /Creator', m.creator);
  hit('/Info /Producer', m.producer);

  for (const { element } of ctx.nodes) {
    for (const k of ['Alt', 'ActualText', 'E', 'T'] as const) {
      hit(`A structure element's /${k}`, textOf(ctx, element.Dict.get(k)));
    }
  }

  const walkOutline = (items: { Title: string; Children?: unknown }[]): void => {
    for (const it of items) {
      hit('An outline item\'s /Title', it.Title);
      const kids = it.Children;
      if (Array.isArray(kids)) walkOutline(kids as { Title: string; Children?: unknown }[]);
    }
  };
  walkOutline(ctx.doc.GetOutlines());

  for (const page of ctx.doc.Pages) {
    for (const a of page.Annotations) {
      for (const k of ['Contents', 'T', 'Subj'] as const) {
        hit(`An annotation's /${k}`, textOf(ctx, a.Dict.get(k)));
      }
    }
  }

  for (const f of ctx.doc.Form.Fields) {
    for (const k of ['T', 'TU', 'V'] as const) {
      hit(`A form field's /${k}`, textOf(ctx, f.Dict.get(k)));
    }
  }

  for (const att of ctx.doc.GetAttachments()) {
    hit('An embedded file\'s /Desc', att.Description);
  }

  return issues;
};

// ---- 8.4.4 — declaring natural language -------------------------------------

/** 8.4.4-2's language-tag grammar, transcribed VERBATIM from the profile:
 *  `/^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/`.
 *
 *  **Invariant: it is the ANCHOR's own regex and is NARROWER than BCP 47.** Do
 *  not substitute a general matcher, and do not reach for `langmatch.ts`, which
 *  answers a different question (does this tag MATCH that range). Reporting
 *  what a conforming validator would not is as wrong as missing what it
 *  would. */
const LANG_TAG = /^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/;

/** 8.4.4-1: the catalog shall state /Lang.
 *
 *  **Note it tests PRESENCE only.** The profile's description says "with a
 *  non-empty value" and its test is `containsLang == true` alone; an empty
 *  `/Lang ()` is caught by 8.4.4-2 instead, whose regex demands at least one
 *  letter. The pair gives the prose's answer and neither rule alone does, so
 *  adding a non-empty check here would report one defect twice and disagree
 *  with what veraPDF says about that file.
 *
 *  Presence is read off the RAW catalog dict: `doc.resolve(undefined)` is
 *  `null`, so comparing a resolved value against `undefined` is true for every
 *  ABSENT key — the trap `pdfxvalidate.ts` and `pdfatransparency.ts` record. */
const catalogLangRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  if (ctx.catalog.has('Lang')) return [];
  return [{
    rule: 'CatalogLangMissing', severity: 'error',
    clause: uaClause(ctx.part, { 2: '8.4.4' }),
    message: 'Catalog dictionary does not contain a /Lang entry.',
  }];
};

/** 8.4.4-2: every /Lang shall match the profile's grammar — the catalog's,
 *  every structure element's, and every marked-content property list's.
 *
 *  **A stated NARROWING:** a property-list `/Lang` is seen only on a BDC that
 *  encloses at least one glyph, because it arrives through the glyph walk.
 *  `MarkedContentEvent` fires only when an `/MCID` resolves (`q7hc.1`) and
 *  widening that would break an invariant three other consumers rely on; a
 *  second content walker would be the duplication this repo repeatedly records
 *  as a defect. A `/Lang` on a sequence containing no text is not examined. */
const langSyntaxRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  const check = (where: string, v: string | undefined): void => {
    if (v === undefined) return;
    const key = `${where}|${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (LANG_TAG.test(v)) return;
    issues.push({
      rule: 'LangSyntax', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.4' }),
      message: `${where} states the language tag '${v}', which is not a valid `
        + 'language identifier.',
    });
  };
  check('The catalog', textOf(ctx, ctx.catalog.get('Lang')));
  for (const { element } of ctx.nodes) {
    check('A structure element', textOf(ctx, element.Dict.get('Lang')));
  }
  for (const g of distinctGlyphs(ctx)) {
    check('A marked-content property list', g.mcProps?.lang);
  }
  return issues;
};

export const TEXT_RULES: Rule[] = [
  puaWithoutReplacementRule, structStringPuaRules, textStringPuaRule,
  catalogLangRule, langSyntaxRule,
];
