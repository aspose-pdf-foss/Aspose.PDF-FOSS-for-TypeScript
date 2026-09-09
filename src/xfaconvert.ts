/**
 * XFA to a real `/AcroForm` field tree.
 *
 * **Invariant: the only module in this feature that touches a `Document`** --
 * the split `svgdraw.ts`/`svgembed.ts` makes. `xfageom.ts`, `xfatemplate.ts`,
 * `xfadata.ts` and `xfapacket.ts` are pure leaves it drives.
 *
 * **Invariant: plan fully, then apply.** `buildXfaPlan` decodes the packets,
 * models the template, binds the data, computes every rect and classifies every
 * field ALLOCATING NOTHING. This is `formcreate.ts`'s own rule scaled from one
 * field to a document: creation "validates every argument *and* the whole field
 * path before allocating any object, so a rejected call leaves the document
 * byte-identical". A form we cannot convert leaves the file untouched rather
 * than half-populated.
 *
 * **Invariant: never an approximate rect.** Every geometry failure -- an
 * unknown unit, a flowed ancestor, a medium mismatch, a `rotate`, an
 * unresolvable page -- yields a geometry-less field plus a report entry. There
 * is no fallback that estimates a position from a sibling, a caption or a flow
 * order: a field drawn in the wrong place looks right and is wrong.
 */
import type { Document } from './document.js';
import { isDict, name, type PdfDict, type PdfObject } from './types.js';
import { inflateStream } from './flate.js';
import { classify, type FieldType } from './formfield.js';
import {
  FF_READONLY, FF_REQUIRED, FF_MULTILINE, FF_PASSWORD,
  FF_COMBO, FF_EDIT, FF_MULTISELECT, FF_PUSHBUTTON, FF_RADIO,
} from './fieldflags.js';
import { normalizeOptions, optArray, type NormalizedOption } from './choiceopt.js';
import {
  addRadioGroup, createField, ensureAcroForm, resolvePath,
  type FieldSpec,
} from './formcreate.js';
import { buildButtonAP } from './appearance.js';
import { resolveDA } from './da.js';
import { encodePdfText } from './metadata.js';
import { hasSignatureField } from './signature.js';
import { UnsupportedFeatureError } from './errors.js';
import { decodeXfaPackets } from './xfapacket.js';
import { parseXfaTemplate, type XfaField } from './xfatemplate.js';
import { parseXfaDatasets, bindFieldValue, type XfaValues } from './xfadata.js';
import {
  boxFor, buttonBox, chainIsPositioned, mediumAgrees, rectFromBox,
} from './xfageom.js';

export interface XfaConvertOptions {
  /** Remove `/AcroForm /XFA` and the catalog's `/NeedsRendering` once something
   *  has converted. Default `true`. Removal is one-way and discards the only
   *  description of everything refused, so a caller may decline it. */
  removeXfa?: boolean;
}

export interface XfaFieldResult {
  /** SOM path, e.g. `'form1[0].Page1[0].f1_01[0]'`. */
  name: string;
  type: FieldType;
  route: 'positioned' | 'bare' | 'reconciled';
  /** 1-based, positioned fields only. */
  page?: number;
}

export interface XfaSkipped {
  what: 'document' | 'packet' | 'page' | 'field';
  /** SOM path for a field; absent for a whole-packet or whole-page refusal. */
  name?: string;
  reason: string;
}

export interface XfaConvertReport {
  /** Which XDP packets were found, e.g. `['config', 'template', 'datasets']`. */
  packets: string[];
  fields: XfaFieldResult[];
  /** What did not convert, and why. The first place to look when a converted
   *  document is missing a field or renders nothing. */
  skipped: XfaSkipped[];
  xfaRemoved: boolean;
  /** At least one field converted and NONE got geometry: the document converts
   *  to data and renders nothing. False for a document that converted nothing
   *  at all, which is a different answer and must not read as the same one. */
  dataOnly: boolean;
}

/** One field the plan will create or update. Nothing here is allocated. */
export interface PlanEntry {
  name: string;
  type: FieldType;
  ft: string;
  ff: number;
  /** 1-based; present only for a positioned field. */
  page?: number;
  rect?: [number, number, number, number];
  value?: string | string[];
  defaultValue?: string;
  options?: NormalizedOption[];
  maxLen?: number;
  tooltip?: string;
  onState?: string;
  /** True when this field already exists in the AcroForm: update `/V`, create
   *  nothing, leave its geometry alone. */
  reconcile: boolean;
}

/** One `<exclGroup>` planned as a radio group. Present only when EVERY member
 *  earned geometry -- a group with some widgets placed and some not is not a
 *  degraded control but a broken one. */
export interface GroupPlan {
  name: string;
  options: Array<{ page: number; rect: [number, number, number, number]; export: string }>;
  selected?: string;
  readOnly: boolean;
  required: boolean;
  reconcile: boolean;
}

export interface XfaPlan {
  report: XfaConvertReport;
  entries: PlanEntry[];
  groups: GroupPlan[];
}

/** The `<ui>` kind to its `/FT` plus the type-specific `/Ff` bits. `undefined`
 *  for a kind this feature refuses to synthesize. */
function typeOf(f: XfaField): { ft: string; ff: number } | undefined {
  switch (f.ui) {
    case 'text': case 'numeric': case 'dateTime':
      return { ft: 'Tx', ff: f.multiLine ? FF_MULTILINE : 0 };
    case 'password':
      return { ft: 'Tx', ff: FF_PASSWORD };
    case 'checkButton':
      return { ft: 'Btn', ff: 0 };
    case 'button':
      return { ft: 'Btn', ff: FF_PUSHBUTTON };
    case 'choiceList':
      if (f.open === 'userControl') return { ft: 'Ch', ff: FF_COMBO | FF_EDIT };
      if (f.open === 'multiSelect') return { ft: 'Ch', ff: FF_MULTISELECT };
      return { ft: 'Ch', ff: 0 };
    default:
      // signature / imageEdit / barcode / unknown: refused and reported, never
      // synthesized. The signature refusal matches formfield.ts's existing rule
      // that a signature field is not creatable.
      return undefined;
  }
}

/** The document's `/AcroForm`, or undefined. */
function acroOf(doc: Document): PdfDict | undefined {
  const a = doc.resolve(doc.catalog().get('AcroForm'));
  return isDict(a) ? a : undefined;
}

/**
 * Decode, model, bind and classify -- allocating nothing.
 *
 * The order is load-bearing: page identity is settled before any per-page
 * medium is checked, and the medium is checked before any field on that page is
 * given a rect, because each later step is only meaningful if the earlier one
 * held.
 */
export function buildXfaPlan(doc: Document, opts: XfaConvertOptions): XfaPlan {
  const report: XfaConvertReport = {
    packets: [], fields: [], skipped: [], xfaRemoved: false, dataOnly: false,
  };
  const entries: PlanEntry[] = [];
  const groups: GroupPlan[] = [];
  const empty: XfaPlan = { report, entries, groups };
  void opts;

  // 1. Packets.
  const decoded = decodeXfaPackets(
    acroOf(doc), (o) => doc.resolve(o), (s) => inflateStream(s),
  );
  if ('reason' in decoded) {
    report.skipped.push({ what: 'document', reason: decoded.reason });
    return empty;
  }
  report.packets = decoded.names;
  for (const s of decoded.skipped)
    report.skipped.push({ what: 'packet', name: s.name, reason: s.reason });

  // 2. The template packet is the one that cannot be missing.
  const templateNode = decoded.packets.get('template');
  if (!templateNode) {
    report.skipped.push({
      what: 'packet', name: 'template',
      reason: 'the /XFA carries no readable template packet',
    });
    return empty;
  }
  const tpl = parseXfaTemplate(templateNode);
  const datasetsNode = decoded.packets.get('datasets');
  const values: XfaValues = datasetsNode
    ? parseXfaDatasets(datasetsNode) : new Map<string, string | string[]>();

  // 3. Page identity. A pageArea count that disagrees with the document's page
  //    count degrades the WHOLE document's geometry rather than aligning the two
  //    by guess -- a field placed perfectly on the wrong sheet looks right and
  //    is wrong.
  let noGeometry = false;
  if (tpl.pages.length !== doc.Pages.length) {
    report.skipped.push({
      what: 'document',
      reason: `the template declares ${String(tpl.pages.length)} pageArea(s) and the `
        + `document has ${String(doc.Pages.length)} page(s), so no field can be placed`,
    });
    noGeometry = true;
  }

  // 4. Per-page medium. This is the check that makes the rest trustworthy: it
  //    asserts against a number we did not compute.
  const badPages = new Set<number>();
  if (!noGeometry) {
    for (let i = 0; i < tpl.pages.length; i++) {
      if (mediumAgrees(tpl.pages[i].medium, doc.Pages[i].CropBox)) continue;
      badPages.add(i);
      report.skipped.push({
        what: 'page',
        reason: `page ${String(i + 1)}: the template's <medium> does not match the `
          + "page's CropBox, so no field on it can be placed",
      });
    }
  }

  // 5. Per field.
  const groupMembers = new Map<string, Array<{ f: XfaField; entry: PlanEntry }>>();
  for (const f of tpl.fields) {
    const t = typeOf(f);
    if (!t) {
      report.skipped.push({
        what: 'field', name: f.name,
        reason: `a <${f.ui}> field is refused rather than synthesized`,
      });
      continue;
    }
    let ff = t.ff;
    if (f.readOnly) ff |= FF_READONLY;
    if (f.required) ff |= FF_REQUIRED;
    const value = bindFieldValue(f, values);
    const options = f.items && f.ui === 'choiceList'
      ? normalizeOptions(f.items.map(
        (i) => (i.display === undefined ? i.export : { export: i.export, display: i.display }),
      ))
      : undefined;

    const entry: PlanEntry = {
      name: f.name,
      type: classify(t.ft, ff),
      ft: t.ft,
      ff,
      ...(value !== undefined ? { value } : {}),
      ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
      ...(options ? { options } : {}),
      ...(f.maxChars !== undefined ? { maxLen: f.maxChars } : {}),
      ...(f.tooltip !== undefined ? { tooltip: f.tooltip } : {}),
      ...(f.onState !== undefined ? { onState: f.onState } : {}),
      reconcile: false,
    };

    // Geometry, or a named reason for having none.
    const why = geometryFor(f, entry, doc, noGeometry, badPages);
    // A page that failed has already reported ONCE, as a page; reporting again
    // per field would bury the one entry that names the cause.
    if (why !== undefined && why !== '')
      report.skipped.push({ what: 'field', name: f.name, reason: why });

    if (f.group !== undefined) {
      const members = groupMembers.get(f.group) ?? [];
      members.push({ f, entry });
      groupMembers.set(f.group, members);
      continue;
    }
    entries.push(entry);
  }

  // 6. Groups. All-or-nothing: if any member lacks geometry the whole group
  //    goes bare.
  for (const [name, members] of groupMembers) {
    const placed = members.every((m) => m.entry.rect !== undefined);
    const readOnly = members.some((m) => m.f.readOnly);
    const required = members.some((m) => m.f.required);
    // The group's own value is bound on the GROUP's SOM path, which is what a
    // radio group's /V carries -- not on any one member's.
    const selected = values.get(name);
    if (placed) {
      groups.push({
        name,
        options: members.map((m) => ({
          page: m.entry.page!, rect: m.entry.rect!, export: m.f.onState ?? m.f.name,
        })),
        ...(typeof selected === 'string' ? { selected } : {}),
        readOnly,
        required,
        reconcile: false,
      });
      continue;
    }
    let ff = FF_RADIO;
    if (readOnly) ff |= FF_READONLY;
    if (required) ff |= FF_REQUIRED;
    entries.push({
      name, type: 'radio', ft: 'Btn', ff,
      ...(typeof selected === 'string' ? { value: selected } : {}),
      reconcile: false,
    });
  }

  // 7. Reconcile against the AcroForm the document already has. Built once:
  //    doc.Form rebuilds its field list on every access.
  const existing = new Set(doc.Form.Fields.map((f) => f.FullName));
  for (const e of entries) if (existing.has(e.name)) e.reconcile = true;
  for (const g of groups) if (existing.has(g.name)) g.reconcile = true;

  // 8. Report.
  for (const e of entries) {
    report.fields.push({
      name: e.name,
      type: e.type,
      route: e.reconcile ? 'reconciled' : e.rect !== undefined ? 'positioned' : 'bare',
      ...(!e.reconcile && e.page !== undefined ? { page: e.page } : {}),
    });
  }
  for (const g of groups) {
    report.fields.push({
      name: g.name,
      type: 'radio',
      route: g.reconcile ? 'reconciled' : 'positioned',
      ...(!g.reconcile ? { page: g.options[0].page } : {}),
    });
  }
  report.dataOnly = report.fields.length > 0
    && report.fields.every((f) => f.route !== 'positioned');

  return { report, entries, groups };
}

/**
 * Give `entry` its `page` and `rect`, or return the reason it has none.
 *
 * `''` means "already reported" -- the page-level refusals, whose one entry
 * names the cause for every field on that page.
 */
function geometryFor(
  f: XfaField, entry: PlanEntry, doc: Document,
  noGeometry: boolean, badPages: ReadonlySet<number>,
): string | undefined {
  if (noGeometry) return '';
  if (f.pageIndex === undefined)
    return 'the field could not be traced to a pageArea, so it carries no geometry';
  if (badPages.has(f.pageIndex)) return '';
  if (!chainIsPositioned(f.layouts)) {
    const flow = f.layouts.find((l) => l !== 'position');
    return `an ancestor uses layout="${flow ?? ''}", which needs the dynamic layout `
      + 'engine, so the field carries no geometry';
  }
  const box = boxFor(f.geom, f.offsets, f.caption, f.margin);
  if ('reason' in box) return `${box.reason}, so the field carries no geometry`;
  // A check button's widget is the BUTTON, not the edit region it sits in. Only
  // this UI kind states a size of its own, so every other field takes the box
  // unchanged.
  const placed = f.ui === 'checkButton'
    ? buttonBox(box, {
      ...(f.buttonSize !== undefined ? { size: f.buttonSize } : {}),
      ...(f.para?.hAlign !== undefined ? { hAlign: f.para.hAlign } : {}),
      ...(f.para?.vAlign !== undefined ? { vAlign: f.para.vAlign } : {}),
      ...(f.caption?.placement !== undefined
        ? { captionPlacement: f.caption.placement } : {}),
    })
    : box;
  if ('reason' in placed) return `${placed.reason}, so the field carries no geometry`;
  entry.page = f.pageIndex + 1;
  entry.rect = rectFromBox(placed, doc.Pages[f.pageIndex].CropBox);
  return undefined;
}

/** A PdfString carrying a PDF text string. */
const pdfText = (s: string): PdfObject => ({ kind: 'string', bytes: encodePdfText(s) });

/** A plan entry's value and default as dict entries. `/V` comes from the data
 *  and `/DV` from the template -- conflating them destroys the difference
 *  between what a form was authored with and what someone entered. */
function valueEntries(e: PlanEntry): Array<[string, PdfObject]> {
  const out: Array<[string, PdfObject]> = [];
  if (e.value !== undefined)
    out.push(['V', Array.isArray(e.value) ? e.value.map(pdfText) : pdfText(e.value)]);
  if (e.defaultValue !== undefined) out.push(['DV', pdfText(e.defaultValue)]);
  return out;
}

/**
 * A geometry-less field: a field dict with NO `/Subtype /Widget`, no `/Rect`
 * and no `/P`, wired into the tree at its SOM path.
 *
 * A widget with no rect is a malformed annotation; no widget at all is a
 * perfectly legal geometry-less field that `doc.Form` still finds, fills and
 * exports.
 *
 * It is appended through `resolvePath(...).container.push(ref)` -- what
 * `createField` itself does -- and NOT through `appendField`, which appends to
 * `/AcroForm /Fields` directly and so would flatten every hierarchical SOM path
 * onto the root.
 */
function applyBare(doc: Document, acro: PdfDict, e: PlanEntry): boolean {
  // Validate the whole path first, then apply -- creating intermediate nodes
  // allocates, and a fused pass strands orphan nodes on a conflict found deeper.
  try {
    resolvePath(doc, acro, e.name, false);
  } catch {
    return false;
  }
  const path = resolvePath(doc, acro, e.name, true);
  const dict: PdfDict = new Map<string, PdfObject>([
    ['FT', name(e.ft)], ['T', pdfText(path.partial)],
  ]);
  if (e.ff !== 0) dict.set('Ff', e.ff);
  if (path.parent) dict.set('Parent', path.parent);
  for (const [k, v] of valueEntries(e)) dict.set(k, v);
  if (e.options) dict.set('Opt', optArray(e.options));
  if (e.maxLen !== undefined) dict.set('MaxLen', e.maxLen);
  if (e.tooltip !== undefined) dict.set('TU', pdfText(e.tooltip));
  path.container.push(doc.allocObject(dict));
  return true;
}

/** Update an existing field's `/V` from the data and touch nothing else. Its
 *  geometry and appearance are already authoritative -- that is what makes the
 *  hybrid case fall out of name equality rather than a second code path. */
function applyReconcile(doc: Document, e: PlanEntry): void {
  if (e.value === undefined) return;
  const f = doc.Form.Get(e.name);
  if (!f) return;
  f.Value = e.value;
}

/** The per-type half of a positioned field, in `createField`'s vocabulary. */
function specFor(e: PlanEntry): FieldSpec {
  const entries: Array<[string, PdfObject]> = [...valueEntries(e)];
  if (e.options) entries.push(['Opt', optArray(e.options)]);
  if (e.maxLen !== undefined) entries.push(['MaxLen', e.maxLen]);
  if (e.tooltip !== undefined) entries.push(['TU', pdfText(e.tooltip)]);
  // A button carries its on-state in /V and /AS, and buildButtonAP keys the /AP
  // by the export name the template chose rather than by synthOnState's guess --
  // which is exactly the case an unchecked box with a custom export exposes.
  const onState = e.onState;
  if (e.ft === 'Btn' && onState !== undefined) {
    const on = e.value === onState ? onState : 'Off';
    entries.push(['V', name(on)], ['AS', name(on)]);
  }
  return {
    ft: e.ft,
    ...(e.ff !== 0 ? { ff: e.ff } : {}),
    entries,
    ...(e.ft === 'Btn' && onState !== undefined
      ? {
          buildAP: (d: Document, dict: PdfDict, acro: PdfDict): void => {
            buildButtonAP(d, dict, onState, 'checkbox', resolveDA(d, dict, acro));
          },
        }
      : {}),
  };
}

/** One positioned field through `createField`, so the widget dict, the `/AP`
 *  generation and the page `/Annots` wiring are all reused rather than
 *  rewritten. False when it declined, which costs that field alone. */
function applyPositioned(doc: Document, e: PlanEntry): boolean {
  try {
    createField(doc, {
      page: e.page!,
      rect: e.rect!,
      name: e.name,
      readOnly: (e.ff & FF_READONLY) !== 0,
      required: (e.ff & FF_REQUIRED) !== 0,
    }, specFor(e));
    return true;
  } catch {
    return false;
  }
}

/** One `<exclGroup>` through `addRadioGroup`.
 *
 *  A selection the data names but the group does not offer is DROPPED with a
 *  report entry: `addRadioGroup` rejects it outright, and losing the whole
 *  control over one stale datum is the worse answer. */
function applyGroup(doc: Document, g: GroupPlan, report: XfaConvertReport): boolean {
  const exports = g.options.map((o) => o.export);
  let selected = g.selected;
  if (selected !== undefined && !exports.includes(selected)) {
    report.skipped.push({
      what: 'field',
      name: g.name,
      reason: `the data names '${selected}', which is not one of this group's options`,
    });
    selected = undefined;
  }
  try {
    addRadioGroup(doc, {
      name: g.name,
      options: g.options.map((o) => ({ page: o.page, rect: o.rect, export: o.export })),
      ...(selected !== undefined ? { selected } : {}),
      readOnly: g.readOnly,
      required: g.required,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert this document's XFA form to a real `/AcroForm` field tree.
 *
 * Exactly one throw: `UnsupportedFeatureError` on a signed document.
 * `docmdp.ts` permits `/AcroForm /Fields` to change for FILLING, and adding two
 * hundred fields is not filling -- a certification would read as violated, so
 * refusing is the honest answer rather than producing a document whose
 * signature silently fails. It runs BEFORE the plan is built, so a rejected
 * call does no work at all.
 */
export function convertXfaToAcroForm(
  doc: Document, opts: XfaConvertOptions = {},
): XfaConvertReport {
  if (hasSignatureField(doc)) {
    throw new UnsupportedFeatureError(
      'ConvertXfaToAcroForm: the document is signed; adding fields would '
      + 'invalidate the signature and Save() would discard the change');
  }

  const plan = buildXfaPlan(doc, opts);
  if (plan.entries.length === 0 && plan.groups.length === 0) return plan.report;

  const acro = ensureAcroForm(doc);

  for (const e of plan.entries) if (e.reconcile) applyReconcile(doc, e);

  let created = 0;
  for (const e of plan.entries) {
    if (e.reconcile) continue;
    const ok = e.rect !== undefined ? applyPositioned(doc, e) : applyBare(doc, acro, e);
    if (ok) { created += 1; continue; }
    // A field that would not create costs ITSELF, never the run: if it was
    // positioned, try it bare before giving up on it entirely.
    //
    // **Note, measured, and it covers NOTHING today:** deleting this fallback
    // reddens nothing, and that is structural rather than a fixture gap. Of
    // everything `createField` throws on -- an out-of-range page, a non-finite
    // rect, a malformed name, a path conflict -- the plan phase has already
    // excluded all but the conflict, and a conflict fails `applyBare` for the
    // same reason. So the two provably cannot disagree as the code stands.
    // Retained as defence, because the plan phase's guarantees are the only
    // thing making it dead: loosen one and this is what keeps a rejected widget
    // from costing the field its data.
    const bare = e.rect !== undefined
      && applyBare(doc, acro, { ...e, rect: undefined, page: undefined });
    const i = plan.report.fields.findIndex((f) => f.name === e.name);
    if (bare) {
      created += 1;
      if (i >= 0) plan.report.fields[i] = { name: e.name, type: e.type, route: 'bare' };
    } else if (i >= 0) {
      plan.report.fields.splice(i, 1);
    }
    plan.report.skipped.push({
      what: 'field', name: e.name,
      reason: bare
        ? 'the widget could not be created, so the field carries no geometry'
        : 'the field name conflicts with the existing AcroForm tree',
    });
  }

  for (const g of plan.groups) {
    if (g.reconcile) continue;
    if (applyGroup(doc, g, plan.report)) { created += 1; continue; }
    const i = plan.report.fields.findIndex((f) => f.name === g.name);
    if (i >= 0) plan.report.fields.splice(i, 1);
    plan.report.skipped.push({
      what: 'field', name: g.name, reason: 'the radio group could not be created',
    });
  }

  // Removal is ONE-WAY and discards the only description of everything refused,
  // so it happens only when something actually converted. It destroys nothing
  // immediately -- it orphans the packet streams, and Save()'s mark-sweep is
  // what drops them, so a caller who dislikes the report can simply not save.
  if (opts.removeXfa !== false && created > 0) {
    acro.delete('XFA');
    doc.catalog().delete('NeedsRendering');
    plan.report.xfaRemoved = true;
  }

  // Recomputed AFTER the apply loop: a field that fell back to bare here would
  // otherwise leave the flag saying the document renders when it does not.
  plan.report.dataOnly = plan.report.fields.length > 0
    && plan.report.fields.every((f) => f.route !== 'positioned');

  doc.markModified();
  return plan.report;
}
