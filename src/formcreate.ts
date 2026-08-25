import type { Document } from './document.js';
import {
  PdfDict, PdfObject, PdfRef, isArray, isDict, isName, isRef, isString, name,
} from './types.js';
import { num } from './pagecontent.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import type { StdFont } from './metrics.js';
import type { Page } from './page.js';
import { checkNums, ownAnnots } from './annotation.js';
import { generateFieldAppearance, buildButtonAP } from './appearance.js';
import { resolveDA } from './da.js';
import {
  encodeAction, encodeFieldActions, type FieldActions, type PdfAction,
} from './actions.js';
import { buildImageXObject } from './imageembed.js';
import {
  buildPushButtonAP, BUTTON_POSITIONS, TP_FOR, type ButtonIconPosition,
} from './buttonap.js';
import {
  classify, TextField, CheckboxField, RadioField, ChoiceField, ButtonField,
  type FieldType,
} from './formfield.js';
import {
  FF_READONLY, FF_REQUIRED, FF_MULTILINE, FF_PASSWORD, FF_COMB, FF_RADIO,
  FF_COMBO, FF_EDIT, FF_MULTISELECT, FF_PUSHBUTTON, FF_FILESELECT, FF_RICHTEXT,
  FF_DONOTSPELLCHECK, FF_DONOTSCROLL,
} from './fieldflags.js';
import {
  ensureDRFont, fieldDA, pdfLatin, checkColor, checkWidgetStyle, checkFieldStyle,
  applyWidgetStyle, type FieldStyle, type WidgetStyle,
} from './fieldstyle.js';
import { normalizeOptions, optArray, type ChoiceOption } from './choiceopt.js';

// Re-exported so existing import sites (test/form-create.test.ts, index.ts) keep
// working after the move to fieldstyle.ts and choiceopt.ts.
export { ensureDRFont, fieldDA } from './fieldstyle.js';
export type { FieldStyle, WidgetStyle, FieldBorderStyle } from './fieldstyle.js';
export type { ChoiceOption } from './choiceopt.js';

/** Object numbers an operation changed, collected for an incremental-update
 *  delta. Only the signing path passes one: `Save()` renumbers and rewrites the
 *  whole reachable model, so it has nothing to track. Every helper below takes
 *  it optionally and records both what it allocated and what it mutated —
 *  recording only allocations misses the catalog, the page and any indirect
 *  array that was appended to in place.
 *
 *  This is the seam that kept signing's own copy of the bootstrap alive. */
export type TouchedObjects = Set<number>;

/** The document's /AcroForm dict, created as an indirect object with an empty
 *  /Fields when absent. Idempotent; also repairs a missing or non-array
 *  /Fields, since everything downstream appends to it. */
export function ensureAcroForm(doc: Document, touched?: TouchedObjects): PdfDict {
  const catalog = doc.catalog();
  const acroRef = catalog.get('AcroForm');
  const existing = doc.resolve(acroRef);
  if (isDict(existing)) {
    // Every caller goes on to mutate it — appending a field, setting /SigFlags —
    // so it joins the delta whether or not the /Fields repair below fires.
    if (isRef(acroRef)) touched?.add(acroRef.num);
    if (!isArray(doc.resolve(existing.get('Fields')))) existing.set('Fields', []);
    return existing;
  }
  const acro: PdfDict = new Map<string, PdfObject>([['Fields', []]]);
  const acroRefNew = doc.allocObject(acro);
  catalog.set('AcroForm', acroRefNew);
  touched?.add(acroRefNew.num);
  const rootRef = doc.trailer.get('Root');
  if (isRef(rootRef)) touched?.add(rootRef.num);
  return acro;
}

/** Append a field to /AcroForm /Fields.
 *
 *  When /Fields is an *indirect* array we mutate that object in place, so it has
 *  to join the delta on its own account: writing back only /AcroForm emits bytes
 *  that did not change and drops the new field. */
export function appendField(
  doc: Document, acro: PdfDict, fieldRef: PdfRef, touched?: TouchedObjects,
): void {
  const fieldsRef = acro.get('Fields');
  const fields = doc.resolve(fieldsRef);
  if (isArray(fields)) {
    fields.push(fieldRef);
    if (isRef(fieldsRef)) touched?.add(fieldsRef.num);
  } else {
    acro.set('Fields', [fieldRef]);
  }
}

/** Where a new terminal field attaches: the live array to append its ref to,
 *  the enclosing node's ref (undefined at the root), and the terminal partial
 *  name. Only a `create: true` resolution may be used to mutate. */
export interface FieldPath {
  container: PdfObject[];
  parent: PdfRef | undefined;
  partial: string;
}

/** A PdfString carrying a PDF text string. */
function pdfText(s: string): PdfObject {
  return { kind: 'string', bytes: encodePdfText(s) };
}

/** Split a fully-qualified field name into its parts. Rejects empty parts,
 *  which would otherwise produce a field whose FullName does not round-trip. */
export function nameParts(fullName: string): string[] {
  if (typeof fullName !== 'string' || fullName === '')
    throw new TypeError('field name must be a non-empty string');
  const parts = fullName.split('.');
  if (parts.some((p) => p === ''))
    throw new TypeError(`field name '${fullName}' has an empty part`);
  return parts;
}

/** True when `node` ends a branch — the same rule the Form walk uses to decide
 *  where a field ends, extended to cover a node that has no kids *yet*.
 *
 *  A kid carrying /T is a child field, so the node is an intermediate one. Kids
 *  without /T are the node's own widgets, so it is terminal. With no kids at all
 *  the two cases are indistinguishable from the /Kids array alone: an
 *  intermediate node we just created is empty until its first child is appended,
 *  and reading that as terminal would reject every sibling after the first. Fall
 *  back to what the node claims to be — a field (/FT) or a widget — since an
 *  intermediate node needs neither. */
function isTerminal(doc: Document, node: PdfDict): boolean {
  const kids = doc.resolve(node.get('Kids'));
  if (isArray(kids)) {
    for (const k of kids) {
      const kd = doc.resolve(k);
      if (isDict(kd) && (kd as PdfDict).has('T')) return false;
    }
    if (kids.length > 0) return true;
  }
  return node.has('FT') || node.has('Subtype');
}

/** The entry in `container` whose field has partial name `partial`, with the
 *  raw entry alongside the resolved dict — the entry is what a child's
 *  /Parent must reference. */
function findChild(
  doc: Document, container: PdfObject[], partial: string,
): { entry: PdfObject; dict: PdfDict } | undefined {
  for (const entry of container) {
    const d = doc.resolve(entry);
    if (!isDict(d)) continue;
    const t = doc.resolve((d as PdfDict).get('T'));
    if (isString(t) && decodePdfText(t.bytes) === partial)
      return { entry, dict: d as PdfDict };
  }
  return undefined;
}

/** Walk (and with `create`, build) the field tree down to `fullName`'s terminal
 *  parent. Call once with `create: false` to validate the whole path without
 *  mutating, then again with `create: true` to apply it — creating intermediate
 *  nodes allocates objects, so a single fused pass would strand them when a
 *  conflict is found deeper down. */
export function resolvePath(
  doc: Document, acro: PdfDict, fullName: string, create: boolean,
): FieldPath {
  const parts = nameParts(fullName);
  const rootFields = doc.resolve(acro.get('Fields'));
  if (!isArray(rootFields)) throw new TypeError('/AcroForm /Fields is not an array');

  let container = rootFields as PdfObject[];
  let parent: PdfRef | undefined;
  const partial = parts[parts.length - 1];

  for (let i = 0; i < parts.length - 1; i++) {
    const found = findChild(doc, container, parts[i]);
    if (found) {
      if (isTerminal(doc, found.dict))
        throw new RangeError(`'${parts.slice(0, i + 1).join('.')}' is an existing terminal field`);
      let kids = doc.resolve(found.dict.get('Kids'));
      if (!isArray(kids)) { kids = []; found.dict.set('Kids', kids); }
      // A direct (non-indirect) node cannot be referenced, so children below it
      // simply carry no /Parent — the walk reads the tree top-down regardless.
      parent = isRef(found.entry) ? found.entry : undefined;
      container = kids as PdfObject[];
      continue;
    }
    // The branch is absent, so nothing below it can conflict. On the validation
    // pass there is nothing left to check.
    if (!create) return { container, parent, partial };

    const node: PdfDict = new Map<string, PdfObject>([['T', pdfText(parts[i])], ['Kids', []]]);
    if (parent) node.set('Parent', parent);
    const nodeRef = doc.allocObject(node);
    container.push(nodeRef);
    parent = nodeRef;
    container = doc.resolve(node.get('Kids')) as PdfObject[];
  }

  if (findChild(doc, container, partial))
    throw new RangeError(`field '${fullName}' already exists`);
  return { container, parent, partial };
}

// Annotation flag bits (/F), §12.5.3.
const ANNOT_PRINT = 1 << 2;

/** Options common to every field-creation entry point. The styling half —
 *  `font`, `fontSize`, `textColor` plus the border and background keys — comes
 *  from FieldStyle. Defaults: Helvetica, size 0 (auto-size to the box), black
 *  text, and no border or background. */
export interface FieldInit extends FieldStyle {
  /** 1-based page number carrying the widget. */
  page: number;
  /** Widget rectangle [llx, lly, urx, ury] in default user space. */
  rect: [number, number, number, number];
  /** Fully-qualified field name; '.' separates hierarchy levels. */
  name: string;
  /** /Ff ReadOnly (bit 1). */
  readOnly?: boolean;
  /** /Ff Required (bit 2). */
  required?: boolean;
  /** /AA additional actions: keystroke, format, validate and calculate. */
  actions?: FieldActions;
}

/** Options for Form.AddTextField / Page.AddTextField. */
export interface TextFieldInit extends FieldInit {
  /** Initial /V. Default ''. */
  value?: string;
  /** /Ff Multiline (spec bit 13): the value wraps across lines. */
  multiline?: boolean;
  /** /Ff Password (spec bit 14): the appearance shows bullets, not the value. */
  password?: boolean;
  /** /Ff Comb (spec bit 25): `maxLen` evenly spaced cells. Requires
   *  `maxLen` > 0, and cannot be combined with `multiline`, `password` or
   *  `fileSelect`. */
  comb?: boolean;
  /** /Ff FileSelect (spec bit 21): the value is a file pathname whose contents
   *  are submitted, not text in its own right. */
  fileSelect?: boolean;
  /** /Ff RichText (spec bit 26): the value is a rich text string. Pair it with
   *  `richTextValue` for the /RV payload. */
  richText?: boolean;
  /** /Ff DoNotSpellCheck (spec bit 23): the viewer does not spell-check what is
   *  typed here. */
  doNotSpellCheck?: boolean;
  /** /Ff DoNotScroll (spec bit 24): the field refuses text past what its box
   *  holds instead of scrolling. */
  doNotScroll?: boolean;
  /** /RV: the rich text markup. Requires `richText`; `value` still carries the
   *  plain-text equivalent, which is what the generated appearance draws. */
  richTextValue?: string;
  /** /MaxLen: maximum character count. 0 or absent means unlimited. */
  maxLen?: number;
}

/** The per-type half of a field: its /FT, any type-specific /Ff bits, and extra
 *  dict entries (/V, /MaxLen, /Opt, …). */
export interface FieldSpec {
  ft: string;
  ff?: number;
  entries?: Array<[string, PdfObject]>;
  /** Build this field's /AP instead of the default value-driven generation.
   *  Buttons use it so the on-state carries the export name the caller chose,
   *  rather than the one generateFieldAppearance would guess. */
  buildAP?: (doc: Document, dict: PdfDict, acro: PdfDict) => void;
}

/** What createField hands back so callers can build the typed handle. */
export interface CreatedField {
  acro: PdfDict;
  dict: PdfDict;
  type: FieldType;
  ff: number;
  partial: string;
  fullName: string;
}

/** The 1-based page, or a RangeError naming the valid span. */
function pageOf(doc: Document, n: number): Page {
  if (!Number.isInteger(n) || n < 1 || n > doc.Pages.length)
    throw new RangeError(`page ${String(n)} out of range [1, ${doc.Pages.length}]`);
  return doc.Pages[n - 1];
}

/** The annotation half of a widget: /Type, /Subtype, /Rect, the print flag, and
 *  the /P back-reference. Exported so radio-group creation can build the kid
 *  widgets it needs without duplicating this. */
export function buildWidgetDict(
  doc: Document, page: Page, rect: [number, number, number, number],
): PdfDict {
  return new Map<string, PdfObject>([
    ['Type', name('Annot')],
    ['Subtype', name('Widget')],
    ['Rect', checkNums('rect', rect, 4)],
    ['F', ANNOT_PRINT],
    ['P', doc.pageRef(page.Number)],
  ]);
}

/** Attach an allocated widget to the page's own /Annots.
 *
 *  Which object changed depends on how /Annots is stored, and it is the page
 *  only in two of the three cases: an indirect /Annots array is mutated in place
 *  and joins the delta itself, exactly as an indirect /Fields does. */
export function attachWidget(
  doc: Document, page: Page, widgetRef: PdfRef, touched?: TouchedObjects,
): void {
  const annotsRef = page.Dict.get('Annots');
  ownAnnots(doc, page).push(widgetRef);
  if (isRef(annotsRef)) touched?.add(annotsRef.num);
  else touched?.add(doc.pageRef(page.Number).num);
}

/** Create one terminal field as a single merged field/widget dict: validate,
 *  bootstrap the AcroForm, wire the field into the tree at `init.name`, attach
 *  its widget to the page, and generate its appearance.
 *
 *  Ordering is load-bearing. Everything that can throw runs before anything is
 *  allocated, so a rejected call leaves the document byte-identical. */
export function createField(doc: Document, init: FieldInit, spec: FieldSpec): CreatedField {
  // 1. Validate every argument against the document, mutating nothing.
  const page = pageOf(doc, init.page);
  const rect = checkNums('rect', init.rect, 4) as [number, number, number, number];
  const style = checkFieldStyle(init);
  const std: StdFont = init.font ?? 'Helvetica';
  const size = init.fontSize ?? 0;
  const color = (checkColor('textColor', init.textColor ?? [0, 0, 0]) ?? [0, 0, 0]) as
    [number, number, number];
  nameParts(init.name);
  // Encoded here rather than after allocation: encodeAction is where a bad
  // action is rejected, and the whole point of this ordering is that a rejected
  // call leaves the document byte-identical.
  const aa = init.actions === undefined
    ? undefined : encodeFieldActions(doc, init.actions);

  // 2. Bootstrap. This creates /AcroForm only when it is absent — and when it is
  //    absent there are no fields, so step 3 provably cannot then throw.
  const acro = ensureAcroForm(doc);

  // 3. Validate the field path against the live tree before allocating.
  resolvePath(doc, acro, init.name, false);

  // 4. Mutate.
  const key = ensureDRFont(doc, acro, std);
  if (!acro.has('DA')) acro.set('DA', pdfLatin(fieldDA(key, 0, [0, 0, 0])));
  const path = resolvePath(doc, acro, init.name, true);

  let ff = spec.ff ?? 0;
  if (init.readOnly) ff |= FF_READONLY;
  if (init.required) ff |= FF_REQUIRED;

  const dict = buildWidgetDict(doc, page, rect);
  dict.set('FT', name(spec.ft));
  dict.set('T', pdfText(path.partial));
  if (ff !== 0) dict.set('Ff', ff);
  dict.set('DA', pdfLatin(fieldDA(key, size, color)));
  if (path.parent) dict.set('Parent', path.parent);
  for (const [k, v] of spec.entries ?? []) dict.set(k, v);
  if (aa) dict.set('AA', aa);
  // After the type's own entries, so a style overwrites any /MK default they
  // set, and before the appearance is built, so mkOps sees it.
  applyWidgetStyle(doc, dict, style);

  const fieldRef = doc.allocObject(dict);
  path.container.push(fieldRef);
  attachWidget(doc, page, fieldRef);

  const type = classify(spec.ft, ff);
  // A real /AP either way, so /NeedAppearances is never needed. Dispatch
  // explicitly rather than relying on generateFieldAppearance no-op'ing on an
  // /AP we just installed — that coupling would be invisible.
  if (spec.buildAP) spec.buildAP(doc, dict, acro);
  else generateFieldAppearance(doc, acro, dict, type, ff, dict.get('V') ?? null);
  doc.markModified();

  return { acro, dict, type, ff, partial: path.partial, fullName: init.name };
}

/** Create a single-line text field (`/FT /Tx`) and return its live handle. */
export function addTextField(doc: Document, init: TextFieldInit): TextField {
  const value = init.value ?? '';
  if (typeof value !== 'string') throw new TypeError('value must be a string');

  const maxLen = init.maxLen ?? 0;
  if (typeof maxLen !== 'number' || !Number.isInteger(maxLen) || maxLen < 0)
    throw new TypeError('maxLen must be a non-negative integer');
  // The specification forbids these pairings, and appearance.ts silently
  // resolves each one in favour of something the caller did not ask for.
  if (init.comb) {
    if (maxLen <= 0) throw new RangeError('a comb field requires maxLen > 0');
    if (init.multiline) throw new RangeError('a comb field cannot be multiline');
    if (init.password) throw new RangeError('a comb field cannot be a password field');
    if (init.fileSelect) throw new RangeError('a comb field cannot be a file-select field');
  }
  const rv = init.richTextValue;
  if (rv !== undefined) {
    if (typeof rv !== 'string') throw new TypeError('richTextValue must be a string');
    if (!init.richText) throw new RangeError('richTextValue requires richText');
  }

  let ff = 0;
  if (init.multiline) ff |= FF_MULTILINE;
  if (init.password) ff |= FF_PASSWORD;
  if (init.comb) ff |= FF_COMB;
  if (init.fileSelect) ff |= FF_FILESELECT;
  if (init.richText) ff |= FF_RICHTEXT;
  if (init.doNotSpellCheck) ff |= FF_DONOTSPELLCHECK;
  if (init.doNotScroll) ff |= FF_DONOTSCROLL;

  const entries: Array<[string, PdfObject]> = [['V', pdfText(value)]];
  if (maxLen > 0) entries.push(['MaxLen', maxLen]);
  if (rv !== undefined) entries.push(['RV', pdfText(rv)]);

  const c = createField(doc, init, { ft: 'Tx', ff, entries });
  return new TextField(
    doc, c.acro, c.dict, c.partial, c.fullName, 'text', c.ff, null,
  );
}

/** Options for Form.AddCheckbox / Page.AddCheckbox. */
export interface CheckboxInit extends FieldInit {
  /** /AP on-state name, which is also the export value. Default 'Yes'. */
  exportValue?: string;
  /** Initial state. Default false. */
  checked?: boolean;
}

/** Create a checkbox (`/FT /Btn`, neither Radio nor Pushbutton) and return its
 *  live handle. The widget carries both appearance states from the start. */
export function addCheckbox(doc: Document, init: CheckboxInit): CheckboxField {
  const on = init.exportValue ?? 'Yes';
  if (typeof on !== 'string' || on === '')
    throw new TypeError('exportValue must be a non-empty string');
  // 'Off' names every button's unselected appearance, so an export value of
  // 'Off' would collide with the field's own off state.
  if (on === 'Off') throw new RangeError("'Off' is reserved for the unselected state");
  const checked = init.checked === true;
  const state = checked ? on : 'Off';

  const c = createField(doc, init, {
    ft: 'Btn',
    entries: [['V', name(state)], ['AS', name(state)]],
    buildAP: (d, dict, acro) => { buildButtonAP(d, dict, on, 'checkbox', resolveDA(d, dict, acro)); },
  });
  return new CheckboxField(
    doc, c.acro, c.dict, c.partial, c.fullName, 'checkbox', c.ff, null,
  );
}

/** One button of a radio group. */
export interface RadioOption {
  /** 1-based page number carrying this widget. */
  page: number;
  rect: [number, number, number, number];
  /** /AP on-state name for this kid, and its export value. */
  export: string;
}

/** Options for Form.AddRadioGroup. Deliberately not a FieldInit: page and rect
 *  are per-option, and a button draws no /DA text — `fontSize` would be a
 *  documented key that does nothing, since the mark is sized to its box.
 *
 *  It carries `textColor` regardless, because the dot itself is drawn in the
 *  /DA colour. The style applies to the group as a unit: every kid widget gets
 *  the same box. */
export interface RadioGroupInit extends WidgetStyle {
  /** Fully-qualified field name; '.' separates hierarchy levels. */
  name: string;
  /** At least one option. */
  options: RadioOption[];
  /** Initially selected export value. Default: nothing selected. */
  selected?: string;
  /** The dot's colour, written to the group's /DA. Default black. */
  textColor?: [number, number, number];
  readOnly?: boolean;
  required?: boolean;
  /** /AA additional actions, as on every other field type. */
  actions?: FieldActions;
}

/** Create a radio group: a parent field carrying one kid widget per option,
 *  each on its own page. Returns the parent's live handle.
 *
 *  Every option is validated before the first object is allocated. Rejecting
 *  option 3 after wiring the parent and two kids would strand all three, so the
 *  up-front pass is what makes a failed call leave the document unchanged. */
export function addRadioGroup(doc: Document, init: RadioGroupInit): RadioField {
  nameParts(init.name);
  const options = init.options;
  if (!Array.isArray(options) || options.length === 0)
    throw new TypeError('a radio group needs at least one option');

  const seen = new Set<string>();
  const pages: Page[] = [];
  const rects: Array<[number, number, number, number]> = [];
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    if (typeof o?.export !== 'string' || o.export === '')
      throw new TypeError(`radio option ${i}: export must be a non-empty string`);
    // 'Off' names every button's unselected appearance state.
    if (o.export === 'Off')
      throw new RangeError(`radio option ${i}: 'Off' is reserved for the unselected state`);
    if (seen.has(o.export))
      throw new RangeError(`radio option ${i}: duplicate export '${o.export}'`);
    seen.add(o.export);
    pages.push(pageOf(doc, o.page));
    rects.push(checkNums(`radio option ${i} rect`, o.rect, 4) as [number, number, number, number]);
  }
  if (init.selected !== undefined && !seen.has(init.selected))
    throw new RangeError(`radio group has no option '${init.selected}'`);
  const style = checkWidgetStyle(init);
  const markColor = (checkColor('textColor', init.textColor ?? [0, 0, 0]) ?? [0, 0, 0]) as
    [number, number, number];
  const aa = init.actions === undefined
    ? undefined : encodeFieldActions(doc, init.actions);

  const acro = ensureAcroForm(doc);
  const daKey = ensureDRFont(doc, acro, 'Helvetica');
  resolvePath(doc, acro, init.name, false);
  const path = resolvePath(doc, acro, init.name, true);

  let ff = FF_RADIO;
  if (init.readOnly) ff |= FF_READONLY;
  if (init.required) ff |= FF_REQUIRED;

  // The parent is a field, not an annotation: no /Subtype and no /Rect. Its
  // kids carry no /T, which is what makes the Form walk treat this node as a
  // terminal radio field whose /Kids are widgets.
  const kids: PdfObject[] = [];
  const parent: PdfDict = new Map<string, PdfObject>([
    ['FT', name('Btn')],
    ['Ff', ff],
    ['T', pdfText(path.partial)],
    ['V', name(init.selected ?? 'Off')],
    // A group draws no text, but its dot takes the /DA colour — so the colour
    // has to live here, or a later regeneration would lose it.
    ['DA', pdfLatin(fieldDA(daKey, 0, markColor))],
    ['Kids', kids],
  ]);
  if (path.parent) parent.set('Parent', path.parent);
  if (aa) parent.set('AA', aa);
  const parentRef = doc.allocObject(parent);
  path.container.push(parentRef);

  for (let i = 0; i < options.length; i++) {
    const on = options[i].export;
    const widget = buildWidgetDict(doc, pages[i], rects[i]);
    widget.set('Parent', parentRef);
    widget.set('AS', name(init.selected === on ? on : 'Off'));
    const widgetRef = doc.allocObject(widget);
    kids.push(widgetRef);
    attachWidget(doc, pages[i], widgetRef);
    applyWidgetStyle(doc, widget, style);
    buildButtonAP(doc, widget, on, 'radio', resolveDA(doc, parent, acro));
  }

  doc.markModified();
  return new RadioField(
    doc, acro, parent, path.partial, init.name, 'radio', ff, parent.get('V') ?? null,
  );
}

/** Options common to both choice field types. */
export interface ChoiceInit extends FieldInit {
  /** The option list. May be empty — an editable combo with no predefined
   *  options is a legitimate free-text dropdown. */
  options: ChoiceOption[];
  /** Initially selected export value(s). An array requires multiSelect. */
  value?: string | string[];
}

/** Options for Form.AddComboBox / Page.AddComboBox. */
export interface ComboBoxInit extends ChoiceInit {
  /** /Ff Edit (spec bit 19): the user may type a value not in the list. */
  editable?: boolean;
}

/** Options for Form.AddListBox / Page.AddListBox. */
export interface ListBoxInit extends ChoiceInit {
  /** /Ff MultiSelect (spec bit 22): more than one option may be selected. */
  multiSelect?: boolean;
}

/** Shared body of AddComboBox and AddListBox. `editable` exempts the value from
 *  the /Opt membership check, matching Field.setChoice. */
function addChoice(
  doc: Document, init: ChoiceInit, ff: number, editable: boolean,
): ChoiceField {
  const options = normalizeOptions(init.options);
  const multi = (ff & FF_MULTISELECT) !== 0;

  const raw = init.value;
  let values: string[];
  if (raw === undefined) values = [];
  else if (typeof raw === 'string') values = [raw];
  else if (Array.isArray(raw) && raw.every((v) => typeof v === 'string')) {
    if (!multi) throw new TypeError('an array value requires a multi-select list box');
    values = raw;
  } else {
    throw new TypeError('value must be a string or string[]');
  }

  const exports = options.map((o) => o.export);
  if (!editable)
    for (const v of values)
      if (!exports.includes(v)) throw new RangeError(`choice field has no option '${v}'`);

  const entries: Array<[string, PdfObject]> = [['Opt', optArray(options)]];
  if (values.length === 1) entries.push(['V', pdfText(values[0])]);
  else if (values.length > 1) entries.push(['V', values.map((v) => pdfText(v))]);
  // /I is ascending zero-based /Opt indices (PDF 32000-1 table 231). Free text
  // on an editable combo matches nothing and contributes no index.
  const idx = values.map((v) => exports.indexOf(v)).filter((i) => i >= 0).sort((a, b) => a - b);
  if (idx.length > 0) entries.push(['I', idx]);

  const c = createField(doc, init, { ft: 'Ch', ff, entries });
  return new ChoiceField(
    doc, c.acro, c.dict, c.partial, c.fullName, 'choice', c.ff, null,
  );
}

/** Create a combo box (`/FT /Ch` with the Combo flag) and return its handle. */
export function addComboBox(doc: Document, init: ComboBoxInit): ChoiceField {
  if ((init as ListBoxInit).multiSelect)
    throw new RangeError('multiSelect applies to a list box, not a combo box');
  let ff = FF_COMBO;
  if (init.editable) ff |= FF_EDIT;
  return addChoice(doc, init, ff, init.editable === true);
}

/** Create a list box (`/FT /Ch` without the Combo flag) and return its handle. */
export function addListBox(doc: Document, init: ListBoxInit): ChoiceField {
  if ((init as ComboBoxInit).editable)
    throw new RangeError('editable applies to a combo box, not a list box');
  let ff = 0;
  if (init.multiSelect) ff |= FF_MULTISELECT;
  return addChoice(doc, init, ff, false);
}

/** Options for Form.AddPushButton / Page.AddPushButton. */
export interface PushButtonInit extends FieldInit {
  /** /MK /CA — the normal-state caption. */
  caption?: string;
  /** /MK /RC — the caption while hovered. Defaults to `caption`. */
  rolloverCaption?: string;
  /** /MK /AC — the caption while pressed. Defaults to `caption`. */
  downCaption?: string;
  /** JPEG or PNG bytes, drawn into the appearance streams. */
  icon?: Uint8Array;
  /** /MK /TP layout — one of the seven in table 189. Default 'caption-only',
   *  or 'icon-only' when an icon is given without a caption. */
  iconPosition?: ButtonIconPosition;
  /** The activation action, written to /A. */
  action?: PdfAction;
}

/** Create a push button (`/FT /Btn` with the Pushbutton flag) and return its
 *  handle. A push button has no /V — it exists to have an appearance and an
 *  action. */
export function addPushButton(doc: Document, init: PushButtonInit): ButtonField {
  for (const key of ['caption', 'rolloverCaption', 'downCaption'] as const) {
    const v = init[key];
    if (v !== undefined && typeof v !== 'string') throw new TypeError(`${key} must be a string`);
  }
  const caption = init.caption ?? '';
  const hasIcon = init.icon !== undefined;
  const position = init.iconPosition
    ?? (hasIcon && caption === '' ? 'icon-only' : 'caption-only');
  if (!BUTTON_POSITIONS.includes(position))
    throw new TypeError(`iconPosition must be one of ${BUTTON_POSITIONS.join(', ')}`);
  // Reject the pairings that would silently render as something else: an icon
  // that is embedded but never drawn, or a layout with nothing to draw.
  if (position !== 'caption-only' && !hasIcon)
    throw new RangeError(`iconPosition '${position}' needs an icon`);
  if (position === 'caption-only' && hasIcon)
    throw new RangeError("an icon needs an iconPosition other than 'caption-only'");

  // Both of these validate without mutating the document.
  const aDict = init.action === undefined ? undefined : encodeAction(doc, init.action);
  const icon = hasIcon ? buildImageXObject(init.icon!) : undefined;

  const rollover = init.rolloverCaption ?? caption;
  const down = init.downCaption ?? caption;
  const mk: PdfDict = new Map<string, PdfObject>([
    ['CA', pdfText(caption)],
    ['RC', pdfText(rollover)],
    ['AC', pdfText(down)],
    ['TP', TP_FOR[position]],
  ]);
  // Defaults so a created button looks like a button — applied only when the
  // caller styled neither colour. A null is a deliberate suppression, and
  // applyWidgetStyle (in createField) writes the empty array that honours it.
  if (init.backgroundColor === undefined && init.borderColor === undefined) {
    mk.set('BG', [0.86, 0.86, 0.86]);
    mk.set('BC', [0.5, 0.5, 0.5]);
  }
  const entries: Array<[string, PdfObject]> = [['MK', mk]];
  if (aDict) entries.push(['A', aDict]);

  const c = createField(doc, init, {
    ft: 'Btn',
    ff: FF_PUSHBUTTON,
    entries,
    buildAP: (d, dict, acro) => {
      buildPushButtonAP(d, dict, acro, {
        caption, rolloverCaption: rollover, downCaption: down, icon, position,
      });
    },
  });
  return new ButtonField(
    doc, c.acro, c.dict, c.partial, c.fullName, 'pushbutton', c.ff, null,
  );
}
