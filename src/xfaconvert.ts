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
 * unknown unit, a flow the engine refuses, a medium mismatch, a `rotate`, a
 * page the layout cannot produce -- yields a geometry-less field plus a report entry. There
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
import { optArray, type NormalizedOption } from './choiceopt.js';
import {
  addRadioGroup, createField, createSplitField, ensureAcroForm, resolvePath,
  type FieldSpec,
} from './formcreate.js';
import { buildButtonAP } from './appearance.js';
import { buildPushButtonAP } from './buttonap.js';
import { resolveDA } from './da.js';
import { encodePdfText } from './metadata.js';
import { hasSignatureField } from './signature.js';
import { UnsupportedFeatureError, rethrowLimit } from './errors.js';
import { decodeXfaPackets } from './xfapacket.js';
import { parseXfaTemplate, type XfaField, type XfaTemplate } from './xfatemplate.js';
import { parseXfaDatasets, parseXfaDataGroups, parseXfaGlobals, bindFieldValue, type XfaValues, type XfaGlobals } from './xfadata.js';
import { buttonBox, editRegion, measureToPt, mediumAgrees, mediumSizePt, rectFromBox, type XfaBox } from './xfageom.js';
import { PageFormat } from './pageformat.js';
import { layoutPage, type LayoutNode, type Placed, type PlacedNode, type XfaMeasure, type XfaPiece } from './xfaflow.js';
import { chromeOps, type ChromeOp, type ChromeResult } from './xfachrome.js';
import { paintChrome, type XfaChromePlan } from './xfapaint.js';
import { layoutPages, type XfaLayoutResult, type XfaPageSet } from './xfapage.js';
import { layoutLeaf, measureLeaf } from './xfatext.js';
import { withValue } from './xfarich.js';
import { faceLookup } from './xfafont.js';
import { widgetStyleOf } from './xfaborder.js';
import type { WidgetStyle } from './fieldstyle.js';

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
  /** `chrome` (164g.4): a draw, border, fill or caption on a created page that
   *  was not painted, or was painted approximately. */
  what: 'document' | 'packet' | 'page' | 'field' | 'chrome';
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
  /** Non-conforming template values corrected rather than refused -- today a
   *  `min*` greater than its `max*`, swapped as XFA 3.3 p. 277 directs. */
  warnings: string[];
  xfaRemoved: boolean;
  /** At least one field converted and NONE got geometry: the document converts
   *  to data and renders nothing. False for a document that converted nothing
   *  at all, which is a different answer and must not read as the same one. */
  dataOnly: boolean;
  /** Pages created for a DYNAMIC document (`/NeedsRendering`, no AcroForm
   *  fields), whose own pages are only Designer's placeholder: they are replaced
   *  by the pages its layout produced, each sized from its `<medium>`. 0 for a
   *  hybrid, whose pages are its own. */
  pagesCreated: number;
  /** Pages chrome (draws, borders, fills, captions) was painted on (164g.4).
   *  0 for a hybrid, whose pages carry Designer's own rendering, and whenever
   *  the placeholder pages are kept. */
  chromePages: number;
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
  /** A master-page instance (d3mq). Placing one does not, on its own, justify
   *  replacing a dynamic document's placeholder pages. */
  master?: true;
  /** The widget border and fill the template states (164g.4). Ignored on the
   *  reconcile path: a hybrid's widgets are Adobe's, already styled. */
  style?: WidgetStyle;
  /** A push button's face text, written to `/MK /CA` (164g.4). */
  caption?: string;
  /** A field Adobe splits (164g.13): one widget per piece, page order, each
   *  with the text its widget shows. Absent for a field placed whole. */
  pieces?: Array<{ page: number; rect: [number, number, number, number]; shown: string }>;
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
  /** The FIRST member's widget style; every widget of the group takes it. */
  style?: WidgetStyle;
}

export interface XfaPlan {
  report: XfaConvertReport;
  entries: PlanEntry[];
  groups: GroupPlan[];
  /** For a dynamic document: the pages to create, in order, replacing the
   *  placeholder ones. Applied only when something is placed. */
  newPages?: Array<{ w: number; h: number }>;
  /** For a dynamic document: what to paint on those pages (164g.4). */
  chrome?: XfaChromePlan;
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
    packets: [], fields: [], skipped: [], warnings: [], xfaRemoved: false, dataOnly: false, pagesCreated: 0, chromePages: 0,
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
  const datasetsNode = decoded.packets.get('datasets');
  // 164g.2: a repeating subform is instantiated once per same-named data group,
  // so the template is read WITH the data's groups.
  const tpl = parseXfaTemplate(templateNode, parseXfaDataGroups(datasetsNode));
  const values: XfaValues = datasetsNode
    ? parseXfaDatasets(datasetsNode) : new Map<string, string | string[]>();
  // yy09: the index `bind match="global"` falls back to (xfadata.ts).
  const globals: XfaGlobals = datasetsNode
    ? parseXfaGlobals(datasetsNode) : new Map<string, string | string[]>();
  reportGlobalShapes(tpl, report);

  // 3. Pagination (164g.3): pages are an OUTPUT of layout. The root subform's
  //    children are poured into content areas and page-area instances, and a
  //    field's page is wherever its page subform landed.
  const measure = xfaMeasurer(doc, tpl, values, globals);
  const fieldLines = xfaFieldLines(doc, tpl, values, globals);
  const laid = tpl.body ? layoutPages(tpl.body, measure, report.warnings, fieldLines.count)
    : { pages: [], refused: new Map<string, string>() };
  const pageSet = tpl.body?.pageSet;

  // 4. Page identity. A layout whose page count disagrees with the document's
  //    degrades the WHOLE document's geometry rather than aligning the two by
  //    guess -- a field placed perfectly on the wrong sheet looks right and is
  //    wrong. The first pagination refusal rides along, or the cause is lost.
  // A DYNAMIC document's pages are Designer's placeholder ("please wait"):
  // the layout's pages replace them, each sized from its page area's <medium>.
  // A page with no readable medium gets no invented size, and a missing page
  // would shift every later one, so the whole document is refused.
  const isDynamic = doc.resolve(doc.catalog().get('NeedsRendering')) === true
    && doc.Form.Fields.length === 0;
  let newPages: Array<{ w: number; h: number }> | undefined;
  let noGeometry = false;
  if (!pageSet) {
    report.skipped.push({
      what: 'document',
      reason: "the template's root subform declares no <pageSet>, so no field can be placed",
    });
    noGeometry = true;
  } else if (isDynamic && laid.pages.length > 0) {
    const sizes = laid.pages.map((pg) => mediumSizePt(pageSet.pageAreas[pg.pageArea].medium));
    const missing = sizes.findIndex((s) => s === undefined);
    if (missing >= 0) {
      report.skipped.push({
        what: 'document',
        reason: `page ${String(missing + 1)}'s pageArea states no readable <medium>, so the `
          + 'laid-out pages cannot be created and no field can be placed',
      });
      noGeometry = true;
    } else {
      newPages = sizes as Array<{ w: number; h: number }>;
    }
  } else if (laid.pages.length > 0 && laid.pages.length !== doc.Pages.length) {
    const first = laid.refused.values().next().value;
    report.skipped.push({
      what: 'document',
      reason: `the layout produces ${String(laid.pages.length)} page(s) and the document has `
        + `${String(doc.Pages.length)}, so no field can be placed`
        + (first !== undefined ? ` (first refusal: ${first})` : ''),
    });
    noGeometry = true;
  }

  // 4a. Per-page medium. This is the check that makes the rest trustworthy: it
  //     asserts against a number we did not compute.
  const badPages = new Set<number>();
  const crops: number[][] = [];
  if (!noGeometry && pageSet) {
    for (let i = 0; i < laid.pages.length; i++) {
      if (newPages) { crops[i] = [0, 0, newPages[i].w, newPages[i].h]; continue; }
      crops[i] = doc.Pages[i].CropBox;
      if (mediumAgrees(pageSet.pageAreas[laid.pages[i].pageArea].medium, crops[i])) continue;
      badPages.add(i);
      report.skipped.push({
        what: 'page',
        reason: `page ${String(i + 1)}: the template's <medium> does not match the `
          + "page's CropBox, so no field on it can be placed",
      });
    }
  }

  // 4b. Each field's placements, keyed by SOM name: one, or one per piece (164g.13).
  const where = new Map<string, Array<{ page: number; p: Placed }>>();
  laid.pages.forEach((pg, i) => {
    for (const [k, v] of pg.placed) {
      const l = where.get(k) ?? [];
      l.push({ page: i, p: v });
      where.set(k, l);
    }
  });

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
    const entry = baseEntry(f, t, valueFor(f, bindFieldValue(f, values, globals)));
    const ws = styleFor(f, report);
    if (ws) entry.style = ws;

    // Geometry, or a named reason for having none.
    const why = geometryFor(f, entry, noGeometry, badPages, where, laid.refused, crops, fieldLines.texts);
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

  // 5b. Fields on a MASTER page (d3mq): one instance per page. Each page area
  //     is laid out once, shared with the chrome below.
  const masters = layoutMasters(pageSet, measure, report.warnings);
  planMasterFields(tpl, laid, pageSet, noGeometry, badPages, crops, values, globals, report, entries, masters);

  // 5c. Chrome (164g.4): only for the pages a DYNAMIC document will get. A
  //     hybrid's pages already carry Designer's rendering of it, and painting
  //     again would draw every label twice.
  let chrome: XfaChromePlan | undefined;
  if (newPages && !noGeometry) {
    const faces = faceLookup(doc);
    const add = (r: ChromeResult): void => {
      for (const x of r.skipped) report.skipped.push({ what: 'chrome', name: x.name, reason: x.reason });
      report.warnings.push(...r.warnings);
    };
    const masterOps = new Map<number, { ops: ChromeOp[]; w: number; h: number }>();
    const pages = laid.pages.map((pg, i) => {
      if (!masterOps.has(pg.pageArea)) {
        const r = chromeOps(masters(pg.pageArea).nodes, faces);
        add(r);
        masterOps.set(pg.pageArea, { ops: r.ops, w: newPages![i].w, h: newPages![i].h });
      }
      const r = chromeOps(pg.nodes, faces);
      add(r);
      return { pageArea: pg.pageArea, ops: r.ops };
    });
    chrome = { pages, masters: masterOps };
  }

  // 6. Groups. All-or-nothing: if any member lacks geometry the whole group
  //    goes bare.
  for (const [name, members] of groupMembers) {
    const placed = members.every((m) => m.entry.rect !== undefined);
    const style = members[0].entry.style;
    if (members.some((m) => JSON.stringify(m.entry.style) !== JSON.stringify(style)))
      report.skipped.push({ what: 'chrome', name, reason: "a radio group's members state different widget borders, so the first is used" });
    const readOnly = members.some((m) => m.f.readOnly);
    const required = members.some((m) => m.f.required);
    // The group's own value is bound on the GROUP's path, which is what a radio
    // group's /V carries -- not on any one member's. Its DATA path, which leaves
    // out an unnamed container the SOM name counts (fdq3).
    const selected = values.get(members[0].f.groupDataPath ?? name);
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
        ...(style ? { style } : {}),
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

  // A CREATED choice field writes its /V straight into the dict, where a value
  // its /Opt lacks would sit unreported -- a reconciled one is refused by the
  // setter and reported (cb07). Global binding hands one datum to many fields
  // (yy09), so both paths now say the same thing. An editable combo takes any
  // text; the item list stays transcribed either way.
  for (const e of entries) {
    if (e.reconcile || e.ft !== 'Ch' || e.options === undefined || (e.ff & FF_EDIT) !== 0) continue;
    if (e.value === undefined) continue;
    const exports = new Set(e.options.map((o) => o.export));
    const vs = Array.isArray(e.value) ? e.value : [e.value];
    if (vs.every((v) => exports.has(v))) continue;
    delete e.value;
    report.skipped.push({ what: 'field', name: e.name, reason: "the data value is not one of the field's options, so it is not set" });
  }

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

  return { report, entries, groups, ...(newPages ? { newPages } : {}), ...(chrome ? { chrome } : {}) };
}

/**
 * Fields on a MASTER page (d3mq): one instance per page that instantiates the
 * field's page area, placed from the PAGE origin (XFA 3.3 p. 271, 288) and
 * named as Adobe names that instance -- `Page1[n]` is the n-th page of
 * `Page1`, counted per PAGE AREA, not per page.
 *
 * A field with no geometry creates NOTHING and is reported once: a per-page
 * instance exists only as a place on a page, and Adobe writes nothing for a
 * hidden counter or a button in an inactive subform. A field refused for its
 * UI KIND is reported per instance, under the name Adobe gives it.
 *
 * Data: only an explicit `<bind match="dataRef" ref>` binds a page-background
 * field (p. 271); every instance shares the value. `match="global"` binds by
 * the flattened global search (yy09, p. 301).
 */
/** Each page area's background laid out ONCE (d3mq) -- every page
 *  instantiating it carries the same boxes -- with its placed nodes for chrome
 *  (164g.4). */
function layoutMasters(
  pageSet: XfaPageSet | undefined, measure: XfaMeasure, warnings: string[],
): (k: number) => { placed: Map<string, Placed>; nodes: PlacedNode[] } {
  const cache = new Map<number, { placed: Map<string, Placed>; nodes: PlacedNode[] }>();
  return (k) => {
    let m = cache.get(k);
    if (m === undefined) {
      const root = pageSet?.pageAreas[k]?.master;
      const nodes: PlacedNode[] = [];
      m = { placed: root ? layoutPage(root, measure, warnings, nodes) : new Map<string, Placed>(), nodes };
      cache.set(k, m);
    }
    return m;
  };
}

function planMasterFields(
  tpl: XfaTemplate, laid: XfaLayoutResult, pageSet: XfaPageSet | undefined,
  noGeometry: boolean, badPages: ReadonlySet<number>, crops: readonly number[][],
  values: XfaValues, globals: XfaGlobals, report: XfaConvertReport, entries: PlanEntry[],
  masters: (k: number) => { placed: Map<string, Placed>; nodes: PlacedNode[] },
): void {
  const placedIn = (k: number): Map<string, Placed> => masters(k).placed;
  const secondSet = laid.pages.some((p) => p.pageSet > 0);
  const skip = (name: string, reason: string): void => {
    report.skipped.push({ what: 'field', name, reason });
  };
  for (const f of tpl.masterPageFields) {
    const t = typeOf(f);
    const kind = `a <${f.ui}> field is refused rather than synthesized`;
    const m = f.master;
    // Document-level reasons first; a field refused for its own sake says so.
    if (m === undefined || pageSet === undefined) {
      skip(f.name, t ? 'its <pageArea> is not one pagination can identify -- a second <pageSet>, '
        + "an unreadable or unnamed <pageArea>, or one whose name repeats an earlier one's" : kind);
      continue;
    }
    if (noGeometry) {
      skip(f.name, t ? 'the document carries no page geometry, so no instance can be placed' : kind);
      continue;
    }
    if (secondSet) {
      skip(f.name, t ? 'pagination opened a second page-set instance, whose master-page '
        + 'numbering no oracle settles, so no instance is created' : kind);
      continue;
    }
    if (f.group !== undefined) {
      skip(f.name, 'a radio group (<exclGroup>) on a master page is not converted');
      continue;
    }
    const p = placedIn(m.pageArea).get(f.name);
    if (p === undefined || 'reason' in p) {
      skip(f.name, t ? `${p?.reason ?? "the field is not in its page area's layout"}, so no instance is created` : kind);
      continue;
    }
    const wb = t ? widgetBox(f, p.box) : undefined;
    if (wb !== undefined && 'reason' in wb) {
      skip(f.name, `${wb.reason}, so no instance is created`);
      continue;
    }
    // p. 271: a page-background field binds only by an explicit data
    // reference -- and, by p. 301, to global data (yy09). Anything else stays
    // unbound; every instance shares what binds.
    const binds = (f.bindMatch === 'dataRef' && (f.bindRef ?? '') !== '') || f.bindMatch === 'global';
    const value = t && binds ? valueFor(f, bindFieldValue(f, values, globals)) : undefined;
    const style = t && wb !== undefined ? styleFor(f, report) : undefined;
    let n = 0;
    laid.pages.forEach((pg, i) => {
      if (pg.pageArea !== m.pageArea) return;
      const name = `${m.base}[${String(n)}].${m.rest}`;
      n += 1;
      if (!t || wb === undefined) { skip(name, kind); return; }
      // A page whose medium disagrees was reported once, as a page.
      if (badPages.has(i)) return;
      entries.push({ ...baseEntry(f, t, value), name, page: i + 1, rect: rectFromBox(wb, crops[i]), master: true, ...(style ? { style } : {}) });
    });
    if (n === 0)
      skip(f.name, t ? 'no laid-out page is an instance of its <pageArea>, so no instance is created' : kind);
  }
}

/**
 * What `bind match="global"` does not model, reported once each (yy09).
 *
 * - p. 247: "Fields in the template sharing the same name must either be all
 *   global or all non-global. A mixture ... is not supported." Each field still
 *   follows its own rule.
 * - An `<exclGroup>` stating global: p. 176 allows global on a field only,
 *   p. 348 on an exclusion group too, and no vendored form has one. The group
 *   binds by its own data path, as before.
 */
function reportGlobalShapes(tpl: XfaTemplate, report: XfaConvertReport): void {
  const kinds = new Map<string, Set<boolean>>();
  for (const f of [...tpl.fields, ...tpl.masterPageFields]) {
    if (f.dataName === undefined) continue;
    const s = kinds.get(f.dataName) ?? new Set<boolean>();
    s.add(f.bindMatch === 'global');
    kinds.set(f.dataName, s);
  }
  for (const [name, s] of kinds)
    if (s.size > 1)
      report.warnings.push(`fields named "${name}" are global on some fields and ordinary on others, `
        + 'which XFA 3.3 p. 247 does not support; each binds by its own rule');
  const groups = new Set(tpl.fields.filter((f) => f.groupGlobal && f.group !== undefined).map((f) => f.group!));
  for (const g of groups)
    report.warnings.push(`${g}: an <exclGroup> with bind match="global" binds by its own data path; `
      + 'XFA 3.3 p. 176 and p. 348 disagree on whether a group may be global');
}

/** A field's widget border as a `WidgetStyle` (164g.4), its degradation
 *  reported once under the field's template name. */
function styleFor(f: XfaField, report: XfaConvertReport): WidgetStyle | undefined {
  const ws = f.widgetBorder ? widgetStyleOf(f.widgetBorder) : undefined;
  if (ws?.degraded !== undefined) report.skipped.push({ what: 'chrome', name: f.name, reason: ws.degraded });
  return ws?.style;
}

/** A field's data value as a plan carries it. An EMPTY datum on a choice list
 *  is no selection, not an option named ''. Bound as '' it reached Field.Value,
 *  which refuses an export /Opt lacks -- i-765's datasets carry exactly that on
 *  every State list (cb07). A blank check-box datum is the same nothing:
 *  I-130's datasets bind '' to 75 of them (yy09). */
function valueFor(f: XfaField, bound: string | string[] | undefined): string | string[] | undefined {
  return (f.ui === 'choiceList' || f.ui === 'checkButton') && bound === '' ? undefined : bound;
}

/** Everything a plan entry carries except geometry. Shared by body and
 *  master-page fields (d3mq), so the two cannot disagree about a field. */
function baseEntry(f: XfaField, t: { ft: string; ff: number }, value: string | string[] | undefined): PlanEntry {
  let ff = t.ff;
  if (f.readOnly) ff |= FF_READONLY;
  if (f.required) ff |= FF_REQUIRED;
  // The item list is TRANSCRIBED, never run through normalizeOptions: that is
  // the validator for options a CALLER authors, and a document's list is data.
  // /Opt may legally repeat an export or hold '' -- Adobe's own /Opt on i-130
  // does both -- so refusing either refused the whole conversion (cb07).
  const options: NormalizedOption[] | undefined = f.items && f.ui === 'choiceList'
    ? f.items.map((i) => (i.display === undefined || i.display === i.export
      ? { export: i.export }
      : { export: i.export, display: i.display }))
    : undefined;
  return {
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
    ...(f.buttonCaption !== undefined ? { caption: f.buttonCaption } : {}),
    reconcile: false,
  };
}

/** A field's WIDGET box inside its laid-out box: the caption reserve and the
 *  field's own margin come off, and a check button is sized and aligned inside
 *  what is left. Shared by body and master-page fields -- one rule (d3mq). */
function widgetBox(f: XfaField, box: XfaBox): XfaBox | { reason: string } {
  const edit = editRegion(box, f.caption, f.margin);
  if ('reason' in edit) return edit;
  // A check button's widget is the BUTTON, not the edit region it sits in. Only
  // this UI kind states a size of its own, so every other field takes the box
  // unchanged.
  if (f.ui !== 'checkButton') return edit;
  return buttonBox(edit, {
    ...(f.buttonSize !== undefined ? { size: f.buttonSize } : {}),
    ...(f.para?.hAlign !== undefined ? { hAlign: f.para.hAlign } : {}),
    ...(f.para?.vAlign !== undefined ? { vAlign: f.para.vAlign } : {}),
    ...(f.caption?.placement !== undefined ? { captionPlacement: f.caption.placement } : {}),
  });
}

/**
 * Give `entry` its `page` and `rect`, or return the reason it has none.
 *
 * `''` means "already reported" -- the document- and page-level refusals, whose
 * one entry names the cause for every field on them.
 */
function geometryFor(
  f: XfaField, entry: PlanEntry, noGeometry: boolean, badPages: ReadonlySet<number>,
  where: ReadonlyMap<string, Array<{ page: number; p: Placed }>>,
  refused: ReadonlyMap<string, string>, crops: readonly number[][], texts: ReadonlyMap<string, string[]>,
): string | undefined {
  if (noGeometry) return '';
  const r = refused.get(f.name);
  if (r !== undefined) return `${r}, so the field carries no geometry`;
  const ws = where.get(f.name);
  if (ws === undefined || ws.length === 0) return 'the field is not on any laid-out page, so it carries no geometry';
  if (ws.some((w) => badPages.has(w.page))) return '';
  if (ws.length > 1 && !ws.every((w) => 'box' in w.p && w.p.piece))
    return `two fields share the SOM name ${f.name}, so neither can be placed by it, so the field carries no geometry`;
  const out: Array<{ page: number; rect: [number, number, number, number]; piece?: XfaPiece }> = [];
  for (const w of ws) {
    const p = w.p;
    if ('reason' in p) return `${p.reason}, so the field carries no geometry`;
    const wb = widgetBox(f, p.box);
    if ('reason' in wb) return `${wb.reason}, so the field carries no geometry`;
    out.push({ page: w.page + 1, rect: rectFromBox(wb, crops[w.page]), ...(p.piece ? { piece: p.piece } : {}) });
  }
  out.sort((a, b) => (a.piece?.offset ?? 0) - (b.piece?.offset ?? 0));
  entry.page = out[0].page;
  entry.rect = out[0].rect;
  if (out.length > 1) {
    // A widget draws /V, as every created field does; a template default is
    // /DV and draws nothing, split or not.
    const lines = typeof entry.value === 'string' ? texts.get(f.name) ?? [] : [];
    entry.pieces = out.map((o) => ({ page: o.page, rect: o.rect, shown: lines.slice(o.piece!.lines[0], o.piece!.lines[1]).join('\n') }));
  }
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
  } catch (caught) { rethrowLimit(caught);
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
 *  hybrid case fall out of name equality rather than a second code path.
 *
 *  The datum goes through the public `Value` setter, which REFUSES what the
 *  existing field cannot hold -- an export its `/Opt` lacks, a type mismatch.
 *  That costs this field's datum and is answered with a reason, never a throw:
 *  the converter reports what it cannot convert (cb07). */
function applyReconcile(doc: Document, e: PlanEntry): string | undefined {
  if (e.value === undefined) return undefined;
  const f = doc.Form.Get(e.name);
  if (!f) return undefined;
  try {
    // A check box's Value is a BOOLEAN: on exactly when the datum is its
    // on-state. Handed the datum string, the setter refused every one (yy09).
    // `specFor` makes the same comparison for a field it creates.
    f.Value = f.Type === 'checkbox' && typeof e.value === 'string' && e.onState !== undefined
      ? e.value === e.onState : e.value;
  } catch (caught) { rethrowLimit(caught);
    const why = caught instanceof Error ? caught.message : String(caught);
    return `the existing field refused the data value (${why}), so it keeps its own`;
  }
  return undefined;
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
  // A push button's caption is its face: /MK /CA, and the face drawn from it
  // by the builder Form.AddPushButton uses (164g.4). createField merges a
  // widget style into this /MK rather than replacing it.
  if (e.caption !== undefined && (e.ff & FF_PUSHBUTTON) !== 0) {
    const caption = e.caption;
    entries.push(['MK', new Map<string, PdfObject>([['CA', pdfText(caption)]])]);
    return {
      ft: e.ft, ff: e.ff, entries,
      buildAP: (d: Document, dict: PdfDict, acro: PdfDict): void => {
        buildPushButtonAP(d, dict, acro, {
          caption, rolloverCaption: caption, downCaption: caption, position: 'caption-only',
        });
      },
    };
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
    const init = {
      name: e.name,
      readOnly: (e.ff & FF_READONLY) !== 0,
      required: (e.ff & FF_REQUIRED) !== 0,
      ...(e.style ?? {}),
    };
    if (e.pieces && e.pieces.length > 1) {
      createSplitField(doc, init, e.pieces.map((p) => ({
        page: p.page, rect: p.rect, shown: p.shown === '' ? null : pdfText(p.shown),
      })), specFor(e));
    } else {
      createField(doc, { ...init, page: e.page!, rect: e.rect! }, specFor(e));
    }
    return true;
  } catch (caught) { rethrowLimit(caught);
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
      ...(g.style ?? {}),
    });
    return true;
  } catch (caught) { rethrowLimit(caught);
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

  // A dynamic document's placeholder pages give way to the laid-out ones, but
  // only when something will actually be PLACED on them: this is one-way, like
  // removing /XFA, and a form we cannot lay out must leave the file as it was.
  // Master-page instances do not count (d3mq): a form whose body was refused
  // would otherwise come out cut to the pages its background fills.
  let replaced = false;
  if (plan.newPages && (plan.entries.some((e) => !e.reconcile && e.rect !== undefined && !e.master)
    || plan.groups.some((g) => !g.reconcile))) {
    replaced = true;
    const old = doc.Pages.length;
    for (const s of plan.newPages) doc.AddPage(PageFormat.custom(s.w, s.h));
    for (let i = 0; i < old; i++) doc.RemovePage(1);
    plan.report.pagesCreated = plan.newPages.length;
    // 164g.4: the created pages get the template's chrome, under the widgets.
    if (plan.chrome)
      plan.report.chromePages = paintChrome(doc, plan.chrome,
        (reason) => plan.report.skipped.push({ what: 'chrome', reason }));
    plan.report.warnings.push(`the document's ${String(old)} placeholder page(s) were replaced by the `
      + `${String(plan.newPages.length)} page(s) the layout produced`);
  }

  if (plan.newPages && !replaced) {
    // The document's pages are Designer's placeholder and no body content was
    // placed, so they stay -- and the master-page instances, which would sit on
    // pages that do not exist, are dropped, each reported (d3mq).
    const dropped = new Set<string>();
    for (const e of plan.entries) {
      if (!e.master) continue;
      dropped.add(e.name);
      plan.report.skipped.push({
        what: 'field', name: e.name,
        reason: "the document's pages are a placeholder and no body content was placed, "
          + 'so the master-page instance is not created',
      });
    }
    if (dropped.size > 0) {
      plan.entries = plan.entries.filter((e) => !e.master);
      plan.report.fields = plan.report.fields.filter((f) => !dropped.has(f.name));
      plan.report.dataOnly = plan.report.fields.length > 0
        && plan.report.fields.every((f) => f.route !== 'positioned');
      if (plan.entries.length === 0 && plan.groups.length === 0) return plan.report;
    }
  }

  const acro = ensureAcroForm(doc);

  for (const e of plan.entries) {
    if (!e.reconcile) continue;
    const refused = applyReconcile(doc, e);
    if (refused !== undefined) plan.report.skipped.push({ what: 'field', name: e.name, reason: refused });
  }

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

/** @internal 164g.13: a field's value as the lines `xfatext.ts` wraps it into
 *  at the field's stated width, with the faces `xfaMeasurer` measures with --
 *  `count` is what pagination splits by (0 for an empty value), and `texts`
 *  what each piece's widget shows. Undefined where the value cannot be laid
 *  out, which refuses a split rather than guessing at one. */
export function xfaFieldLines(
  doc: Document, tpl: XfaTemplate, values: XfaValues, globals?: XfaGlobals,
): { count: (n: LayoutNode) => number | undefined; texts: Map<string, string[]> } {
  const faces = faceLookup(doc);
  const byName = new Map(tpl.fields.map((f) => [f.name, f]));
  const texts = new Map<string, string[]>();
  const count = (n: LayoutNode): number | undefined => {
    if (n.kind !== 'field' || !n.text || n.field === undefined) return undefined;
    const known = texts.get(n.field);
    if (known) return known.length;
    let t = n.text;
    const f = byName.get(n.field);
    if (f) {
      const v = bindFieldValue(f, values, globals);
      if (Array.isArray(v)) return undefined;
      if (v !== undefined) t = withValue(t, v);
    }
    if (t.refusal !== undefined) return undefined;
    if (t.paras.every((p) => p.runs.every((r) => r.text === ''))) { texts.set(n.field, []); return 0; }
    const w = n.geom.w === undefined ? undefined : measureToPt(n.geom.w);
    if (w === undefined) return undefined;
    const l = layoutLeaf(t, { width: w }, faces);
    if ('reason' in l) return undefined;
    const out = l.lines.map((x) => x.segments.map((s) => s.text).join(''));
    texts.set(n.field, out);
    return out.length;
  };
  return { count, texts };
}

/** @internal The measurer `ConvertXfaToAcroForm` lays pages out with (164g.7):
 *  a leaf's text from the template, with a field's bound value in place of its
 *  default, measured with `faceLookup`'s faces. Exported so the pdf.js oracle
 *  can lay out a subtree in isolation. */
export function xfaMeasurer(doc: Document, tpl: XfaTemplate, values: XfaValues, globals?: XfaGlobals): XfaMeasure {
  const faces = faceLookup(doc);
  const byName = new Map(tpl.fields.map((f) => [f.name, f]));
  // A leaf's text from the template, with a field's bound value in place of
  // its default (164g.7). A multi-valued datum is not text.
  return (n, box) => {
    if (!n.text) return { reason: `${n.label}: has no measurable content` };
    let t = n.text;
    const f = n.field !== undefined ? byName.get(n.field) : undefined;
    if (f) {
      const v = bindFieldValue(f, values, globals);
      if (Array.isArray(v)) return { reason: `${n.label}: is bound to several values, which are not measured as text` };
      if (v !== undefined) t = withValue(t, v);
    }
    const r = measureLeaf(t, box, faces);
    return 'reason' in r ? { reason: `${n.label}: ${r.reason}` } : r;
  };
}
