/**
 * The XFA `template` packet as a flat field model.
 *
 * **Invariant: pure, over `xml.js` and the pure leaf `xfarich.js`.** No
 * `Document`, no PDF object, no `node:` import -- so every rule here is
 * drivable from an XML string.
 *
 * **Invariant: it never throws.** `parseXml` does, and `xfapacket.ts` owns that
 * boundary; by the time a tree reaches here it parsed.
 *
 * **Note `xml.ts` strips namespace prefixes** (`xml.ts:38`), so `<xfa:field>`
 * arrives as `field`. Nothing here may rely on a prefix to disambiguate two
 * elements.
 */
import type { XmlNode } from './xml.js';
import { captionText, leafText, type LeafText } from './xfarich.js';
import { parseBorder, parseGeometry, type NodeChrome, type XfaBorder } from './xfaborder.js';
import type { XfaCaption, XfaMargin, XfaMedium, XfaRawGeom } from './xfageom.js';
import type {
  LayoutKind, LayoutNode, XfaBreak, XfaCopySpec, XfaKeep, XfaMinMax, XfaOverflow,
} from './xfaflow.js';
import type { XfaBody, XfaContentArea, XfaPageAreaModel, XfaPageSet, XfaPageSetNode } from './xfapage.js';
import type { XfaDataGroups } from './xfadata.js';

export type XfaUiKind =
  | 'text' | 'numeric' | 'dateTime' | 'password'
  | 'checkButton' | 'choiceList' | 'button'
  | 'signature' | 'imageEdit' | 'barcode' | 'unknown';

/** The `<ui>` child element name to the kind this feature maps it by. */
const UI_KIND: Record<string, XfaUiKind> = {
  textEdit: 'text',
  numericEdit: 'numeric',
  dateTimeEdit: 'dateTime',
  passwordEdit: 'password',
  checkButton: 'checkButton',
  choiceList: 'choiceList',
  button: 'button',
  signature: 'signature',
  imageEdit: 'imageEdit',
  barcode: 'barcode',
};

/** One `/Opt` entry as XFA states it: the `save="1"` list supplies `export`,
 *  the other list `display`. */
export interface XfaItem { export: string; display?: string }

export interface XfaField {
  /** The SOM expression, occurrence indices included. An UNNAMED container is
   *  named by its class, `#subform[n]` -- what LiveCycle writes into /AcroForm. */
  name: string;
  /** The path the DATA binds by: `name` with every unnamed container left out,
   *  since normal data binding makes one transparent and the datasets packet
   *  has no element for it. Equal to `name` when every container is named. */
  dataPath: string;
  ui: XfaUiKind;
  /** The enclosing `<exclGroup>`'s SOM path, for a radio member. */
  group?: string;
  /** The enclosing `<exclGroup>`'s data path, which its selection binds by. */
  groupDataPath?: string;
  items?: XfaItem[];
  /** `<choiceList open="...">`, carried through verbatim. */
  open?: string;
  readOnly: boolean;
  required: boolean;
  multiLine: boolean;
  maxChars?: number;
  tooltip?: string;
  /** The template's own `<value>` -- `/DV`, never `/V`. */
  defaultValue?: string;
  /** A button's on-state and export value. */
  onState?: string;
  /** `<bind ref="...">`, verbatim. An explicit data path, which outranks the
   *  implicit name match. */
  bindRef?: string;
  /** `<bind match="...">`. `'none'` means deliberately unbound. */
  bindMatch?: string;
  /** The field's own `name` attribute: what `bind match="global"` searches the
   *  data for (yy09). Never re-split from a path -- an XML name may hold a dot. */
  dataName?: string;
  /** Its `<exclGroup>` states `<bind match="global">` (yy09) -- reported, not
   *  modelled: p. 176 and p. 348 disagree on whether that is allowed. */
  groupGlobal?: true;
  /** `<caption>`'s `reserve`, `placement` and `presence`, verbatim.
   *
   *  A field's WIDGET covers the field box MINUS this reserve: the caption is
   *  the label drawn beside the input, and LiveCycle's own `/AcroForm` places
   *  the widget over the edit region alone. Measured on IRS f1040, whose
   *  `f1_01` is 280.8pt wide with a 192.8pt reserve and whose Adobe rect is
   *  exactly 88pt. Ignore it and every captioned field is drawn far too wide,
   *  overlapping its own label. */
  caption?: { reserve?: string; placement?: string; presence?: string };
  /** A caption that states NO reserve, as text: the widget is placed below its
   *  MEASURED height (164g.36, `resolveCaption`). Absent when it states one. */
  captionLeaf?: LeafText;
  /** The field's OWN `<margin>` insets, verbatim.
   *
   *  The widget is inset by these on top of the caption reserve. Measured over
   *  every `textEdit` shape in IRS f1040: our width error was exactly
   *  `leftInset + rightInset` and our height error `topInset + bottomInset`.
   *  Note a real LiveCycle field carries a SECOND `<margin>` inside
   *  `<ui><textEdit>`; this is the DIRECT child, and reading the other one
   *  drops every inset in the form. */
  margin?: XfaMargin;
  /** `<ui><checkButton size>`, verbatim, and only for a checkButton.
   *
   *  It states the BUTTON's own box, which is smaller than the field's: every
   *  one of Adobe's 54 button rects across both vendored forms is exactly 8x8
   *  for `size="2.8222mm"`, where the field box is commonly 12x12. */
  buttonSize?: string;
  /** A push button's caption as plain text: its FACE, written to `/MK /CA`
   *  (164g.4) and never painted as chrome. Absent when the caption is absent,
   *  empty, or hidden, inactive or invisible. */
  buttonCaption?: string;
  /** The FIELD's own `<para>` alignment, verbatim -- never the one nested in
   *  `<caption>`, which f1040's `c1_1` also carries and which is free to
   *  disagree. It places the button inside the edit region. */
  para?: { hAlign?: string; vAlign?: string };
  /** Each container's layout between the page origin and this field, outermost
   *  first. Filled by the geometry pass. */
  layouts: string[];
  /** A MASTER-page field's page area and how an instance is named (d3mq):
   *  instance n -- the n-th page instantiating page area `pageArea` -- is
   *  `${base}[${n}].${rest}`, which is what LiveCycle writes into a hybrid's
   *  /AcroForm (`form1[0].#pageSet[0].Page1[11].PDF417BarCode1[0]` on USCIS
   *  I-130's twelfth page). Absent when pagination cannot identify the page
   *  area: a second `<pageSet>`, an unreadable `<pageArea>`, or a page area
   *  whose name repeats an earlier one's. */
  master?: { pageArea: number; base: string; rest: string };
  /** The WIDGET's border (164g.4): `<ui>/<*>/<border>`, or for a push button
   *  the field's own `<border>`. Mapped to `/MK` + `/BS`, never painted. */
  widgetBorder?: XfaBorder;
}

export interface XfaPageArea { name?: string; medium?: XfaMedium }

export interface XfaTemplate {
  fields: XfaField[];
  /** The root subform's layout node -- its children are the page-level content
   *  -- and its `<pageSet>`. Pages are an OUTPUT of layout (`xfapage.ts`,
   *  164g.3), so nothing here says which page a field is on. Absent only for a
   *  template with no root subform. */
  body?: XfaBody;
  /** Fields on a MASTER page (`<pageSet>` › `<pageArea>`), named as LiveCycle
   *  writes a page's first instance: `form1[0].#pageSet[0].Page1[0].x[0]`.
   *
   *  **Invariant (d3mq):** they are a list of their OWN, never in `fields`, so
   *  layout, measuring and data binding cannot see them. Adobe writes one
   *  instance PER PAGE (`Page1[0..n]`); placing those is d3mq part 2. */
  masterPageFields: XfaField[];
  /** The fields of a leader or trailer COPY (164g.15), by the copy's root node
   *  -- the node `XfaCopySpec.make` returned. Only a copy pagination PLACED
   *  becomes fields; the map also holds copies made while probing a fit. */
  copyFields: ReadonlyMap<LayoutNode, XfaField[]>;
  /** What the template states and Adobe ignores (164g.15: a leader or trailer
   *  target that names nothing, a template-level proto, or a non-subform). */
  warnings: string[];
}

/** An `<exclGroup>` a radio member sits in, by both of its paths. */
interface GroupPaths { som: string; data: string; global?: true }

/** The occurrence counters of one NAMED container. Every unnamed container
 *  below it SHARES them rather than opening its own (fdq3). */
interface IndexScope { byName: Map<string, number>; byClass: Map<string, number> }

const newScope = (): IndexScope => ({ byName: new Map(), byClass: new Map() });

/** A SOM expression from its already-indexed parts. */
export function somName(parts: readonly string[]): string {
  return parts.join('.');
}

const child = (n: XmlNode, name: string): XmlNode | undefined =>
  n.children.find((c) => c.name === name);

const childrenNamed = (n: XmlNode, name: string): XmlNode[] =>
  n.children.filter((c) => c.name === name);

/** An element's direct `<keep>`, the named attributes only; undefined when it states none. */
function keepOf(el: XmlNode, attrs: ReadonlyArray<'intact' | 'next' | 'previous'>): XfaKeep | undefined {
  const keep = child(el, 'keep');
  if (!keep) return undefined;
  const k: XfaKeep = {};
  for (const a of attrs) {
    const v = keep.attrs.get(a);
    if (v !== undefined) k[a] = v;
  }
  return Object.keys(k).length > 0 ? k : undefined;
}

/** The `<items>` lists paired into export/display entries.
 *
 *  **The `save="1"` list is the EXPORT half.** That is the half `/V` carries;
 *  the other is what gets drawn. Every consumer in this repo that re-derived
 *  that grammar got one of the two wrong -- a list box highlighting nothing, a
 *  combo drawing the export value. */
function itemsOf(field: XmlNode): XfaItem[] | undefined {
  const lists = childrenNamed(field, 'items');
  if (lists.length === 0) return undefined;
  const saveList = lists.find((l) => l.attrs.get('save') === '1');
  const exp = saveList ?? lists[0];
  const disp = lists.find((l) => l !== exp);
  const texts = (l: XmlNode | undefined) => (l ? l.children.map((c) => c.text) : []);
  const es = texts(exp);
  const ds = texts(disp);
  if (es.length === 0) return undefined;
  return es.map((e, i) => (ds[i] === undefined ? { export: e } : { export: e, display: ds[i] }));
}

/** A `<value>`'s content.
 *
 *  XFA always WRAPS it in a typed child -- `<text>`, `<integer>`, `<decimal>`,
 *  `<date>`, `<exData>` -- and `XmlNode.text` is the DIRECT text content, so
 *  the `<value>` element's own text is empty for every real form. Reading it
 *  instead silently loses every default in the document. */
function valueText(valueEl: XmlNode | undefined): string | undefined {
  if (!valueEl) return undefined;
  const typed = valueEl.children[0];
  const s = typed ? typed.text : valueEl.text;
  return s === '' ? undefined : s;
}

/** A positive-integer attribute, or `undefined` for anything else. */
function positiveInt(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** One `<field>` to the model, or `undefined` when it has no name -- an
 *  unnamed field has no SOM path, so there is nothing to call it in an
 *  AcroForm and inventing one would break the hybrid name equality. The one
 *  exception is a radio MEMBER (164g.33), whose AcroForm name is its group's:
 *  the walk hands it a `#field[k]` path, which is internal only. */
/** An element's OWN `<margin>` insets, absent ones omitted. `child` searches
 *  DIRECT children only, which is what keeps the `<ui><textEdit><margin>` a
 *  real LiveCycle field also carries out of it -- reading that one instead
 *  drops every inset in the form. */
function marginOf(el: XmlNode): XfaMargin | undefined {
  const marEl = child(el, 'margin');
  return marEl ? Object.fromEntries(
    (['leftInset', 'rightInset', 'topInset', 'bottomInset'] as const)
      .flatMap((k) => {
        const v = marEl.attrs.get(k);
        return v === undefined ? [] : [[k, v] as const];
      }),
  ) as XfaMargin : undefined;
}

/** A field's `<caption>` reserve, placement and presence, verbatim -- ONE
 *  reader for `XfaField.caption` and the chrome's `fieldCaption` (164g.4). */
function captionAttrs(el: XmlNode): XfaCaption | undefined {
  const capEl = child(el, 'caption');
  return capEl ? {
    ...(capEl.attrs.get('reserve') !== undefined
      ? { reserve: capEl.attrs.get('reserve') } : {}),
    ...(capEl.attrs.get('placement') !== undefined
      ? { placement: capEl.attrs.get('placement') } : {}),
    ...(capEl.attrs.get('presence') !== undefined
      ? { presence: capEl.attrs.get('presence') } : {}),
  } : undefined;
}

/** The page-content half of a node's chrome (164g.4). A push button's field
 *  border is its widget's, so it is left to `XfaField.widgetBorder`. */
function chromeOf(el: XmlNode, kind: LayoutKind): NodeChrome | undefined {
  const c: NodeChrome = {};
  const isButton = kind === 'field' && child(el, 'ui')?.children[0]?.name === 'button';
  const border = child(el, 'border');
  if (border && !isButton) c.border = parseBorder(border);
  if (kind === 'draw') {
    const v = child(el, 'value');
    const g = v ? parseGeometry(v) : undefined;
    if (g) c.geometry = g;
  }
  if (kind === 'field') {
    const cap = captionText(el);
    if (cap) c.caption = cap;
    const pr = child(el, 'caption')?.attrs.get('presence');
    if (pr !== undefined) c.captionPresence = pr;
    const fc = captionAttrs(el);
    if (fc) c.fieldCaption = fc;
    const fm = marginOf(el);
    if (fm) c.fieldMargin = fm;
  }
  return Object.keys(c).length > 0 ? c : undefined;
}

function fieldOf(
  el: XmlNode, path: readonly string[], dpath: readonly string[], group: GroupPaths | undefined,
): XfaField | undefined {
  const partial = el.attrs.get('name');
  if ((partial === undefined || partial === '') && group === undefined) return undefined;

  const uiEl = child(el, 'ui');
  const uiChild = uiEl?.children[0];
  const ui = (uiChild && UI_KIND[uiChild.name]) ?? 'unknown';

  const access = el.attrs.get('access');
  const validate = child(el, 'validate');
  const valueEl = child(el, 'value');
  const textEl = valueEl ? child(valueEl, 'text') : undefined;
  const items = itemsOf(el);
  const defaultValue = valueText(valueEl);
  const open = uiChild?.attrs.get('open');
  const maxChars = positiveInt(textEl?.attrs.get('maxChars'));
  const assist = child(el, 'assist');
  const tooltip = assist ? child(assist, 'toolTip')?.text : undefined;
  const bind = child(el, 'bind');
  const bindRef = bind?.attrs.get('ref');
  const bindMatch = bind?.attrs.get('match');
  const caption = captionAttrs(el);
  const buttonCaption = uiChild?.name === 'button' ? buttonCaptionOf(el) : undefined;
  const margin = marginOf(el);
  const wbEl = uiChild?.name === 'button' ? child(el, 'border') : uiChild ? child(uiChild, 'border') : undefined;
  const buttonSize = uiChild?.name === 'checkButton'
    ? uiChild.attrs.get('size') : undefined;
  // The FIELD's own <para>, by the same direct-child rule the margin follows:
  // <caption> carries one too and the two are free to disagree.
  const paraEl = child(el, 'para');
  const para = paraEl ? Object.fromEntries(
    (['hAlign', 'vAlign'] as const).flatMap((k) => {
      const v = paraEl.attrs.get(k);
      return v === undefined ? [] : [[k, v] as const];
    }),
  ) as { hAlign?: string; vAlign?: string } : undefined;

  return {
    name: somName(path),
    dataPath: somName(dpath),
    ui,
    ...(group !== undefined ? { group: group.som, groupDataPath: group.data } : {}),
    ...(items ? { items } : {}),
    ...(open !== undefined ? { open } : {}),
    readOnly: access === 'readOnly' || access === 'protected',
    required: validate?.attrs.get('nullTest') === 'error',
    multiLine: uiChild?.name === 'textEdit' && uiChild.attrs.get('multiLine') === '1',
    ...(maxChars !== undefined ? { maxChars } : {}),
    ...(tooltip !== undefined && tooltip !== '' ? { tooltip } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    // A button's on-state is its first item's export half. '1' is XFA's own
    // default for a checkButton with no items; the AcroForm side turns
    // whatever this says into the /AP on-state key.
    ...(ui === 'checkButton' ? { onState: items?.[0]?.export ?? '1' } : {}),
    ...(bindRef !== undefined ? { bindRef } : {}),
    ...(bindMatch !== undefined ? { bindMatch } : {}),
    dataName: partial,
    ...(group?.global ? { groupGlobal: true as const } : {}),
    ...(caption ? { caption } : {}),
    // A push button's caption is its FACE, drawn inside the widget (/MK /CA),
    // never a region beside it, so it takes nothing from the box.
    ...(caption && caption.reserve === undefined && ui !== 'button' && captionText(el) ? { captionLeaf: captionText(el)! } : {}),
    ...(margin ? { margin } : {}),
    ...(buttonSize !== undefined ? { buttonSize } : {}),
    ...(buttonCaption !== undefined ? { buttonCaption } : {}),
    ...(para && Object.keys(para).length > 0 ? { para } : {}),
    ...(wbEl ? { widgetBorder: parseBorder(wbEl) } : {}),
    layouts: [],
  };
}

/** A push button's caption text, read from the XML rather than from
 *  `captionText`'s measured leaf: a face needs no measurement, so a span the
 *  measurer refuses (a tab, an embedded object) must not cost the label. Whitespace
 *  collapses to one space and the ends are trimmed, which is what a centred
 *  face draws -- Adobe writes DD 1155's "Reset " with its space, and that space
 *  only shifts the centring. A paragraph or a <br> is a space. */
function buttonCaptionOf(field: XmlNode): string | undefined {
  const cap = child(field, 'caption');
  const value = cap ? child(cap, 'value') : undefined;
  if (!cap || !value) return undefined;
  const pr = cap.attrs.get('presence');
  if (pr === 'hidden' || pr === 'inactive' || pr === 'invisible') return undefined;
  const parts: string[] = [];
  const walk = (n: XmlNode): void => {
    const block = n.name === 'p' || n.name === 'br' || n.name === 'div';
    if (block) parts.push(' ');
    if (n.nodes.length > 0) for (const c of n.nodes) { if (typeof c === 'string') parts.push(c); else walk(c); }
    else parts.push(n.text);
    if (block) parts.push(' ');
  };
  walk(value);
  const t = parts.join('').replace(/\s+/g, ' ').trim();
  return t === '' ? undefined : t;
}

/** The geometry attributes a container or field states, absent keys omitted. */
function geomOf(el: XmlNode): XfaRawGeom {
  const g: XfaRawGeom = {};
  for (const k of ['x', 'y', 'w', 'h', 'anchorType', 'rotate'] as const) {
    const v = el.attrs.get(k);
    if (v !== undefined) g[k] = v;
  }
  return g;
}

/** A container's layout: `position` is XFA's default. Repetition is not a
 *  layout -- since 164g.2 a repeating subform is walked once per instance. */
function layoutOf(el: XmlNode): string {
  return el.attrs.get('layout') ?? 'position';
}

/** A subform's `<occur>` with XFA 3.3's defaults applied: `min` 1, `max`
 *  copies `min` (p. 263, 341), `initial` copies `min` (p. 340); `max` -1 is
 *  unbounded. p. 339 says a missing attribute "defaults to 1", which disagrees
 *  only when `min` is stated; the specific statements win. */
interface Occur { min: number; max: number; initial: number }

function occurOf(el: XmlNode): Occur | { reason: string } {
  const o = el.children.find((c) => c.name === 'occur');
  if (!o) return { min: 1, max: 1, initial: 1 };
  const read = (k: 'min' | 'max' | 'initial'): number | undefined | null => {
    const v = o.attrs.get(k);
    if (v === undefined) return undefined;
    const t = v.trim();
    if (/^\d+$/.test(t)) return Number(t);
    if (k === 'max' && t === '-1') return -1;
    return null;
  };
  const minR = read('min');
  const maxR = read('max');
  const initR = read('initial');
  for (const [k, r] of [['min', minR], ['max', maxR], ['initial', initR]] as const)
    if (r === null) return { reason: `occur ${k}="${o.attrs.get(k) ?? ''}" could not be read` };
  const min = minR ?? 1;
  const max = maxR ?? min;
  const initial = initR ?? min;
  // p. 342 requires max >= min and gives no recovery, so neither bound wins.
  if (max !== -1 && max < min) return { reason: `occur max="${String(max)}" is below min="${String(min)}"` };
  return { min, max, initial };
}

/** Why a `<pageSet>` or `<pageArea>`'s `<occur min>` cannot be honoured, or
 *  undefined. A minimum forces BLANK pages to be appended when content runs out
 *  (p. 298, 300-301), and that padding is not laid out -- so a min that could
 *  demand it is refused rather than producing too few pages in silence. `floor`
 *  is what any layout that places anything already meets: 1 for a page set,
 *  0 for a page area. */
function minRefusal(el: XmlNode, floor: number): string | undefined {
  const v = child(el, 'occur')?.attrs.get('min');
  if (v === undefined || Number(v.trim()) <= floor) return undefined;
  return `${el.name} occur min="${v}" would demand blank pages, which are not laid out`;
}

/** A `<pageSet>` or `<pageArea>`'s `<occur max>`: -1 (the default, p. 300) or a
 *  positive integer; anything else is unreadable. */
function layoutMax(el: XmlNode): number | undefined {
  const o = child(el, 'occur');
  const v = o?.attrs.get('max');
  if (v === undefined) return -1;
  const t = v.trim();
  if (t === '-1') return -1;
  return /^\d+$/.test(t) && Number(t) > 0 ? Number(t) : undefined;
}

/** `<breakBefore>`/`<breakAfter>`, else the deprecated `<break>`'s half
 *  (p. 632-636), or `undefined` when it asks for nothing: `auto` continues in
 *  the current container (p. 635). `label` prefixes a refusal. */
function breakOf(
  el: XmlNode, which: 'before' | 'after', label: string, cc?: CopyCtx,
): XfaBreak | undefined {
  const modern = child(el, which === 'before' ? 'breakBefore' : 'breakAfter');
  const legacy = modern ? undefined : child(el, 'break');
  if (!modern && !legacy) return undefined;
  const tag = `<${(modern ?? legacy)!.name}>`;
  const targetType = (modern ? modern.attrs.get('targetType') : legacy!.attrs.get(which)) ?? 'auto';
  const target = modern ? modern.attrs.get('target')
    : legacy!.attrs.get(which === 'before' ? 'beforeTarget' : 'afterTarget');
  const startNew = modern ? modern.attrs.get('startNew') === '1'
    : which === 'before' && legacy!.attrs.get('startNew') === '1';
  const shown = modern ? `${tag} targetType="${targetType}"` : `${tag} ${which}="${targetType}"`;
  let refusal: string | undefined;
  const script = modern ? child(modern, 'script') : undefined;
  // 164g.15: a break's own leader and trailer, one target each.
  const lead = modern ? copyOf(modern.attrs.get('leader'), cc, 'break', `${label}: ${tag}'s leader`) : undefined;
  const trail = modern ? copyOf(modern.attrs.get('trailer'), cc, 'break', `${label}: ${tag}'s trailer`) : undefined;
  if (script && script.text.trim() !== '') refusal = `${label}: ${tag} with a script is not implemented`;
  else if (!['auto', 'pageArea', 'contentArea', 'pageEven', 'pageOdd'].includes(targetType))
    refusal = `${label}: ${shown} is not one XFA defines`;
  else if (targetType === 'auto' && (lead || trail))
    refusal = `${label}: ${tag} with a leader or trailer on a break that does not move is not implemented (164g.31)`;
  if (targetType === 'auto' && refusal === undefined) return undefined;
  return {
    targetType,
    ...(target !== undefined && target.trim() !== '' ? { target } : {}),
    startNew,
    ...(refusal !== undefined ? { refusal } : {}),
    ...(lead ? { leader: lead } : {}),
    ...(trail ? { trailer: trail } : {}),
  };
}

/** Where a leader or trailer's copies are named and how its SOM name is
 *  searched for (164g.15): the asserting subform for an overflow copy, its
 *  PARENT for a break copy (t85: `form1.T`). */
interface CopyHome {
  /** The element whose children the copies join -- the asserting subform or
   *  its parent. A bare SOM name is searched from the ASSERTING one either way. */
  el: XmlNode;
  path: readonly string[];
  dpath: readonly string[];
  scope: IndexScope;
  layouts: readonly string[];
}
/** What `nodeOf` needs to read a subform's leaders and trailers. */
interface CopyCtx { own: CopyHome; parent: CopyHome; top: Top }

/** A bare SOM name we resolve: one name, no dots, brackets or operators. */
const BARE_NAME = /^[A-Za-z_][\w-]*$/;

/** A leader or trailer target to the element it names, ignored (Adobe ignores
 *  it: t74, t75, t90; XFA 3.3 p. 323), or a refusal (164g.15 R1). `#id` names an
 *  element under the ROOT subform, `<proto>` included -- a template-level proto
 *  is outside it, and Adobe ignores a target there. A bare name is searched as
 *  a named subform child of `from`, then of each ancestor, nearest first. */
function targetOf(ref: string, from: XmlNode, top: Top): XmlNode | { ignored: string } | { refusal: string } {
  let el: XmlNode | undefined;
  if (ref.startsWith('#')) {
    el = top.ids?.get(ref.slice(1));
    if (!el) return { ignored: `"${ref}" names nothing under the root subform` };
  } else if (BARE_NAME.test(ref)) {
    for (let at: XmlNode | undefined = from; at && !el; at = top.parents?.get(at))
      el = at.children.find((c) => c.name === 'subform' && c.attrs.get('name') === ref);
    if (!el) return { refusal: `"${ref}" is a SOM name we resolve to no subform` };
  } else return { refusal: `"${ref}" is a SOM expression, which is not resolved` };
  if (el.name === 'subformSet') return { refusal: `"${ref}" names a subformSet, which is not laid out` };
  if (el.name !== 'subform') return { ignored: `"${ref}" names a <${el.name}>, not a subform` };
  if ((el.attrs.get('name') ?? '') === '') return { refusal: `"${ref}" names an unnamed subform, whose copies no oracle names` };
  return el;
}

/** One target to a copy spec, or undefined when there is none: no ref, or an
 *  invalid one, which is warned about. A break names ONE target; an overflow's
 *  list is split by the caller. */
function copyOf(
  ref: string | undefined, cc: CopyCtx | undefined, kind: 'break' | 'overflow', what: string,
): XfaCopySpec | undefined {
  const r = ref?.trim();
  if (r === undefined || r === '' || !cc) return undefined;
  const home = kind === 'break' ? cc.parent : cc.own;
  if (/\s/.test(r)) return refusedSpec(r, `${what} "${r}" names several targets (164g.15)`, home);
  return specOf(r, home, cc.top, what, cc.own.el);
}

/** A target that refuses where it would be inserted. Pagination never asks
 *  its `make`; it answers a refused node rather than throwing. */
function refusedSpec(r: string, refusal: string, home: CopyHome): XfaCopySpec {
  return {
    label: r, refusal, max: 1, scope: home.scope, name: '',
    make: () => ({ kind: 'subform', label: r, geom: {}, children: [], refusal }),
  };
}

function specOf(
  r: string, home: CopyHome, top: Top, what: string, from: XmlNode = home.el,
): XfaCopySpec | undefined {
  const t = targetOf(r, from, top);
  const refused = (why: string): XfaCopySpec => refusedSpec(r, `${what} ${why} (164g.15)`, home);
  if ('ignored' in t) {
    const w = `${what} ${t.ignored}, so it is ignored, as Adobe ignores it (XFA 3.3 p. 323)`;
    if (top.warnings && !top.warnings.includes(w)) top.warnings.push(w);
    return undefined;
  }
  if ('refusal' in t) return refused(t.refusal);
  const target = t;
  const max = copyMax(target);
  if (max === undefined) return refused(`"${r}" states an unreadable <occur max>`);
  const name = target.attrs.get('name')!;
  return {
    label: r, max, scope: home.scope, name,
    make: (n) => {
      // The copy is the instance after every one the walk counted (t73: H[1]).
      const part = `${name}[${String((home.scope.byName.get(name) ?? 0) + n)}]`;
      const sub = [...home.path, part];
      const dsub = [...home.dpath, part];
      const own = newScope();
      const layouts = [...home.layouts, layoutOf(target)];
      const node = nodeOf(target, 'subform', part, undefined, {
        own: { el: target, path: sub, dpath: dsub, scope: own, layouts }, parent: home, top,
      });
      const fields: XfaField[] = [];
      walk(target, sub, dsub, undefined, { layouts, inPage: true }, fields, node, own, [], top.groups, top);
      top.copyFields?.set(node, fields);
      return node;
    },
  };
}

/** A leader or trailer's `<occur max>`: 1 when absent (Adobe t73), -1 for none. */
function copyMax(el: XmlNode): number | undefined {
  const v = child(el, 'occur')?.attrs.get('max');
  if (v === undefined) return 1;
  const t = v.trim();
  if (t === '-1') return -1;
  return /^\d+$/.test(t) && Number(t) > 0 ? Number(t) : undefined;
}

/** A subform's `<overflow>`, else the deprecated `<break overflowLeader
 *  overflowTrailer overflowTarget>` (XFA 3.3 p. 791, 634), 164g.15. A stated but
 *  empty list blocks inheritance (t80); an absent one inherits. */
function overflowOf(el: XmlNode, cc: CopyCtx | undefined, label: string): XfaOverflow | undefined {
  const modern = child(el, 'overflow');
  const legacy = modern ? undefined : child(el, 'break');
  const read = (a: 'leader' | 'trailer' | 'target'): string | undefined => (modern
    ? modern.attrs.get(a) : legacy?.attrs.get(`overflow${a[0].toUpperCase()}${a.slice(1)}`));
  const out: XfaOverflow = {};
  for (const kind of ['leader', 'trailer'] as const) {
    const v = read(kind);
    if (v === undefined || !cc) continue;
    const what = `${label}: its overflow ${kind}`;
    out[kind] = v.split(' ').filter((s) => s !== '').flatMap((r) => specOf(r, cc.own, cc.top, what) ?? []);
  }
  const target = read('target')?.trim();
  if (target) out.target = target;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * How many instances of a subform the merge makes, or why that cannot be
 * answered (164g.2). A refused subform is walked ONCE, exactly as before.
 *
 * Empty merge -- no groups, or no data at all -- is `initial` (p. 345).
 * Otherwise it is the count of same-named data groups at the parent's data
 * path, raised to `min` and capped at `max` (p. 341-344). The general merge --
 * scope matching, flat data spread across nested repeats -- is out of scope, so
 * every shape it would be needed for refuses by name.
 */
function repetition(
  c: XmlNode, anonymous: boolean, dataParent: string, parentLayout: string,
  groups: XfaDataGroups | undefined,
): { count: number; refusal?: string } {
  const o = occurOf(c);
  if ('reason' in o) return { count: 1, refusal: o.reason };
  let n: number;
  if (groups === undefined || groups.empty) {
    n = o.initial;
  } else if (anonymous) {
    if (o.max !== 1 || o.min !== 1)
      return { count: 1, refusal: 'an unnamed repeating subform has no data groups to count' };
    n = 1;
  } else {
    const bind = c.children.find((x) => x.name === 'bind');
    const bound = bind !== undefined
      && ((bind.attrs.get('ref') ?? '') !== '' || bind.attrs.get('match') === 'none');
    if (bound && (o.max !== 1 || o.min !== 1))
      return { count: 1, refusal: 'a repeating subform bound by ref or match="none" is not instantiated' };
    const d = groups.count(dataParent, c.attrs.get('name') ?? '');
    n = Math.max(o.min, o.max === -1 ? d : Math.min(d, o.max));
  }
  const repeating = o.max !== 1 || n !== 1;
  if (!repeating) return { count: n };
  if (n > 1 && parentLayout === 'position')
    return { count: 1, refusal: `${String(n)} instances of a repeating subform in a positioned container would overlap` };
  return { count: n };
}

/** One template element to its layout node. A container carries its layout,
 *  its own margin and a table's column widths; a field or draw carries only
 *  what positions it in its parent. */
function nodeOf(el: XmlNode, kind: LayoutKind, label: string, field?: string, cc?: CopyCtx): LayoutNode {
  const n: LayoutNode = { kind, label, geom: geomOf(el), children: [] };
  if (kind !== 'field' && kind !== 'draw') {
    n.layout = layoutOf(el);
    const m = marginOf(el);
    if (m) n.margin = m;
    const cw = el.attrs.get('columnWidths');
    if (cw !== undefined) n.columnWidths = cw;
  }
  const mm: XfaMinMax = {};
  for (const k of ['minW', 'minH', 'maxW', 'maxH'] as const) {
    const v = el.attrs.get(k);
    if (v !== undefined) mm[k] = v;
  }
  if (Object.keys(mm).length > 0) n.minMax = mm;
  const colSpan = el.attrs.get('colSpan');
  if (colSpan !== undefined) n.colSpan = colSpan;
  const hAlign = el.attrs.get('hAlign');
  if (hAlign !== undefined) n.hAlign = hAlign;
  const presence = el.attrs.get('presence');
  if (presence !== undefined) n.presence = presence;
  if (field !== undefined) n.field = field;
  if (kind === 'field' || kind === 'draw') n.text = leafText(el);
  if (kind === 'field') {
    const ui = child(el, 'ui')?.children[0];
    if (ui) {
      n.ui = ui.name;
      if (child(ui, 'comb')) n.comb = true;
    }
    const para = child(el, 'para');
    if (para && ['orphans', 'widows'].some((a) => Number(para.attrs.get(a) ?? '0') !== 0)) n.lineKeep = true;
  }
  if (kind === 'field' || kind === 'draw') {
    // 164g.14: a leaf adheres to its siblings (t60, t65). Its intact is not
    // read: whether a field splits is fieldCut's (164g.13), and is unprobed.
    const k = keepOf(el, ['next', 'previous']);
    if (k) n.keep = k;
  }
  if (kind === 'subform') {
    const bb = breakOf(el, 'before', label, cc);
    if (bb) n.breakBefore = bb;
    const ba = breakOf(el, 'after', label, cc);
    if (ba) n.breakAfter = ba;
    // 164g.8: pagination honours keep intact and refuses what it cannot do.
    const k = keepOf(el, ['intact', 'next', 'previous']);
    if (k) n.keep = k;
    // 164g.15: leaders and trailers are resolved here, copies made lazily.
    const of = overflowOf(el, cc, label);
    if (of) n.overflow = of;
  }
  const ch = chromeOf(el, kind);
  if (ch) n.chrome = ch;
  return n;
}

/** What a container contributes to the fields beneath it. */
interface ChainCtx {
  /** Layouts between the page origin and here, outermost first. */
  layouts: string[];
  /** True once the walk has passed BELOW the root subform, which carries the
   *  `<pageSet>`. Above it there is no page origin, so nothing is accumulated. */
  inPage: boolean;
}

/** The walk's view of the template as a whole. */
interface Top {
  /** The root subform; its node becomes `XfaBody.root`. Undefined for the walk
   *  over a master page. */
  rootEl?: XmlNode;
  /** Some page area declares a content area: the chain then starts at one. */
  hasCa: boolean;
  root?: LayoutNode;
  /** The paginated page set's page areas by ELEMENT, with their index in
   *  `pageSet.pageAreas`. By identity, never by position: `pageSetOf` drops
   *  an unreadable page area while the walk drops an unnamed one, so the two
   *  orders can differ. */
  masters?: Map<XmlNode, { index: number; area: XfaPageAreaModel }>;
  /** 164g.15, the body walk's only: every element under the ROOT subform by
   *  its `id` (`<proto>` included, a template-level proto not), each element's
   *  parent, the warnings, every copy's fields and the data groups a copy is
   *  instantiated with. A master-page walk has none, and reads no leader. */
  ids?: Map<string, XmlNode>;
  parents?: Map<XmlNode, XmlNode>;
  warnings?: string[];
  copyFields?: Map<LayoutNode, XfaField[]>;
  groups?: XfaDataGroups;
}

/**
 * Walk `<subform>` / `<exclGroup>` / `<field>` and yield one entry per terminal
 * field, with its geometry, its ancestor layout chain and its page.
 *
 * **An UNNAMED container is in the SOM name and transparent to everything else
 * (fdq3).** The name gives it a level spelled by its CLASS, `#subform[n]` or
 * `#area[n]`, which is what LiveCycle writes into a hybrid's /AcroForm. But its
 * occurrence counters are NOT its own: every index below it -- `name[i]` and
 * `#class[i]` alike -- is counted over the scope of the nearest NAMED
 * container, so unnamed containers share one numbering. The DATA path leaves
 * the level out entirely, because normal data binding makes an unnamed
 * container transparent and the datasets packet has no element for it.
 *
 * **Measured, against bytes we did not write:** USCIS I-130's twelve page
 * subforms are all unnamed, so its nearest named container is `form1` and
 * Adobe numbers its unnamed areas 4, 5, 6, 7 and 8 across the document, and its
 * second `Pt2Line1_AlienNumber` -- in a different page subform from the first --
 * `[1]`. I-765's unnamed area is `#area[1]`, after a named area in the same
 * named `Page3`. Both rules reproduce all 438 and 154 body-field names; counting
 * per parent reproduces 428, and leaving the level out reproduces none.
 *
 * Until fdq3 this walk read the binding rule as the naming rule. No field under
 * an unnamed container reconciled, conversion added a second copy of each, and
 * two same-named fields in two unnamed subforms bound the SAME datum.
 *
 * **Where the chain BEGINS:** at the content area, below the root subform.
 * LiveCycle's root `<subform>` -- the one carrying the `<pageSet>` -- is
 * routinely `layout="tb"`, because that flow is what breaks PAGES (164g.3,
 * `xfapage.ts`) rather than what places FIELDS. Read as starting at the
 * document root, "every ancestor must be position" degrades every field of
 * every LiveCycle form.
 */
function walk(
  el: XmlNode, path: readonly string[], dpath: readonly string[], group: GroupPaths | undefined,
  ctx: ChainCtx, out: XfaField[], parent: LayoutNode | undefined, scope: IndexScope,
  master: XfaField[], groups: XfaDataGroups | undefined, top: Top,
): void {
  // Occurrence indices are per NAME, counted over the scope of the nearest
  // NAMED container -- this element's own when it is named, an ancestor's when
  // it is not.
  const indexed = (n: string): string => {
    const i = scope.byName.get(n) ?? 0;
    scope.byName.set(n, i + 1);
    return `${n}[${String(i)}]`;
  };
  // A class reference's index counts EVERY element of that type in the scope,
  // named or not: I-765's unnamed <area> after a named one is `#area[1]`.
  const classIndex = (c: XmlNode): number => {
    const i = scope.byClass.get(c.name) ?? 0;
    scope.byClass.set(c.name, i + 1);
    return i;
  };
  for (const c of el.children) {
    const partial = c.attrs.get('name');
    const nth = classIndex(c);
    if (c.name === 'pageSet') {
      // Counted in this scope's class numbering (`#pageSet[n]`), but it OPENS a
      // numbering of its own: USCIS I-765 names a body subform and a pageArea
      // both `Page1`, and Adobe writes the pageArea's first instance
      // `#pageSet[0].Page1[0]`, not `[1]`.
      // 164g.22: a nested page set is walked too, named in its parent's scope
      // (`#pageSet[k]`) with a scope of its own. Its page areas get their
      // master roots, so their draws and chrome are laid out; their FIELDS are
      // left unidentified (no `master`) -- how Reader names an instance in a
      // nested set is unprobed -- and the converter reports them.
      const walkSet = (set: XmlNode, ps: string[], depth: number): void => {
        const psScope = newScope();
        for (const pa of set.children) {
          if (pa.name === 'pageSet') {
            const k = psScope.byClass.get('pageSet') ?? 0;
            psScope.byClass.set('pageSet', k + 1);
            walkSet(pa, [...ps, `#pageSet[${String(k)}]`], depth + 1);
            continue;
          }
          if (pa.name !== 'pageArea') continue;
          const n = pa.attrs.get('name');
          if (n === undefined || n === '') {
            // An UNNAMED page area is still paginated onto pages, but no oracle
            // says how Adobe names its instances, so its fields are walked for
            // the REPORT only: no layout root, no `master`, refused by the
            // converter rather than lost silently (d3mq final review).
            const k = psScope.byClass.get('pageArea') ?? 0;
            psScope.byClass.set('pageArea', k + 1);
            walk(pa, [...ps, `#pageArea[${String(k)}]`], [], undefined, { layouts: [], inPage: false },
              master, undefined, newScope(), master, undefined, { hasCa: false });
            continue;
          }
          const idx = psScope.byName.get(n) ?? 0;
          const at = [...ps, `${n}[${String(idx)}]`];
          psScope.byName.set(n, idx + 1);
          // d3mq: the page area's background is laid out from the PAGE ORIGIN,
          // positioned (XFA 3.3 p. 271, 288), copied onto every page that
          // instantiates it. Walked with a root of its own as the parent, so its
          // fields, draws and subforms build a layout tree exactly as body
          // content does; its fields land in `master` alone. A <contentArea> is
          // not content and adds no node.
          const root: LayoutNode = { kind: 'page', label: `<pageArea ${n}>`, layout: 'position', geom: {}, children: [] };
          const before = master.length;
          walk(pa, at, [], undefined, { layouts: ['position'], inPage: true }, master, root,
            newScope(), master, undefined, { hasCa: false });
          // Only the FIRST page area of a name is identified: the instance
          // numbering of a repeated name is something no oracle settles.
          const model = top.masters?.get(pa);
          if (model === undefined || idx !== 0) continue;
          model.area.master = root;
          const prefix = `${somName(at)}.`;
          for (const f of master.slice(before)) {
            if (depth === 0 && f.name.startsWith(prefix))
              f.master = { pageArea: model.index, base: somName([...ps, n]), rest: f.name.slice(prefix.length) };
          }
        }
      };
      walkSet(c, [...path, `#pageSet[${String(nth)}]`], 0);
      continue;
    }
    if (c.name === 'draw') {
      // 164g.33: a named draw takes an occurrence index like any same-named
      // sibling, so a field or subform after it is `name[1]` (DD 3183's
      // `title`, DD 3019's `Pulses`). It has no SOM name of its own to keep.
      if (partial !== undefined && partial !== '') indexed(partial);
      if (parent) {
        parent.children.push(
          nodeOf(c, 'draw', partial === undefined || partial === '' ? '<draw>' : partial),
        );
      }
      continue;
    }
    if (c.name === 'field') {
      const unnamed = partial === undefined || partial === '';
      // 164g.33: an unnamed MEMBER of an <exclGroup> is kept, addressed by its
      // SOM class reference. Adobe writes the group and leaves its widgets
      // unnamed, so this address reaches no AcroForm name; dropped, it took the
      // whole group with it (DD 3183, 2023). Outside a group an unnamed field
      // still has nothing to be called.
      const sub = !unnamed ? [...path, indexed(partial)]
        : group !== undefined ? [...path, `#field[${String(nth)}]`] : path;
      const dsub = unnamed ? dpath : [...dpath, sub[sub.length - 1]];
      const f = fieldOf(c, sub, dsub, group);
      if (f) {
        f.layouts = [...ctx.layouts];
        out.push(f);
      }
      // An unnamed field still takes up its space in a flow, so it joins the
      // tree with no SOM name.
      if (parent)
        parent.children.push(nodeOf(c, 'field', sub === path ? '<field>' : sub[sub.length - 1], f?.name));
      continue;
    }
    if (c.name !== 'subform' && c.name !== 'exclGroup' && c.name !== 'area') continue;
    const anonymous = partial === undefined || partial === '';
    // 164g.2: only a SUBFORM repeats (p. 263; subformSet is not read at all).
    const rep = c.name === 'subform'
      ? repetition(c, anonymous, somName(dpath), el.attrs.get('layout') ?? 'position', groups)
      : { count: 1 };
    // N = 0 (`min="0"` and no data): no instance, so it consumes no index.
    if (rep.count === 0) { scope.byClass.set(c.name, nth); continue; }
    for (let k = 0; k < rep.count; k++) {
      const cls = k === 0 ? nth : classIndex(c);
      const sub = [...path, anonymous ? `#${c.name}[${String(cls)}]` : indexed(partial)];
      const dsub = anonymous ? dpath : [...dpath, sub[sub.length - 1]];
      // The root subform: a tb flow that pagination (xfapage.ts) pours into
      // content areas. Its node IS the body; the chain of everything below
      // starts at the content area, which places its first child at its
      // origin. Above any page origin, accumulate nothing.
      const next: ChainCtx = c === top.rootEl ? { layouts: top.hasCa ? ['position'] : [], inPage: true }
        : !ctx.inPage ? { layouts: [], inPage: false }
          : { layouts: [...ctx.layouts, layoutOf(c)], inPage: true };
      const own = anonymous ? scope : newScope();
      // 164g.15: an overflow copy is named in this subform's scope, a break copy
      // in its parent's. Only the body walk resolves them.
      const cc: CopyCtx | undefined = top.copyFields ? {
        own: { el: c, path: sub, dpath: dsub, scope: own, layouts: next.layouts },
        parent: { el, path, dpath, scope, layouts: ctx.layouts },
        top,
      } : undefined;
      const node = nodeOf(c, c.name as LayoutKind, anonymous ? `<${c.name}>` : sub[sub.length - 1], undefined, cc);
      if (rep.refusal !== undefined) node.refusal = `${node.label}: ${rep.refusal}`;
      if (c === top.rootEl) top.root = node;
      else if (ctx.inPage) parent?.children.push(node);
      walk(
        c, sub, dsub,
        c.name === 'exclGroup'
          ? { som: somName(sub), data: somName(dsub),
            ...(child(c, 'bind')?.attrs.get('match') === 'global' ? { global: true as const } : {}) }
          : group,
        next, out, next.inPage ? node : undefined,
        own, master, groups, top,
      );
    }
  }
}

/** Every `<pageSet>` in the template, with the element holding it. */
function pageSets(el: XmlNode, out: Array<{ ps: XmlNode; parent: XmlNode }>): void {
  for (const c of el.children) {
    if (c.name === 'pageSet') out.push({ ps: c, parent: el });
    pageSets(c, out);
  }
}

const QUALIFIERS = {
  pagePosition: ['any', 'first', 'last', 'rest', 'only'],
  oddOrEven: ['any', 'odd', 'even'],
  blankOrNotBlank: ['any', 'blank', 'notBlank'],
} as const;
type Qualifiers = Pick<XfaPageAreaModel, 'pagePosition' | 'oddOrEven' | 'blankOrNotBlank'>;

/** A qualified page area's pagePosition, oddOrEven and blankOrNotBlank (XFA 3.3
 *  p. 302-303), or why one cannot be read. Absent reads as `any`. */
function qualifiersOf(el: XmlNode): Qualifiers | string {
  const out: Record<string, string> = {};
  for (const [key, allowed] of Object.entries(QUALIFIERS)) {
    const v = el.attrs.get(key);
    if (v === undefined) continue;
    if (!(allowed as readonly string[]).includes(v)) return `pageArea ${key}="${v}" is not one XFA defines (XFA 3.3 p. 302)`;
    out[key] = v;
  }
  return out as Qualifiers;
}

/** One `<pageArea>` element to its model. A content area's node is the `tb`
 *  root `xfapage.ts` lays out (XFA 3.3 p. 288). Under a qualified relation
 *  (`qualified`) its qualifiers are read and its `<occur>` is ignored with a
 *  warning (p. 296, 302); under the ordered relation the reverse. */
function pageAreaOf(el: XmlNode, qualified?: string, warnings: string[] = []): XfaPageAreaModel | string {
  const m = child(el, 'medium');
  let medium: XfaMedium | undefined;
  if (m) {
    const short = m.attrs.get('short');
    const long = m.attrs.get('long');
    const orientation = m.attrs.get('orientation');
    medium = {
      ...(short !== undefined ? { short } : {}),
      ...(long !== undefined ? { long } : {}),
      ...(orientation !== undefined ? { orientation } : {}),
    };
  }
  let max: number | undefined = -1;
  let quals: Qualifiers = {};
  if (qualified) {
    if (child(el, 'occur'))
      warnings.push(`pageArea ${el.attrs.get('name') ?? '(unnamed)'} states <occur>, which ${qualified} ignores (XFA 3.3 p. 296)`);
    const q = qualifiersOf(el);
    if (typeof q === 'string') return q;
    quals = q;
  } else {
    max = layoutMax(el);
    if (max === undefined)
      return `pageArea occur max="${child(el, 'occur')?.attrs.get('max') ?? ''}" could not be read (XFA 3.3 p. 300: -1 or positive)`;
    const short = minRefusal(el, 0);
    if (short !== undefined) return short;
  }
  const named = (x: XmlNode) => {
    const name = x.attrs.get('name');
    const id = x.attrs.get('id');
    return { ...(name !== undefined ? { name } : {}), ...(id !== undefined ? { id } : {}) };
  };
  const contentAreas: XfaContentArea[] = el.children.filter((c) => c.name === 'contentArea').map((c) => ({
    ...named(c),
    node: { kind: 'page', label: 'contentArea', layout: 'tb', geom: geomOf(c), children: [] },
  }));
  return { ...named(el), ...(medium ? { medium } : {}), max, ...quals, contentAreas };
}

/** The root subform's `<pageSet>` model, or why it cannot be paginated.
 *
 *  164g.22: a page set may hold page sets, read into `XfaPageSet.sets` with
 *  every page area kept in ONE flat document-order list. Of several sibling
 *  page sets on the root subform the FIRST is used and the rest are ignored
 *  with a warning: Adobe Reader does not evaluate `relevant` on screen and
 *  never traverses to a later sibling (probes n5, n6, n10; p. 300). */
function pageSetOf(
  template: XmlNode, rootEl: XmlNode,
  masters: Map<XmlNode, { index: number; area: XfaPageAreaModel }>,
): XfaPageSet | undefined {
  const found: Array<{ ps: XmlNode; parent: XmlNode }> = [];
  pageSets(template, found);
  if (found.length === 0) return undefined;
  const { ps, parent } = found[0];
  const warnings: string[] = [];
  const areas: XfaPageAreaModel[] = [];
  const sets: XfaPageSetNode[] = [];
  let refusal: string | undefined;
  const nested = new Set<XmlNode>();
  const read = (el: XmlNode, up?: number): number => {
    const relation = el.attrs.get('relation') ?? 'orderedOccurrence';
    const qualified = relation === 'simplexPaginated' || relation === 'duplexPaginated' ? relation : undefined;
    const idx = sets.length;
    const node: XfaPageSetNode = { relation, max: -1, ...(up !== undefined ? { parent: up } : {}), children: [] };
    sets.push(node);
    if (!qualified && relation !== 'orderedOccurrence')
      refusal ??= `pageSet relation="${relation}" is not one XFA defines (XFA 3.3 p. 798)`;
    for (const c of el.children) {
      if (c.name === 'pageArea') {
        const a = pageAreaOf(c, qualified, warnings);
        if (typeof a === 'string') { refusal ??= a; continue; }
        const model = idx === 0 ? a : { ...a, set: idx };
        masters.set(c, { index: areas.length, area: model });
        node.children.push({ area: areas.length });
        areas.push(model);
      } else if (c.name === 'pageSet') {
        nested.add(c);
        const cr = c.attrs.get('relation') ?? 'orderedOccurrence';
        const cq = cr === 'simplexPaginated' || cr === 'duplexPaginated';
        // p. 310: the two kinds of page set never nest in each other.
        if (cq !== (qualified !== undefined))
          refusal ??= `${cq ? 'a qualified' : 'an ordered'} pageSet nested in ${qualified ? 'a qualified' : 'an ordered'} one is forbidden (XFA 3.3 p. 310)`;
        node.children.push({ set: read(c, idx) });
      }
    }
    if (qualified) {
      // p. 296, 310: occurrence limits do not apply to a qualified page set.
      if (child(el, 'occur')) warnings.push(`pageSet states <occur>, which ${qualified} ignores (XFA 3.3 p. 296)`);
    } else {
      const max = layoutMax(el);
      if (max === undefined)
        refusal ??= `pageSet occur max="${child(el, 'occur')?.attrs.get('max') ?? ''}" could not be read (XFA 3.3 p. 300: -1 or positive)`;
      node.max = max ?? -1;
      // The root set is entered anyway, so min 1 asks for nothing; a nested
      // set's min would force instances no content reaches.
      const short = minRefusal(el, up === undefined ? 1 : 0);
      if (short !== undefined) refusal ??= short;
    }
    // p. 298: a page set of pure-boilerplate page areas with no max would emit
    // pages forever; read its max as 1, with a warning.
    if (!qualified && node.max === -1 && up !== undefined && !holdsContent(el)) {
      warnings.push(`pageSet ${el.attrs.get('name') ?? String(idx)} holds no contentArea and states no occur max, so its max is read as 1 (XFA 3.3 p. 298)`);
      node.max = 1;
    }
    return idx;
  };
  read(ps);
  const siblings = found.slice(1).filter((f) => f.parent === parent).map((f) => f.ps);
  for (const f of found.slice(1)) {
    if (nested.has(f.ps) || isInside(f.ps, siblings)) continue;
    if (f.parent === parent)
      warnings.push(`pageSet ${f.ps.attrs.get('name') ?? '(unnamed)'} is a later sibling of the first, which alone is paginated: Adobe Reader does not evaluate relevant on screen (probes n5, n6, n10)`);
    else refusal ??= 'a pageSet not on the root subform is not paginated';
  }
  if (parent !== rootEl) refusal = 'a pageSet not on the root subform is not paginated';
  return {
    relation: sets[0].relation,
    max: sets[0].max,
    pageAreas: areas,
    ...(sets.length > 1 ? { sets } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(refusal !== undefined ? { refusal } : {}),
  };
}

/** Whether a page set holds a content area anywhere below it. */
function holdsContent(el: XmlNode): boolean {
  return el.children.some((c) => (c.name === 'pageArea' && c.children.some((x) => x.name === 'contentArea'))
    || (c.name === 'pageSet' && holdsContent(c)));
}

/** Whether `el` lies strictly inside one of `outer` (a set in an ignored sibling). */
function isInside(el: XmlNode, outer: readonly XmlNode[]): boolean {
  const has = (x: XmlNode): boolean => x.children.some((c) => c === el || has(c));
  return outer.some(has);
}

/** The `template` packet's root element to the field model. `groups` is the
 *  datasets' data groups (164g.2); omitted, every repeating subform takes its
 *  `initial`, the empty-merge answer. */
export function parseXfaTemplate(root: XmlNode, groups?: XfaDataGroups): XfaTemplate {
  const rootEl = root.children.find((c) => c.name === 'subform');
  const masters = new Map<XmlNode, { index: number; area: XfaPageAreaModel }>();
  const pageSet = rootEl ? pageSetOf(root, rootEl, masters) : undefined;
  // 164g.15: a leader's #id is looked up under the ROOT subform only -- Adobe
  // ignores a target in a template-level <proto> (t74, t75) -- and a bare name
  // searched up through every element's parent.
  const ids = new Map<string, XmlNode>();
  const parents = new Map<XmlNode, XmlNode>();
  const index = (el: XmlNode, under: boolean): void => {
    const id = el.attrs.get('id');
    if (under && id !== undefined && !ids.has(id)) ids.set(id, el);
    for (const c of el.children) { parents.set(c, el); index(c, under || c === rootEl); }
  };
  index(root, false);
  const warnings: string[] = [];
  const copyFields = new Map<LayoutNode, XfaField[]>();
  const top: Top = {
    ...(rootEl ? { rootEl } : {}),
    hasCa: pageSet?.pageAreas.some((p) => p.contentAreas.length > 0) ?? false,
    masters, ids, parents, warnings, copyFields, ...(groups ? { groups } : {}),
  };
  const fields: XfaField[] = [];
  const masterPageFields: XfaField[] = [];
  walk(root, [], [], undefined, { layouts: [], inPage: false }, fields, undefined, newScope(),
    masterPageFields, groups, top);
  const body: XfaBody | undefined = top.root ? { root: top.root, ...(pageSet ? { pageSet } : {}) } : undefined;
  return { fields, ...(body ? { body } : {}), masterPageFields, copyFields, warnings };
}
