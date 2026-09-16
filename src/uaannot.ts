/** ISO 14289-2 clauses 8.9 (annotations) and 8.10 (forms) — the 25 rules
 *  `q7hc.4.2` added, plus 8.10.3.5-1 from `q7hc.4.6`, which completes both
 *  clauses at 26.
 *
 *  Transcribed from veraPDF/veraPDF-validation-profiles@integration
 *  `PDF_UA/2/8.9 Annotations/**` and `8.10 Forms/**`, plus
 *  veraPDF/veraPDF-validation@integration's `GFPDAnnot.java`,
 *  `annotations/GFPDWidgetAnnot.java`, `annotations/GFPDMarkupAnnot.java`,
 *  `annotations/GFPDFileAttachmentAnnot.java` and `gfse/GFSEForm.java`, fetched
 *  2026-09-15. A TRANSCRIPTION and not a runnable oracle — `72nc.1`'s ceiling.
 *  As in `q7hc.4.1`, the profiles alone are not enough: `isArtifact`,
 *  `isFieldWidget`, `containsLbl` and the rich-text reduction are bare
 *  identifiers there, and the algorithm behind each is only in the Java.
 *
 *  **Invariant:** its own module rather than more of `structvalidate.ts`, which
 *  is the STRUCTURE TREE's rules (8.2) and was already ~900 lines. The split is
 *  by subject, the way `redactannots.ts` splits object-graph work off
 *  `redact.ts`'s content-stream surgery. Both import the shared vocabulary from
 *  `uarule.ts`, which is what keeps the pair free of an import cycle.
 *
 *  **Invariant:** NO rule here is converted. `ConvertToPdfUa` gains no pass —
 *  an absent `/Contents`, a missing `Lbl`, a prohibited `/Sound` and an XFA
 *  packet are authoring or destructive decisions, and the two that could be
 *  automated (`/Tabs`, `/AFRelationship`) are not worth a pass alone. Every
 *  rule here lands in `unresolved`. Stated so the absence reads as a decision.
 *
 *  **Note the ONE rule here that is an APPROXIMATION:** 8.10.3.5-1, added by
 *  `q7hc.4.6`. veraPDF states it over a grouped CONTENT-ITEM model we do not
 *  have, so it is asked at ANNOTATION granularity instead — see that rule's own
 *  comment for what the difference costs. Every other rule in this module is a
 *  faithful transcription; do not read the two as the same kind of thing.
 *  @internal */
import type { Annotation } from './annotation.js';
import { readRichTextMarkup } from './formfield.js';
import { richTextToPlain } from './richtext.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import { decodePdfText } from './metadata.js';
import { isDict, isName, isString, type PdfDict } from './types.js';
import { uaClause, type Rule, type UaCtx } from './uarule.js';
import type { ValidationIssue } from './validation.js';
import { resolveAppearance } from './annotappearance.js';
import { visitFormContent } from './text.js';

/** What every annotation rule reads, computed ONCE per annotation.
 *
 *  Twenty-two of the 25 rules want some subset of these, and `isArtifact` in
 *  particular walks an ancestor chain — so computing it per rule would walk the
 *  same chain eight times. */
interface AnnotCtx {
  annot: Annotation;
  page: Page;
  dict: PdfDict;
  subtype: string;
  /** /F, 0 when absent. */
  flags: number;
  /** The structure element enclosing it, or undefined when it is not in the
   *  tree — `/StructParent` through the ParentTree, which is veraPDF's
   *  `getParentDictionary`. */
  parent?: StructElement;
  /** An `Artifact` element ANYWHERE up the ancestor chain. */
  isArtifact: boolean;
}

/** Every annotation of every page, with its shared facts resolved.
 *
 *  **Invariant:** "in the structure tree" means `/StructParent` RESOLVES to an
 *  element. Every artifact rule in both clauses carries `structParentType ==
 *  null` as a PASS, so an annotation outside the tree is exempt — which reads
 *  wrong, and is what the anchor says. `UntaggedContent` covers that case.
 *
 *  **Note, measured for the link rules in `q7hc.4.1` and true here too:** the
 *  `/StructParent`-is-a-number test and the `element === undefined` test are
 *  REDUNDANT DEFENCES — an absent key resolves to `null`, which the first
 *  rejects, and the ParentTree would find nothing for it anyway. Breaking
 *  either ALONE proves nothing; do not "simplify" one away. */
function annotContexts(ctx: UaCtx): AnnotCtx[] {
  const out: AnnotCtx[] = [];
  for (const page of ctx.doc.Pages) {
    for (const annot of page.Annotations) {
      const spRaw = ctx.doc.resolve(annot.Dict.get('StructParent'));
      const parent = typeof spRaw === 'number'
        ? ctx.tree.ElementForObject(spRaw) : undefined;
      const flagsRaw = ctx.doc.resolve(annot.Dict.get('F'));
      out.push({
        annot, page, dict: annot.Dict, subtype: annot.Subtype,
        flags: typeof flagsRaw === 'number' ? flagsRaw : 0,
        parent,
        isArtifact: parent !== undefined && hasArtifactAncestor(parent),
      });
    }
  }
  return out;
}

/** `GFPDAnnot.getisArtifact`: an `Artifact` element ANYWHERE up the chain.
 *
 *  **Invariant, and the obvious reading is wrong:** it is the whole ANCESTOR
 *  CHAIN, not the direct parent. Eight rules read it, and a parent-only test
 *  passes an annotation nested two deep inside an artifact subtree — silently,
 *  since such a document renders identically either way.
 *
 *  **Note the depth bound:** `/P` can cycle in a file we did not write, and a
 *  validator must not hang on damage — `lexer.ts`'s posture. */
function hasArtifactAncestor(el: StructElement): boolean {
  let cur: StructElement | undefined = el;
  for (let depth = 0; cur !== undefined && depth < 64; depth++) {
    if (cur.StandardType === 'Artifact') return true;
    cur = cur.Parent;
  }
  return false;
}

/** Build an issue for one annotation. */
function annotIssue(
  ctx: UaCtx, a: AnnotCtx, rule: string, clause: string, message: string,
): ValidationIssue {
  return {
    rule, severity: 'error', clause: uaClause(ctx.part, { 2: clause }),
    page: a.page, element: a.parent, message,
  };
}

/** A rule over every annotation of a given /Subtype. */
function subtypeRule(
  subtype: string, rule: string, clause: string,
  fires: (ctx: UaCtx, a: AnnotCtx) => string | undefined,
): Rule {
  return (ctx) => {
    if (ctx.part !== 2) return [];
    const issues: ValidationIssue[] = [];
    for (const a of annotContexts(ctx)) {
      if (a.subtype !== subtype) continue;
      const message = fires(ctx, a);
      if (message !== undefined) issues.push(annotIssue(ctx, a, rule, clause, message));
    }
    return issues;
  };
}

/** 8.9.2.4.8-1, .12-1, .19-1, .19-2: these subtypes shall carry /Contents. */
const inkDescriptionRule = subtypeRule('Ink', 'InkDescription', '8.9.2.4.8',
  (_ctx, a) => a.annot.Contents === undefined
    ? 'Ink annotation has no /Contents to describe it.' : undefined);

const screenDescriptionRule = subtypeRule('Screen', 'ScreenDescription', '8.9.2.4.12',
  (_ctx, a) => a.annot.Contents === undefined
    ? 'Screen annotation has no /Contents to describe it.' : undefined);

const threeDDescriptionRule = subtypeRule('3D', 'ThreeDDescription', '8.9.2.4.19',
  (_ctx, a) => a.annot.Contents === undefined
    ? '3D annotation has no /Contents to describe it.' : undefined);

const richMediaDescriptionRule = subtypeRule(
  'RichMedia', 'RichMediaDescription', '8.9.2.4.19',
  (_ctx, a) => a.annot.Contents === undefined
    ? 'RichMedia annotation has no /Contents to describe it.' : undefined);

/** 8.9.2.4.7-1: a rubber stamp shall carry EITHER /Name or /Contents.
 *
 *  Note the disjunction — a stamp whose /Name is a standard one (`/Approved`)
 *  describes itself, so /Contents is required only when the name does not. */
const stampDescriptionRule = subtypeRule('Stamp', 'StampDescription', '8.9.2.4.7',
  (ctx, a) => {
    if (isName(ctx.doc.resolve(a.dict.get('Name')))) return undefined;
    return a.annot.Contents === undefined
      ? 'Rubber stamp annotation has neither /Name nor /Contents.' : undefined;
  });

/** 8.9.2.4.11-1, -2 and 8.9.2.4.15-1: prohibited outright. */
const soundProhibitedRule = subtypeRule('Sound', 'SoundProhibited', '8.9.2.4.11',
  () => 'Sound annotations are prohibited in PDF/UA-2.');
const movieProhibitedRule = subtypeRule('Movie', 'MovieProhibited', '8.9.2.4.11',
  () => 'Movie annotations are prohibited in PDF/UA-2.');
const trapNetProhibitedRule = subtypeRule('TrapNet', 'TrapNetProhibited', '8.9.2.4.15',
  () => 'TrapNet annotations are prohibited in PDF/UA-2.');

/** 8.9.2.4.10-1: a file attachment's /FS filespec shall state /AFRelationship.
 *
 *  **Note it is read off the FILESPEC, not off the annotation**
 *  (`GFPDFileAttachmentAnnot.getAFRelationship`), and the rule fires only when
 *  /FS is present at all. */
const fileAttachmentRule = subtypeRule(
  'FileAttachment', 'FileAttachmentRelationship', '8.9.2.4.10',
  (ctx, a) => {
    if (!a.dict.has('FS')) return undefined;
    const fs = ctx.doc.resolve(a.dict.get('FS'));
    if (isDict(fs) && isName(ctx.doc.resolve(fs.get('AFRelationship')))) return undefined;
    return 'File attachment /FS does not state /AFRelationship.';
  });

// /F annotation flags, 32000-2 Table 167. These three values are transcribed
// from the profile's own tests — `(F & 1)`, `(F & 32)`, `(F & 256)`.
const FLAG_INVISIBLE = 1;        // bit 1
const FLAG_NO_VIEW = 32;         // bit 6
const FLAG_TOGGLE_NO_VIEW = 256; // bit 9

/** The subtypes veraPDF models as `PDMarkupAnnot`.
 *
 *  **Invariant: SIXTEEN, and this is NOT ISO 32000-2 Table 171's markup list.**
 *  Thirteen come from `GFPDAnnot`'s dispatch default branch; `FileAttachment`,
 *  `Ink` and `Stamp` are here because their classes EXTEND `GFPDMarkupAnnot`.
 *  Table 171 additionally counts `Sound` and `Movie` as markup and veraPDF's
 *  model does not — the profile's `object="PDMarkupAnnot"` resolves against the
 *  MODEL, so we follow it. Do not "fix" this toward the ISO list.
 *
 *  **Note a THIRD set with a confusingly similar name:** `annotation.ts`'s
 *  `MARKUP_SUBTYPES` is the narrow TEXT-markup family (highlight, underline,
 *  strikeout, squiggly) behind `MarkupAnnotation.MarkupType`. Three sets, one
 *  word; none of them is another. */
const MARKUP_ANNOTS = new Set([
  // GFPDAnnot dispatch, default branch (13)
  'Caret', 'Circle', 'FreeText', 'Highlight', 'Line', 'Polygon', 'PolyLine',
  'Redact', 'StrikeOut', 'Square', 'Squiggly', 'Text', 'Underline',
  // classes that EXTEND GFPDMarkupAnnot (3)
  'FileAttachment', 'Ink', 'Stamp',
]);

/** A rule over every annotation, whatever its subtype. */
function annotRule(
  rule: string, clause: string,
  fires: (ctx: UaCtx, a: AnnotCtx) => string | undefined,
): Rule {
  return (ctx) => {
    if (ctx.part !== 2) return [];
    const issues: ValidationIssue[] = [];
    for (const a of annotContexts(ctx)) {
      const message = fires(ctx, a);
      if (message !== undefined) issues.push(annotIssue(ctx, a, rule, clause, message));
    }
    return issues;
  };
}

/** True when the rule's artifact escape applies: not in the tree, or an
 *  artifact. Every rule in 8.9.2.2, .13, .14, .16 and 8.10 carries it. */
function exempt(a: AnnotCtx): boolean {
  return a.parent === undefined || a.isArtifact;
}

/** 8.9.2.2-1: an Invisible annotation shall be an artifact. */
const annotInvisibleRule = annotRule('AnnotInvisible', '8.9.2.2', (_ctx, a) =>
  exempt(a) || (a.flags & FLAG_INVISIBLE) === 0 ? undefined
    : 'Annotation sets the Invisible flag but is not an artifact.');

/** 8.9.2.2-2: a NoView annotation shall be an artifact, unless it also sets
 *  ToggleNoView — which means it is visible in some states. */
const annotNoViewRule = annotRule('AnnotNoView', '8.9.2.2', (_ctx, a) =>
  exempt(a)
    || (a.flags & FLAG_NO_VIEW) === 0
    || (a.flags & FLAG_TOGGLE_NO_VIEW) === FLAG_TOGGLE_NO_VIEW
    ? undefined
    : 'Annotation sets the NoView flag without ToggleNoView but is not an artifact.');

/** 8.9.2.3-1: a markup annotation shall be enclosed by an Annot element. */
const markupEnclosureRule = annotRule('MarkupEnclosure', '8.9.2.3', (_ctx, a) => {
  if (!MARKUP_ANNOTS.has(a.subtype) || exempt(a)) return undefined;
  if (a.parent?.StandardType === 'Annot') return undefined;
  return `Markup annotation is enclosed by '${a.parent?.Type ?? '(none)'}' `
    + 'instead of an Annot element.';
});

/** 8.9.2.4.16-1: a Watermark shall be an artifact or enclosed by Annot. */
const watermarkEnclosureRule = annotRule('WatermarkEnclosure', '8.9.2.4.16', (_ctx, a) => {
  if (a.subtype !== 'Watermark' || exempt(a)) return undefined;
  if (a.parent?.StandardType === 'Annot') return undefined;
  return 'Watermark annotation is neither an artifact nor enclosed by an Annot element.';
});

/** 8.9.2.4.9-1: a Popup shall NOT be in the structure tree.
 *
 *  **Note the INVERSE shape:** every other rule in this clause exempts an
 *  annotation outside the tree; this one fires precisely because it is inside
 *  one. A popup is the pop-up of another annotation and has no content of its
 *  own to tag. */
const popupInTreeRule = annotRule('PopupInTree', '8.9.2.4.9', (_ctx, a) =>
  a.subtype === 'Popup' && a.parent !== undefined
    ? 'Popup annotation is in the structure tree; it must not be.' : undefined);

/** 8.9.2.4.14-1: a printer's mark shall be an artifact. */
const printerMarkRule = annotRule('PrinterMarkArtifact', '8.9.2.4.14', (_ctx, a) =>
  a.subtype === 'PrinterMark' && !exempt(a)
    ? "Printer's mark annotation is in the structure tree and is not an artifact."
    : undefined);

/** 8.9.2.4.13-1: a widget of zero size shall be an artifact.
 *
 *  **Note the disjunction:** the profile tests `width != 0 || height != 0`, so
 *  only a widget that is zero on BOTH axes reports. A fixture with both zero
 *  cannot see that, so the suite pins each axis separately. */
const zeroSizeWidgetRule = annotRule('ZeroSizeWidget', '8.9.2.4.13', (_ctx, a) => {
  if (a.subtype !== 'Widget' || exempt(a)) return undefined;
  const r = a.annot.Rect;
  if (r === undefined) return undefined;
  const width = Math.abs(r[2] - r[0]);
  const height = Math.abs(r[3] - r[1]);
  if (width !== 0 || height !== 0) return undefined;
  return 'Widget annotation has zero width and height but is not an artifact.';
});

/** 8.9.4.2-1: where an annotation has /Contents and the directly enclosing
 *  element has /Alt, the two shall be identical.
 *
 *  **Note this rule is ABSENT from the issue's own list** — it is the one that
 *  made 8.9 nineteen rules rather than eighteen, and the anchor 91 files rather
 *  than 90. */
const annotAltMismatchRule = annotRule('AnnotAltMismatch', '8.9.4.2', (_ctx, a) => {
  const contents = a.annot.Contents;
  const alt = a.parent?.Alt;
  if (contents === undefined || alt === undefined || contents === alt) return undefined;
  return `Annotation /Contents ('${contents}') and the enclosing element's /Alt `
    + `('${alt}') are both present and differ.`;
});

/** 8.9.2.3-2: a markup annotation's /RC shall be textually equivalent to its
 *  /Contents.
 *
 *  **Invariant: the reduction is VERBATIM.** `DictionaryKeysHelper` concatenates
 *  every text node and does nothing else, so `<p>a</p><p>b</p>` is `ab`. Our
 *  DEFAULT reduction separates blocks on purpose — right for a search, wrong
 *  here — so this passes `{ verbatim: true }`. A single-block fixture cannot
 *  tell the two apart, and single-block is what Acrobat writes.
 *
 *  **Note the two owners:** `readRichTextMarkup` (formfield.ts) handles the
 *  string-or-stream duality, `richTextToPlain` (richtext.ts) handles the
 *  markup. Neither throws, which is what keeps a damaged /RC from taking the
 *  report down — `annotsearch.ts`'s arrangement, reused. */
const markupRichTextRule = annotRule('MarkupRichText', '8.9.2.3', (ctx, a) => {
  if (!MARKUP_ANNOTS.has(a.subtype) || !a.dict.has('RC')) return undefined;
  const contents = a.annot.Contents;
  if (contents === undefined) return undefined;
  const markup = readRichTextMarkup(ctx.doc, a.dict, 'RC');
  if (markup === undefined) return undefined;
  const plain = richTextToPlain(markup, { verbatim: true });
  if (plain === undefined || plain === contents) return undefined;
  return `Annotation /RC reduces to '${plain}', which differs from /Contents `
    + `('${contents}').`;
});

/** The three tab orders 8.9.3.3-1 admits: Annotations array, Widget, Structure. */
const TAB_ORDERS = new Set(['A', 'W', 'S']);

/** 8.9.3.3-1: a page carrying annotations shall state a tab order of A, W or S.
 *
 *  **Note the SEVERITY:** the profile tags this `minor` where every other rule
 *  in 8.9 and 8.10 is `major`, so this is the one WARNING of the two clauses
 *  and a document with only this defect still reports `Passed`. */
const tabOrderRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const page of ctx.doc.Pages) {
    if (page.Annotations.length === 0) continue;
    const tabs = ctx.doc.resolve(page.Dict.get('Tabs'));
    if (isName(tabs) && TAB_ORDERS.has(tabs.name)) continue;
    issues.push({
      rule: 'TabOrder', severity: 'warning',
      clause: uaClause(ctx.part, { 2: '8.9.3.3' }), page,
      message: 'Page carries annotations but its /Tabs is not A, W or S.',
    });
  }
  return issues;
};

/** `GFPDWidgetAnnot.getisFieldWidget`: the widget dict IS a field (a merged
 *  field/widget, carrying /FT) or it has a /Parent.
 *
 *  A standalone widget belonging to no field is exempt from 8.10.1-1 and both
 *  8.10.2.3 rules. Every widget this library's own form API creates is a field
 *  widget, so the exemption is unmeasured without a hand-built fixture. */
function isFieldWidget(a: AnnotCtx): boolean {
  return a.subtype === 'Widget' && (a.dict.has('FT') || a.dict.has('Parent'));
}

/** `GFPDWidgetAnnot.getcontainsLbl`: an `Lbl` among the ENCLOSING element's
 *  children, with a NON-EMPTY /K.
 *
 *  **Invariant: the empty-Lbl test is part of the rule.** A label element with
 *  nothing in it labels nothing, and a first reading checks only the type.
 *
 *  **Note it uses PLAIN children, not `significantChildren`.** `q7hc.4.1`'s
 *  pass-through splicing is `getStructuralSignificanceChildren`, a DIFFERENT
 *  veraPDF method, and the plain one is what is called here. Do not unify. */
function hasFilledLabel(el: StructElement | undefined): boolean {
  if (el === undefined) return false;
  return el.Children.some((c) => c.StandardType === 'Lbl'
    && (c.Children.length > 0 || c.ContentItems.length > 0));
}

/** 8.10.1-1: a field widget shall be enclosed by a Form element. */
const widgetEnclosureRule = annotRule('WidgetEnclosure', '8.10.1', (_ctx, a) => {
  if (!isFieldWidget(a) || exempt(a)) return undefined;
  if (a.parent?.StandardType === 'Form') return undefined;
  return `Widget annotation is enclosed by '${a.parent?.Type ?? '(none)'}' `
    + 'instead of a Form element.';
});

/** 8.10.2.3-1: a field widget needs a label or a /Contents. */
const widgetDescriptionRule = annotRule('WidgetDescription', '8.10.2.3', (_ctx, a) => {
  if (!isFieldWidget(a) || exempt(a)) return undefined;
  if (hasFilledLabel(a.parent) || a.annot.Contents !== undefined) return undefined;
  return 'Widget annotation has neither an Lbl in its enclosing element nor /Contents.';
});

/** 8.10.2.3-2: a field widget with /AA needs /Contents.
 *
 *  **Note it is NOT satisfied by a label**, unlike -1: an additional action can
 *  change the field's behaviour, and the description of that has to travel with
 *  the annotation. */
const widgetActionRule = annotRule('WidgetActionDescription', '8.10.2.3', (_ctx, a) => {
  if (!isFieldWidget(a) || exempt(a) || !a.dict.has('AA')) return undefined;
  if (a.annot.Contents !== undefined) return undefined;
  return 'Widget annotation has an /AA additional action but no /Contents.';
});

/** 8.10.1-2: a Form element shall hold at most one widget annotation.
 *
 *  Counts `/OBJR` kids whose referenced dict is `/Subtype /Widget`, which is
 *  `GFSEForm.getwidgetAnnotsCount`. */
const formWidgetCountRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'Form') continue;
    let widgets = 0;
    for (const item of element.ContentItems) {
      if (item.kind !== 'objr') continue;
      const d = ctx.doc.resolve(item.ref);
      if (!isDict(d)) continue;
      const st = ctx.doc.resolve(d.get('Subtype'));
      if (isName(st) && st.name === 'Widget') widgets++;
    }
    if (widgets <= 1) continue;
    issues.push({
      rule: 'FormWidgetCount', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.10.1' }), element,
      message: `Form structure element holds ${widgets} widget annotations; `
        + 'it may hold at most one.',
    });
  }
  return issues;
};

/** 8.10.1-3: XFA forms shall not be present.
 *
 *  **Note the overlap with `xfaconvert.ts`, which is documented rather than
 *  automated:** `ConvertXfaToAcroForm()` converts the fields and removes
 *  `/XFA`, so running it first satisfies this rule for free. The validator does
 *  not call it, and `ConvertToPdfUa` gains no XFA pass — that would be a
 *  field-authoring decision. */
const xfaPresentRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const acro = ctx.doc.resolve(ctx.catalog.get('AcroForm'));
  if (!isDict(acro) || !acro.has('XFA')) return [];
  return [{
    rule: 'XfaPresent', severity: 'error',
    clause: uaClause(ctx.part, { 2: '8.10.1' }),
    message: 'Catalog /AcroForm carries an /XFA packet, which PDF/UA-2 prohibits. '
      + 'ConvertXfaToAcroForm() converts the fields and removes it.',
  }];
};

/** 8.10.3.3-1: a text field with /RV shall also have /V, and the two shall be
 *  textually equivalent.
 *
 *  Reduced VERBATIM, for `markupRichTextRule`'s reason. */
const textFieldRichValueRule = annotRule('TextFieldRichValue', '8.10.3.3', (ctx, a) => {
  if (!a.dict.has('RV')) return undefined;
  const vRaw = ctx.doc.resolve(a.dict.get('V'));
  const v = isString(vRaw) ? decodePdfText(vRaw.bytes) : undefined;
  if (v === undefined) return 'Text field has /RV but no /V.';
  const markup = readRichTextMarkup(ctx.doc, a.dict, 'RV');
  if (markup === undefined) return undefined;
  const plain = richTextToPlain(markup, { verbatim: true });
  if (plain === undefined || plain === v) return undefined;
  return `Text field /RV reduces to '${plain}', which differs from /V ('${v}').`;
});

// ---- 8.10.3.5 — signature fields --------------------------------------------

/** An `/Alt` ANYWHERE up the ancestor chain, non-empty.
 *
 *  **Invariant, and it is the OPPOSITE of 8.4.3-1's lookup:** veraPDF reads
 *  `groupedContent.getInheritedAlt()` here, while `uatext.ts`'s PUA rule reads
 *  the glyph's OWN element through `structureElement.getKey(key)`. Two rules of
 *  one standard with two different lookups; each is pinned by its own case, and
 *  copying either into the other is silent. Depth-bounded for
 *  `hasArtifactAncestor`'s reason — `/P` can cycle in a file we did not write. */
function inheritedAlt(ctx: UaCtx, el: StructElement): boolean {
  let cur: StructElement | undefined = el;
  for (let depth = 0; cur !== undefined && depth < 64; depth++) {
    const v = ctx.doc.resolve(cur.Dict.get('Alt'));
    if (isString(v) && decodePdfText(v.bytes) !== '') return true;
    cur = cur.Parent;
  }
  return false;
}

/** Does this annotation's normal appearance PAINT a graphic — an image, a
 *  shading or a filled/stroked path? Text alone does not count. */
function appearancePaintsGraphic(ctx: UaCtx, a: AnnotCtx): boolean {
  const ap = resolveAppearance(ctx.doc, a.dict);
  if (ap === undefined) return false;
  let graphic = false;
  try {
    visitFormContent(ctx.doc, ap.stream, undefined, ap.place, {
      image: () => { graphic = true; },
      path: () => { graphic = true; },
    });
  } catch {
    // A damaged appearance costs its own finding, never the validation run —
    // `svgdraw.ts`'s posture, and the rule this whole validator holds for a
    // file we did not write.
    return false;
  }
  return graphic;
}

/** 8.10.3.5-1: a graphic forming part of a signature's appearance needs
 *  alternative text.
 *
 *  Profile test: `isSignature == false || Alt != null` over
 *  `SEGraphicContentItem`. `isSignature` is `GFPDWidgetAnnot`'s — the widget's
 *  `/FT` is `/Sig` — threaded down into the `/AP /N` walk.
 *
 *  **Invariant: this is an APPROXIMATION, and saying so is half the rule.**
 *  veraPDF states it over a GRAPHIC CONTENT ITEM — one item of a grouped
 *  content model, each carrying its own structure parent and its own inherited
 *  attributes. We have no such model: `visitFormContent` walks an appearance
 *  stream and emits image/path EVENTS, which is ANNOTATION granularity. So the
 *  question asked here is "does this signature's appearance paint any graphic,
 *  and does its enclosing element chain carry an /Alt", once per annotation,
 *  where the anchor asks it once per content item.
 *
 *  **What that loses, precisely:** the two answers differ only when one
 *  signature appearance is internally tagged with MCIDs pointing at DIFFERENT
 *  structure elements carrying DIFFERENT /Alt values — one graphic described
 *  and another not. Then veraPDF reports the undescribed item and this reports
 *  nothing, or reports the pair as one. No real signature appearance is built
 *  that way, and the case the clause exists for — a scanned-signature image
 *  with no alternate text — is caught exactly.
 *
 *  Do NOT read this as a faithful transcription. Closing the gap means building
 *  the grouped content-item model, which `q7hc.4.6` weighed and declined for
 *  one P3 rule: a second content model beside `visitContent`'s event walk is
 *  how two walkers come to disagree about one page. */
const signatureGraphicAltRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const a of annotContexts(ctx)) {
    if (a.subtype !== 'Widget') continue;
    if (nameOfKey(ctx, a.dict, 'FT') !== 'Sig') continue;
    // Outside the tree, and artifacts, are exempt — every annotation rule of
    // these two clauses carries both escapes.
    if (a.parent === undefined || a.isArtifact) continue;
    if (!appearancePaintsGraphic(ctx, a)) continue;
    if (inheritedAlt(ctx, a.parent)) continue;
    issues.push(annotIssue(ctx, a, 'SignatureGraphicAlt', '8.10.3.5',
      'A graphic forms part of this signature\'s appearance, but no /Alt '
      + 'describes it.'));
  }
  return issues;
};

/** A dict's name-valued entry, following `/Parent` once for a widget that is
 *  not itself the field — `isFieldWidget`'s shape. */
function nameOfKey(ctx: UaCtx, dict: PdfDict, key: string): string | undefined {
  const own = ctx.doc.resolve(dict.get(key));
  if (isName(own)) return own.name;
  const parent = ctx.doc.resolve(dict.get('Parent'));
  if (!isDict(parent)) return undefined;
  const up = ctx.doc.resolve(parent.get(key));
  return isName(up) ? up.name : undefined;
};

export const ANNOT_RULES: Rule[] = [
  inkDescriptionRule, screenDescriptionRule, threeDDescriptionRule,
  richMediaDescriptionRule, stampDescriptionRule,
  soundProhibitedRule, movieProhibitedRule, trapNetProhibitedRule,
  fileAttachmentRule,
  annotInvisibleRule, annotNoViewRule, markupEnclosureRule,
  annotAltMismatchRule, markupRichTextRule, tabOrderRule,
  widgetEnclosureRule, widgetDescriptionRule, widgetActionRule,
  formWidgetCountRule, xfaPresentRule, textFieldRichValueRule,
  watermarkEnclosureRule, popupInTreeRule, printerMarkRule, zeroSizeWidgetRule,
  // q7hc.4.6 — APPENDED, so the report order q7hc.4.2 shipped is unchanged.
  signatureGraphicAltRule,
];
