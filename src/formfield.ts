import type { Document } from './document.js';
import {
  PdfDict, PdfObject, isArray, isDict, isName, isStream, isString, name,
} from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import { decodeStream } from './filters.js';
import { UnsupportedFeatureError } from './errors.js';
import { generateFieldAppearance, buildButtonAP, synthOnState } from './appearance.js';
import { regeneratePushButtonAP } from './buttonap.js';
import { flattenFieldWidgets } from './flatten.js';
import { resolveDA } from './da.js';
import { richTextToPlain } from './richtext.js';
import {
  applyWidgetStyle, checkColor, checkFieldStyle, ensureDRFont, fieldDA, pdfLatin,
  type FieldStyle,
} from './fieldstyle.js';
import {
  applyFieldActions, encodeAction, parseAction, parseFieldActions,
  type FieldActions, type FieldActionsUpdate, type PdfAction,
} from './actions.js';
import {
  normalizeOption, optArray, parseOptions, type ChoiceOption,
} from './choiceopt.js';
import {
  FF_RADIO, FF_PUSHBUTTON, FF_COMBO, FF_EDIT, FF_MULTISELECT,
  FF_READONLY, FF_REQUIRED, FF_MULTILINE, FF_PASSWORD, FF_COMB,
  FF_FILESELECT, FF_RICHTEXT, FF_DONOTSPELLCHECK, FF_DONOTSCROLL,
} from './fieldflags.js';

export type FieldType =
  'text' | 'checkbox' | 'radio' | 'choice' | 'pushbutton' | 'signature' | 'unknown';


export function classify(ft: string | undefined, ff: number): FieldType {
  switch (ft) {
    case 'Tx': return 'text';
    case 'Ch': return 'choice';
    case 'Sig': return 'signature';
    case 'Btn':
      if (ff & FF_PUSHBUTTON) return 'pushbutton';
      if (ff & FF_RADIO) return 'radio';
      return 'checkbox';
    default: return 'unknown';
  }
}

/** A PdfString carrying a PDF text string. */
function pdfString(s: string): PdfObject {
  return { kind: 'string', bytes: encodePdfText(s) };
}

/** Rich-text markup from either the string or the stream shape, VERBATIM.
 *
 *  `key` is `/RV` on a form field and `/RC` on a markup annotation; the two
 *  entries differ in where they live and agree in everything else, so the
 *  string-or-stream duality has one reader rather than two.
 *
 *  **Invariant:** this returns MARKUP, and its round-tripping callers depend on
 *  that — `formdata.ts` writes it into FDF/XFDF `<value-richtext>` and
 *  `xfdfannot.ts` into `contents-richtext`, both verbatim. Anything reading it
 *  AS TEXT goes through `richtext.ts`'s `richTextToPlain` instead; that is why
 *  the reduction is a sibling rather than a change of meaning here. */
export function readRichTextMarkup(
  doc: Document, dict: PdfDict, key: 'RV' | 'RC' = 'RV',
): string | undefined {
  const rv = doc.resolve(dict.get(key));
  if (isString(rv)) return decodePdfText(rv.bytes);
  if (isStream(rv)) return new TextDecoder('utf-8').decode(decodeStream(rv));
  return undefined;
}

/** @deprecated Use {@link readRichTextMarkup}, whose name says it returns
 *  markup. Kept as the import path `formdata.ts` and the tests already use. */
export const readRichTextValue = readRichTextMarkup;

/** First non-Off key of a widget's /AP /N dict — its "on" appearance state.
 *
 *  Exported for the same reason `readRichTextValue` is: `htmlforms.ts` reads it
 *  off a widget it holds directly, with no `Field` handle to go through.
 *
 *  **Invariant:** this is NOT `synthOnState`. That helper guesses an on-state
 *  for documents we did not author — `/AS`, then `/Opt[i]`, then `/V`, then
 *  `'Yes'` — and every one of its inputs reads `Off` for an unchecked box with
 *  a custom export value. This reads what the widget itself states. */
export function widgetOnState(doc: Document, widget: PdfDict): string | undefined {
  const ap = doc.resolve(widget.get('AP'));
  if (!isDict(ap)) return undefined;
  const n = doc.resolve(ap.get('N'));
  if (!isDict(n)) return undefined;
  for (const k of n.keys()) if (k !== 'Off') return k;
  return undefined;
}

/** A terminal AcroForm field: a live, mutable handle over its field dict. */
export class Field {
  constructor(
    protected readonly doc: Document,
    /** The live, resolved /AcroForm dict (target for /NeedAppearances). */
    protected readonly acroForm: PdfDict,
    /** The live terminal field dict from the objects map (not a copy). */
    readonly Dict: PdfDict,
    /** Partial name (/T); '' when missing. */
    readonly Name: string,
    /** Non-empty partial names of ancestors and self, joined with '.'. */
    readonly FullName: string,
    readonly Type: FieldType,
    /** Effective /Ff (own or inherited at walk time). Mutable: `setFlag` keeps
     *  it in step with the dict, because GenerateAppearance() reads it. */
    protected ff: number,
    /** Effective /V seen at walk time (used when the dict has no own /V). */
    private readonly initialV: PdfObject,
  ) {}

  /** The field's widget annotations: a merged field/widget dict is its own
   *  widget; otherwise the resolved dict entries of /Kids.
   *
   *  Public because `htmlforms.ts` needs each widget's own /Rect and /AP, and a
   *  second copy of this rule is how two readers come to disagree about one
   *  document — terminal-ness cannot be read off /Kids alone. */
  get Widgets(): PdfDict[] {
    const kids = this.doc.resolve(this.Dict.get('Kids'));
    if (!isArray(kids)) return [this.Dict];
    const out: PdfDict[] = [];
    for (const k of kids) {
      const d = this.doc.resolve(k);
      if (isDict(d)) out.push(d);
    }
    return out;
  }

  /** True when the widget's /AP /N has an appearance state named `state`. */
  protected hasState(widget: PdfDict, state: string): boolean {
    const ap = this.doc.resolve(widget.get('AP'));
    if (!isDict(ap)) return false;
    const n = this.doc.resolve(ap.get('N'));
    return isDict(n) && n.has(state);
  }

  /** First non-Off key of the widget's /AP /N dict, or undefined. */
  protected onState(widget: PdfDict): string | undefined {
    return widgetOnState(this.doc, widget);
  }

  /** Selectable values: choice → /Opt export values; checkbox/radio →
   *  widget on-states in widget order; other types → []. */
  get Options(): string[] {
    if (this.Type === 'choice')
      return parseOptions(this.doc, this.Dict).map((o) => o.export);
    if (this.Type === 'checkbox' || this.Type === 'radio') {
      const out: string[] = [];
      for (const w of this.Widgets) {
        const s = this.onState(w);
        if (s !== undefined && !out.includes(s)) out.push(s);
      }
      return out;
    }
    return [];
  }

  /** The effective /V: own value when present, else the value inherited at walk time. */
  protected rawValue(): PdfObject {
    if (this.Dict.has('V')) return this.doc.resolve(this.Dict.get('V'));
    return this.initialV;
  }

  /** Typed view of /V: text → string (''), checkbox → boolean,
   *  radio → on-state name (''), choice → string or string[] (multi-select). */
  get Value(): string | string[] | boolean {
    const v = this.rawValue();
    switch (this.Type) {
      case 'text':
        return isString(v) ? decodePdfText(v.bytes) : '';
      case 'checkbox':
        return isName(v) && v.name !== 'Off';
      case 'radio':
        return isName(v) ? v.name : '';
      case 'choice':
        if (isArray(v)) {
          const out: string[] = [];
          for (const e of v) {
            const r = this.doc.resolve(e);
            if (isString(r)) out.push(decodePdfText(r.bytes));
          }
          return out;
        }
        return isString(v) ? decodePdfText(v.bytes) : '';
      default:
        if (isString(v)) return decodePdfText(v.bytes);
        if (isName(v)) return v.name;
        return '';
    }
  }

  /** Set the field value. Validation happens before any mutation, so a throw
   *  leaves the document unmodified. */
  set Value(v: string | string[] | boolean) {
    switch (this.Type) {
      case 'text': this.setText(v); break;
      case 'checkbox': this.setCheckbox(v); break;
      case 'radio': this.setRadio(v); break;
      case 'choice': this.setChoice(v); break;
      default:
        throw new UnsupportedFeatureError(`cannot set the value of a ${this.Type} field`);
    }
    // In-place edits to live field/widget dicts: force a full rewrite on the next
    // sign so an incremental append cannot silently drop the new value.
    this.doc.markModified();
  }

  /** The field's /AA additional actions — keystroke, format, validate and
   *  calculate. Absent triggers are simply left out.
   *
   *  Not to be confused with `ButtonField.Action`, which is /A: what activating
   *  the widget does. A push button has both. */
  get Actions(): FieldActions {
    return parseFieldActions(this.doc, this.Dict);
  }

  /** Set or clear /AA triggers. An absent key is left as it is and `null`
   *  removes that trigger, the same shape `SetStyle` takes; every action is
   *  validated before the first write. */
  SetActions(actions: FieldActionsUpdate): void {
    applyFieldActions(this.doc, this.Dict, actions);
    this.doc.markModified();
  }

  /** Bake just this field into static page content: draw each of its widgets'
   *  appearances into their page's /Contents, drop those widgets from /Annots,
   *  and unwire the field from /AcroForm /Fields. Sibling fields stay
   *  interactive — this is the per-field counterpart to `Document.FlattenForm`,
   *  which does the whole form and deletes /AcroForm. Returns the number of
   *  widgets baked. The handle is dead afterwards: `doc.Form` rebuilds per
   *  access and will no longer list this field. */
  Flatten(): number {
    this.GenerateAppearance();   // a widget with no /AP has nothing to bake
    return flattenFieldWidgets(this.doc, this.Dict, this.Widgets);
  }

  /** Regenerate this field's appearance stream(s) from its current value, so the
   *  result renders without relying on a viewer honoring /NeedAppearances. */
  GenerateAppearance(): void {
    generateFieldAppearance(this.doc, this.acroForm, this.Dict, this.Type, this.ff, this.rawValue());
  }

  private regen(): void {
    this.GenerateAppearance();
  }

  /** Restyle this field: border, background and text. Absent keys are left as
   *  they are, so `SetStyle({ borderColor: [1, 0, 0] })` recolours the border
   *  and changes nothing else.
   *
   *  Validation runs before the first write, so a throw leaves the document
   *  unmodified — the same invariant field creation holds. */
  SetStyle(style: FieldStyle): void {
    const ws = checkFieldStyle(style);

    // The /DA is rewritten whole, so unspecified parts come from the current one.
    const cur = resolveDA(this.doc, this.Dict, this.acroForm);
    const std = style.font ?? cur.std;
    const size = style.fontSize ?? cur.size;
    const color = (checkColor('textColor', style.textColor) ?? cur.color) as
      [number, number, number];

    for (const w of this.Widgets) applyWidgetStyle(this.doc, w, ws);
    const key = ensureDRFont(this.doc, this.acroForm, std);
    this.Dict.set('DA', pdfLatin(fieldDA(key, size, color)));

    this.restyleAppearance();
    this.doc.markModified();
  }

  /** Rebuild every widget's appearance after a restyle.
   *
   *  Not GenerateAppearance() for the two button families. That function guards
   *  button regeneration behind an existing-/AP check, to preserve an author's
   *  artwork — but a restyle is precisely the request to replace it. And a push
   *  button is never value-driven at all: its face has to come back from its
   *  own dict. */
  private restyleAppearance(): void {
    const widgets = this.Widgets;
    if (this.Type === 'pushbutton') {
      for (const w of widgets) regeneratePushButtonAP(this.doc, w, this.acroForm);
      return;
    }
    if (this.Type === 'checkbox' || this.Type === 'radio') {
      const da = resolveDA(this.doc, this.Dict, this.acroForm);
      const v = this.rawValue();
      for (let i = 0; i < widgets.length; i++) {
        const on = this.onState(widgets[i])
          ?? synthOnState(this.doc, widgets[i], this.Dict, i, v);
        buildButtonAP(this.doc, widgets[i], on, this.Type, da);
      }
      return;
    }
    this.GenerateAppearance();
  }

  /** Set or clear one /Ff bit. Writes the dict *and* refreshes the cached
   *  effective flags, because GenerateAppearance() reads the cache — updating
   *  only the dict would store the new flag and draw the old one.
   *
   *  Always writes /Ff, even when the result is 0: an explicit `/Ff 0`
   *  overrides a value inherited from a parent field, whereas deleting the key
   *  would silently re-inherit it. */
  protected setFlag(bit: number, on: boolean): void {
    this.ff = on ? (this.ff | bit) : (this.ff & ~bit);
    this.Dict.set('Ff', this.ff);
    this.GenerateAppearance();
    this.doc.markModified();
  }

  /** /Ff ReadOnly (spec bit 1): the field cannot be edited in a viewer. */
  get ReadOnly(): boolean { return (this.ff & FF_READONLY) !== 0; }
  set ReadOnly(v: boolean) { this.setFlag(FF_READONLY, v); }

  /** /Ff Required (spec bit 2): the field must be filled before submit. */
  get Required(): boolean { return (this.ff & FF_REQUIRED) !== 0; }
  set Required(v: boolean) { this.setFlag(FF_REQUIRED, v); }

  private setText(v: string | string[] | boolean): void {
    if (typeof v !== 'string') throw new TypeError('text field value must be a string');
    this.Dict.set('V', { kind: 'string', bytes: encodePdfText(v) });
    this.regen();
  }

  private setCheckbox(v: string | string[] | boolean): void {
    if (typeof v !== 'boolean') throw new TypeError('checkbox value must be a boolean');
    const widgets = this.Widgets;
    if (!v) {
      this.Dict.set('V', name('Off'));
      for (const w of widgets) w.set('AS', name('Off'));
      this.regen();
      return;
    }
    const on = (widgets.length ? this.onState(widgets[0]) : undefined) ?? 'Yes';
    this.Dict.set('V', name(on));
    for (const w of widgets) w.set('AS', name(this.onState(w) ?? on));
    this.regen();
  }

  private setRadio(v: string | string[] | boolean): void {
    if (typeof v !== 'string') throw new TypeError('radio group value must be a string');
    const widgets = this.Widgets;
    if (v !== 'Off' && !widgets.some((w) => this.hasState(w, v)))
      throw new RangeError(`radio group has no option '${v}'`);
    this.Dict.set('V', name(v));
    for (const w of widgets) w.set('AS', name(this.hasState(w, v) ? v : 'Off'));
    this.regen();
  }

  private setChoice(v: string | string[] | boolean): void {
    let values: string[];
    let isMulti = false;
    if (typeof v === 'string') {
      values = [v];
    } else if (Array.isArray(v) && v.every((e) => typeof e === 'string')) {
      if (!(this.ff & FF_MULTISELECT))
        throw new TypeError('an array value requires a multi-select choice field');
      values = v;
      isMulti = true;
    } else {
      throw new TypeError('choice value must be a string or string[]');
    }
    const editable = (this.ff & FF_COMBO) !== 0 && (this.ff & FF_EDIT) !== 0;
    if (!editable && this.Dict.has('Opt')) {
      const opts = this.Options;
      for (const val of values)
        if (!opts.includes(val)) throw new RangeError(`choice field has no option '${val}'`);
    }
    const strs: PdfObject[] = values.map((s) => ({ kind: 'string', bytes: encodePdfText(s) }));
    this.Dict.set('V', isMulti ? strs : strs[0]);
    this.Dict.delete('I'); // selection indices would now be stale
    this.regen();
  }
}

// The subclasses narrow `Type` with `declare`, which re-types the inherited
// property without emitting a field initializer that would clobber it. That
// narrowing is what makes them structurally distinct — without it TypeScript
// would treat every empty subclass as interchangeable with `Field`.

/** A text field (`/FT /Tx`). */
export class TextField extends Field {
  declare readonly Type: 'text';

  /** @internal Test seam for `setFlag`, which is protected. */
  setFlagForTest(bit: number, on: boolean): void { this.setFlag(bit, on); }

  /** /Ff Multiline (spec bit 13): the value wraps across lines. */
  get Multiline(): boolean { return (this.ff & FF_MULTILINE) !== 0; }
  set Multiline(v: boolean) {
    if (v && (this.ff & FF_COMB)) throw new RangeError('a comb field cannot be multiline');
    this.setFlag(FF_MULTILINE, v);
  }

  /** /Ff Password (spec bit 14): the appearance shows bullets, not the value. */
  get Password(): boolean { return (this.ff & FF_PASSWORD) !== 0; }
  set Password(v: boolean) {
    if (v && (this.ff & FF_COMB)) throw new RangeError('a comb field cannot be a password field');
    this.setFlag(FF_PASSWORD, v);
  }

  /** /Ff Comb (spec bit 25): the value is laid out in `MaxLen` even cells.
   *  Requires MaxLen > 0, and is forbidden with Multiline, Password or
   *  FileSelect — table 228 states all three. */
  get Comb(): boolean { return (this.ff & FF_COMB) !== 0; }
  set Comb(v: boolean) {
    if (v) {
      if (this.MaxLen <= 0) throw new RangeError('a comb field requires MaxLen > 0');
      if (this.ff & FF_MULTILINE) throw new RangeError('a comb field cannot be multiline');
      if (this.ff & FF_PASSWORD) throw new RangeError('a comb field cannot be a password field');
      if (this.ff & FF_FILESELECT)
        throw new RangeError('a comb field cannot be a file-select field');
    }
    this.setFlag(FF_COMB, v);
  }

  /** /Ff FileSelect (spec bit 21): the value is the pathname of a file whose
   *  contents are submitted, rather than text in its own right. */
  get FileSelect(): boolean { return (this.ff & FF_FILESELECT) !== 0; }
  set FileSelect(v: boolean) {
    if (v && (this.ff & FF_COMB))
      throw new RangeError('a comb field cannot be a file-select field');
    this.setFlag(FF_FILESELECT, v);
  }

  /** /Ff RichText (spec bit 26): the value is a rich text string, carried in
   *  /RV alongside the plain-text /V. See `RichTextValue`. */
  get RichText(): boolean { return (this.ff & FF_RICHTEXT) !== 0; }
  set RichText(v: boolean) { this.setFlag(FF_RICHTEXT, v); }

  /** /Ff DoNotSpellCheck (spec bit 23): the viewer does not spell-check what is
   *  typed here. An editing hint only — nothing we generate reads it. */
  get DoNotSpellCheck(): boolean { return (this.ff & FF_DONOTSPELLCHECK) !== 0; }
  set DoNotSpellCheck(v: boolean) { this.setFlag(FF_DONOTSPELLCHECK, v); }

  /** /Ff DoNotScroll (spec bit 24): the field refuses text past what its box
   *  holds instead of scrolling. An editing hint only — the appearance we
   *  generate draws the value it is given either way. */
  get DoNotScroll(): boolean { return (this.ff & FF_DONOTSCROLL) !== 0; }
  set DoNotScroll(v: boolean) { this.setFlag(FF_DONOTSCROLL, v); }

  /** /RV, the rich text value: an XHTML-subset document per the specification's
   *  rich text conventions, or undefined when absent. /V still carries the
   *  plain-text equivalent, and that is what the generated appearance draws —
   *  nothing here renders markup.
   *
   *  Read from either shape: we write the string form, but a producer may use a
   *  stream and Acrobat does for anything sizeable. */
  get RichTextValue(): string | undefined {
    return readRichTextValue(this.doc, this.Dict);
  }

  /** /RV reduced to plain text: the markup stripped, with a line break between
   *  block elements. Undefined when /RV is absent or will not parse.
   *
   *  A SIBLING of {@link RichTextValue} rather than a change to it. That one
   *  returns markup and must keep doing so --  writes it into
   *  FDF/XFDF verbatim -- but a caller who reads it expecting text gets
   *  something where searching for  finds nothing and searching
   *  for  matches a tag name. This is the entry for reading it as text. */
  get RichTextPlain(): string | undefined {
    const markup = readRichTextMarkup(this.doc, this.Dict);
    return markup === undefined ? undefined : richTextToPlain(markup);
  }
  set RichTextValue(v: string | undefined) {
    if (v === undefined) { this.Dict.delete('RV'); this.doc.markModified(); return; }
    if (typeof v !== 'string') throw new TypeError('RichTextValue must be a string');
    // /RV is meaningful only with the flag set, so writing one without it
    // stores a payload every viewer ignores.
    if (!this.RichText)
      throw new RangeError('a rich text value requires the RichText flag');
    this.Dict.set('RV', pdfString(v));
    this.doc.markModified();
  }

  /** /MaxLen: the maximum character count, 0 when absent (unlimited). Writing
   *  0 removes the entry rather than storing a meaningless limit. */
  get MaxLen(): number {
    const v = this.doc.resolve(this.Dict.get('MaxLen'));
    return typeof v === 'number' && v > 0 ? v : 0;
  }
  set MaxLen(v: number) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
      throw new TypeError('MaxLen must be a non-negative integer');
    if (v === 0 && (this.ff & FF_COMB))
      throw new RangeError('a comb field requires MaxLen > 0');
    if (v === 0) this.Dict.delete('MaxLen'); else this.Dict.set('MaxLen', v);
    this.GenerateAppearance();
    this.doc.markModified();
  }
}

/** A checkbox (`/FT /Btn`, neither Pushbutton nor Radio). */
export class CheckboxField extends Field { declare readonly Type: 'checkbox'; }

/** A radio group (`/FT /Btn` with the Radio flag). */
export class RadioField extends Field { declare readonly Type: 'radio'; }

/** A combo box or list box (`/FT /Ch`). The two differ only by the Combo flag,
 *  which is why one class covers both — as the Form walk already does. */
export class ChoiceField extends Field {
  declare readonly Type: 'choice';

  /** /Ff Combo (spec bit 18): renders as a dropdown rather than a list.
   *  Read-only: turning a populated list box into a dropdown is a different
   *  field, not a property change. */
  get Combo(): boolean { return (this.ff & FF_COMBO) !== 0; }

  /** /Ff Edit (spec bit 19): the user may type a value not in /Opt. The
   *  specification makes this meaningful only on a combo box, so setting it on
   *  a list box is rejected rather than written and ignored. */
  get Editable(): boolean { return (this.ff & FF_EDIT) !== 0; }
  set Editable(v: boolean) {
    if (v && !(this.ff & FF_COMBO))
      throw new RangeError('Editable applies to a combo box, not a list box');
    this.setFlag(FF_EDIT, v);
  }

  /** /Ff MultiSelect (spec bit 22): more than one option may be selected.
   *  Meaningful only on a list box. */
  get MultiSelect(): boolean { return (this.ff & FF_MULTISELECT) !== 0; }
  set MultiSelect(v: boolean) {
    if (v && (this.ff & FF_COMBO))
      throw new RangeError('MultiSelect applies to a list box, not a combo box');
    this.setFlag(FF_MULTISELECT, v);
  }

  /** Append an option to /Opt. Rejects a duplicate export, as creation does —
   *  /V holds the export, so two options sharing one make the value ambiguous.
   *
   *  Appending cannot disturb /I: the new entry lands past every existing
   *  index. Removal is the direction that has to renumber. */
  AddOption(option: ChoiceOption): void {
    const add = normalizeOption(option, 'option');
    const options = parseOptions(this.doc, this.Dict);
    if (options.some((o) => o.export === add.export))
      throw new RangeError(`choice field already has option '${add.export}'`);
    this.Dict.set('Opt', optArray([...options, add]));
    this.GenerateAppearance();
    this.doc.markModified();
  }

  /** Remove the option exported as `exportValue`, keeping /V, /I and /TI
   *  consistent with the shortened list.
   *
   *  Matching is on the export half only. That is the identity /V carries, so
   *  accepting a display string would let a caller remove an option by a name
   *  no other API takes. */
  RemoveOption(exportValue: string): void {
    if (typeof exportValue !== 'string')
      throw new TypeError('exportValue must be a string');
    const options = parseOptions(this.doc, this.Dict);
    const at = options.findIndex((o) => o.export === exportValue);
    if (at < 0) throw new RangeError(`choice field has no option '${exportValue}'`);
    const kept = options.filter((_, i) => i !== at);
    this.Dict.set('Opt', optArray(kept));

    // A selection naming the option that just went away is stale. /V is touched
    // only when it actually held it — free text on an editable combo never
    // matched an option, and a field with no /V must not acquire an empty one.
    const before = this.selectedValues();
    const values = before.filter((v) => v !== exportValue);
    if (values.length !== before.length) {
      if (values.length === 0) this.Dict.delete('V');
      else if (this.MultiSelect) this.Dict.set('V', values.map((v) => pdfString(v)));
      else this.Dict.set('V', pdfString(values[0]));
    }

    // /I is *indices* into /Opt, so every entry after the removed one shifted.
    // Recomputing from the value renumbers and drops stale entries in one step.
    const idx = values
      .map((v) => kept.findIndex((o) => o.export === v))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    if (idx.length > 0) this.Dict.set('I', idx);
    else this.Dict.delete('I');

    // /TI is the first *visible* option. Past the end it scrolls the list clean
    // off its own box.
    const ti = this.doc.resolve(this.Dict.get('TI'));
    if (typeof ti === 'number' && ti >= kept.length) {
      if (kept.length === 0) this.Dict.delete('TI');
      else this.Dict.set('TI', kept.length - 1);
    }

    this.GenerateAppearance();
    this.doc.markModified();
  }

  /** /V as a list of export strings: one entry for a single value, one per
   *  element for a multi-select array, none when absent. */
  private selectedValues(): string[] {
    const v = this.Value;
    if (Array.isArray(v)) return v;
    return typeof v === 'string' && v !== '' ? [v] : [];
  }
}

/** A push button (`/FT /Btn` with the Pushbutton flag). It has no value — only
 *  an appearance and an activation action. */
export class ButtonField extends Field {
  declare readonly Type: 'pushbutton';

  /** The widget's /A activation action; undefined when absent or unmodelled. */
  get Action(): PdfAction | undefined {
    return parseAction(this.doc, this.Dict);
  }
  set Action(a: PdfAction | undefined) {
    if (a === undefined) this.Dict.delete('A');
    else this.Dict.set('A', encodeAction(this.doc, a));   // validates before writing
    this.doc.markModified();
  }
}

/** Build the handle matching `type`. Signature and unrecognised fields get the
 *  base class: neither is creatable, and `SignatureField` is already the name of
 *  an unrelated export in signature.ts. */
export function wrapField(
  doc: Document, acroForm: PdfDict, dict: PdfDict,
  partial: string, fullName: string, type: FieldType, ff: number, v: PdfObject,
): Field {
  switch (type) {
    case 'text': return new TextField(doc, acroForm, dict, partial, fullName, type, ff, v);
    case 'checkbox': return new CheckboxField(doc, acroForm, dict, partial, fullName, type, ff, v);
    case 'radio': return new RadioField(doc, acroForm, dict, partial, fullName, type, ff, v);
    case 'choice': return new ChoiceField(doc, acroForm, dict, partial, fullName, type, ff, v);
    case 'pushbutton': return new ButtonField(doc, acroForm, dict, partial, fullName, type, ff, v);
    default: return new Field(doc, acroForm, dict, partial, fullName, type, ff, v);
  }
}
