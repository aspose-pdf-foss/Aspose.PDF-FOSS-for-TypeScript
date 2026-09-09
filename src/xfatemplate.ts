/**
 * The XFA `template` packet as a flat field model.
 *
 * **Invariant: pure, over `xml.js` alone.** No `Document`, no PDF object, no
 * `node:` import -- so every rule here is drivable from an XML string.
 *
 * **Invariant: it never throws.** `parseXml` does, and `xfapacket.ts` owns that
 * boundary; by the time a tree reaches here it parsed.
 *
 * **Note `xml.ts` strips namespace prefixes** (`xml.ts:38`), so `<xfa:field>`
 * arrives as `field`. Nothing here may rely on a prefix to disambiguate two
 * elements.
 */
import type { XmlNode } from './xml.js';
import type { XfaMargin, XfaMedium, XfaOffset, XfaRawGeom } from './xfageom.js';

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
  /** The SOM expression, occurrence indices included. */
  name: string;
  ui: XfaUiKind;
  /** The enclosing `<exclGroup>`'s SOM path, for a radio member. */
  group?: string;
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
  /** `<caption>`'s `reserve`, `placement` and `presence`, verbatim.
   *
   *  A field's WIDGET covers the field box MINUS this reserve: the caption is
   *  the label drawn beside the input, and LiveCycle's own `/AcroForm` places
   *  the widget over the edit region alone. Measured on IRS f1040, whose
   *  `f1_01` is 280.8pt wide with a 192.8pt reserve and whose Adobe rect is
   *  exactly 88pt. Ignore it and every captioned field is drawn far too wide,
   *  overlapping its own label. */
  caption?: { reserve?: string; placement?: string; presence?: string };
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
  /** The FIELD's own `<para>` alignment, verbatim -- never the one nested in
   *  `<caption>`, which f1040's `c1_1` also carries and which is free to
   *  disagree. It places the button inside the edit region. */
  para?: { hAlign?: string; vAlign?: string };
  /** Filled by the geometry pass. */
  geom: XfaRawGeom;
  /** Each container's layout between the page origin and this field, outermost
   *  first. Filled by the geometry pass. */
  layouts: string[];
  /** Each of those containers' own x/y, in the same order. */
  offsets: XfaOffset[];
  /** 0-based `<pageArea>` index. */
  pageIndex?: number;
}

export interface XfaPageArea { name?: string; medium?: XfaMedium }

export interface XfaTemplate { fields: XfaField[]; pages: XfaPageArea[] }

/** A SOM expression from its already-indexed parts. */
export function somName(parts: readonly string[]): string {
  return parts.join('.');
}

const child = (n: XmlNode, name: string): XmlNode | undefined =>
  n.children.find((c) => c.name === name);

const childrenNamed = (n: XmlNode, name: string): XmlNode[] =>
  n.children.filter((c) => c.name === name);

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
 *  AcroForm and inventing one would break the hybrid name equality. */
function fieldOf(
  el: XmlNode, path: readonly string[], group: string | undefined,
): XfaField | undefined {
  const partial = el.attrs.get('name');
  if (partial === undefined || partial === '') return undefined;

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
  const capEl = child(el, 'caption');
  const caption = capEl ? {
    ...(capEl.attrs.get('reserve') !== undefined
      ? { reserve: capEl.attrs.get('reserve') } : {}),
    ...(capEl.attrs.get('placement') !== undefined
      ? { placement: capEl.attrs.get('placement') } : {}),
    ...(capEl.attrs.get('presence') !== undefined
      ? { presence: capEl.attrs.get('presence') } : {}),
  } : undefined;
  // The field's OWN <margin>. `child` searches DIRECT children only, which is
  // what keeps the <ui><textEdit><margin> a real LiveCycle field also carries
  // out of it -- reading that one instead drops every inset in the form.
  const marEl = child(el, 'margin');
  const margin = marEl ? Object.fromEntries(
    (['leftInset', 'rightInset', 'topInset', 'bottomInset'] as const)
      .flatMap((k) => {
        const v = marEl.attrs.get(k);
        return v === undefined ? [] : [[k, v] as const];
      }),
  ) as XfaMargin : undefined;
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
    ui,
    ...(group !== undefined ? { group } : {}),
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
    ...(caption ? { caption } : {}),
    ...(margin ? { margin } : {}),
    ...(buttonSize !== undefined ? { buttonSize } : {}),
    ...(para && Object.keys(para).length > 0 ? { para } : {}),
    geom: {},
    layouts: [],
    offsets: [],
  };
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

/** A container's own x/y for the offset chain. */
function offsetOf(el: XmlNode): XfaOffset {
  const o: XfaOffset = {};
  const x = el.attrs.get('x');
  const y = el.attrs.get('y');
  if (x !== undefined) o.x = x;
  if (y !== undefined) o.y = y;
  return o;
}

/** A container's effective layout.
 *
 *  `position` is XFA's default and the one this feature can place from. A
 *  repeating `<occur>` contributes the synthetic `'occur'` instead: the
 *  occurrence COUNT is knowable from `initial`, but the repeat DIRECTION is
 *  not, so such a subform is flow-laid and every field under it degrades. */
function layoutOf(el: XmlNode): string {
  const occur = el.children.find((c) => c.name === 'occur');
  if (occur) {
    const max = occur.attrs.get('max');
    if (max !== undefined && max !== '1') return 'occur';
  }
  return el.attrs.get('layout') ?? 'position';
}

/** The `<contentArea>` a `<pageArea>` declares, as one more level of origin. */
function contentAreaOffset(pageArea: XmlNode | undefined): XfaOffset | undefined {
  const ca = pageArea?.children.find((c) => c.name === 'contentArea');
  return ca ? offsetOf(ca) : undefined;
}

/** What a container contributes to the fields beneath it. */
interface ChainCtx {
  /** Layouts between the page origin and here, outermost first. */
  layouts: string[];
  /** Those containers' own x/y, same order. */
  offsets: XfaOffset[];
  /** 0-based `<pageArea>` index in force, or `undefined` when unresolvable. */
  pageIndex?: number;
  /** True once the walk has passed BELOW the subform carrying the `<pageSet>`.
   *  Above it there is no page origin, so nothing is accumulated. */
  inPage: boolean;
}

/**
 * Walk `<subform>` / `<exclGroup>` / `<field>` and yield one entry per terminal
 * field, with its geometry, its ancestor layout chain and its page.
 *
 * An ANONYMOUS container is transparent to the SOM path, as SOM defines it --
 * give it a level and no name matches the AcroForm half of a hybrid document.
 *
 * **Where the chain BEGINS, and it is the interpretation this module adds:**
 * the chain is the containers between the field and its PAGE ORIGIN, exclusive
 * of the subform that carries the `<pageSet>`. LiveCycle's root `<subform>` --
 * the one carrying the `<pageSet>` -- is routinely `layout="tb"`, because that
 * flow is what breaks PAGES rather than what places FIELDS. Read as starting at
 * the document root, "every ancestor must be position" degrades every field of
 * every LiveCycle form and this feature converts nothing.
 */
function walk(
  el: XmlNode, path: readonly string[], group: string | undefined,
  ctx: ChainCtx, pages: readonly XmlNode[], out: XfaField[],
): void {
  // Occurrence indices are per NAME among siblings, so the counter is scoped to
  // this element's own children.
  const counts = new Map<string, number>();
  const indexed = (n: string): string => {
    const i = counts.get(n) ?? 0;
    counts.set(n, i + 1);
    return `${n}[${String(i)}]`;
  };
  // A subform carrying a <pageSet> IS the page container: everything below it
  // sits on a page, and its own layout breaks pages rather than placing fields.
  const carriesPageSet = el.children.some((c) => c.name === 'pageSet');
  // Page index advances across the page container's own subform children.
  let nextPage = 0;

  for (const c of el.children) {
    const partial = c.attrs.get('name');
    if (c.name === 'field') {
      const sub = partial === undefined || partial === ''
        ? path : [...path, indexed(partial)];
      const f = fieldOf(c, sub, group);
      if (f) {
        f.geom = geomOf(c);
        f.layouts = [...ctx.layouts];
        f.offsets = [...ctx.offsets];
        if (ctx.pageIndex !== undefined) f.pageIndex = ctx.pageIndex;
        out.push(f);
      }
      continue;
    }
    if (c.name !== 'subform' && c.name !== 'exclGroup' && c.name !== 'area') continue;
    const sub = partial === undefined || partial === ''
      ? path : [...path, indexed(partial)];

    let next: ChainCtx;
    if (carriesPageSet) {
      // Entering a page. Its index is its ordinal among these siblings unless a
      // <breakBefore target> names a pageArea; a target naming NO pageArea
      // leaves it UNRESOLVED rather than guessing, because a field placed
      // perfectly on the wrong sheet looks right and is wrong.
      const brk = c.children.find((b) => b.name === 'breakBefore' || b.name === 'break');
      const target = brk?.attrs.get('target');
      let idx: number | undefined;
      if (target !== undefined && target !== '') {
        const t = target.replace(/^#/, '');
        const found = pages.findIndex((p) => p.attrs.get('name') === t);
        idx = found < 0 ? undefined : found;
        if (found >= 0) nextPage = found + 1;
      } else {
        idx = nextPage < pages.length ? nextPage : undefined;
        nextPage += 1;
      }
      const ca = idx === undefined ? undefined : contentAreaOffset(pages[idx]);
      next = {
        layouts: [...(ca ? ['position'] : []), layoutOf(c)],
        offsets: [...(ca ? [ca] : []), offsetOf(c)],
        ...(idx !== undefined ? { pageIndex: idx } : {}),
        inPage: true,
      };
    } else if (!ctx.inPage) {
      // Still above any page origin: accumulate nothing.
      next = { layouts: [], offsets: [], inPage: false };
    } else {
      next = {
        layouts: [...ctx.layouts, layoutOf(c)],
        offsets: [...ctx.offsets, offsetOf(c)],
        ...(ctx.pageIndex !== undefined ? { pageIndex: ctx.pageIndex } : {}),
        inPage: true,
      };
    }
    walk(c, sub, c.name === 'exclGroup' ? somName(sub) : group, next, pages, out);
  }
}

/** Every `<pageArea>` element in document order, wherever the `<pageSet>` sits.
 *  Page identity is this order mapped onto the document's page index.
 *
 *  ONE traversal: the models below are derived from these elements rather than
 *  found by a second walk, which is how a model and an index come to disagree
 *  about how many pages there are. */
function pageAreaElements(root: XmlNode, out: XmlNode[]): void {
  for (const c of root.children) {
    if (c.name === 'pageArea') { out.push(c); continue; }
    pageAreaElements(c, out);
  }
}

/** One `<pageArea>` element to its model. */
function pageAreaOf(el: XmlNode): XfaPageArea {
  const m = child(el, 'medium');
  const name = el.attrs.get('name');
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
  return {
    ...(name !== undefined ? { name } : {}),
    ...(medium ? { medium } : {}),
  };
}

/** The `template` packet's root element to the field model. */
export function parseXfaTemplate(root: XmlNode): XfaTemplate {
  const pageEls: XmlNode[] = [];
  pageAreaElements(root, pageEls);
  const fields: XfaField[] = [];
  walk(root, [], undefined, { layouts: [], offsets: [], inPage: false }, pageEls, fields);
  return { fields, pages: pageEls.map(pageAreaOf) };
}
