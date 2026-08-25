import type { Document } from './document.js';
import type { Page } from './page.js';
import type { Form } from './form.js';
import { TextField, widgetOnState, type Field } from './formfield.js';
import { isArray, isDict, isName, isString, type PdfDict } from './types.js';
import { resolveDA } from './da.js';
import { parseOptions, displayOf } from './choiceopt.js';
import { escapeHtml } from './html.js';
import { parseAction } from './actions.js';
import { decodePdfText, parsePdfDate } from './metadata.js';

/** AcroForm fields as real HTML controls, for `ToHtml({ mode: 'fixed',
 *  forms: true })`.
 *
 *  **Invariant:** this module is PURE — no renderer, no sink, no content stream
 *  and no ink. It reads the document's object graph and returns markup, the
 *  split `svgdraw.ts`/`svgembed.ts` and `runlink.ts`/`stamp.ts` already make,
 *  and the reason every rule here is testable without rendering anything. */

/** What one page's fields became.
 *
 *  `converted` is the double-draw defence: every widget in it must be hidden
 *  from the page render, or its painted appearance shows through behind the
 *  control and the field's value arrives twice. */
export interface PageFormControls {
  html: string;
  converted: Set<PdfDict>;
  /** True when a submit or reset button was converted — the caller needs it to
   *  decide whether to emit the document's `<form>` envelope. */
  submits: boolean;
}

/** A widget's /Rect as [x0, y0, x1, y1], normalized; undefined when absent. */
function rectOf(doc: Document, w: PdfDict): [number, number, number, number] | undefined {
  const r = doc.resolve(w.get('Rect'));
  if (!isArray(r) || r.length < 4) return undefined;
  const v = r.map((e) => { const n = doc.resolve(e); return typeof n === 'number' ? n : NaN; });
  if (v.some((n) => !Number.isFinite(n))) return undefined;
  return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
}

/** A /MK colour array as a CSS colour; undefined when absent or unusable.
 *  1 component is gray, 3 RGB, 4 CMYK (32000-1 12.5.6.19). */
function mkColor(doc: Document, mk: PdfDict | undefined, key: string): string | undefined {
  if (!mk) return undefined;
  const a = doc.resolve(mk.get(key));
  if (!isArray(a) || a.length === 0) return undefined;
  const v = a.map((e) => { const n = doc.resolve(e); return typeof n === 'number' ? n : 0; });
  const to255 = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255);
  let rgb: [number, number, number];
  if (v.length === 1) rgb = [to255(v[0]), to255(v[0]), to255(v[0])];
  else if (v.length === 3) rgb = [to255(v[0]), to255(v[1]), to255(v[2])];
  else if (v.length === 4) rgb = [
    to255((1 - v[0]) * (1 - v[3])), to255((1 - v[1]) * (1 - v[3])), to255((1 - v[2]) * (1 - v[3])),
  ];
  else return undefined;
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

/** Trim a number for CSS, as svgrender's `fmt` does for markup. */
function fmtPt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** The inline style for one widget: position from /Rect, chrome from /MK+/BS,
 *  type from /DA.
 *
 *  Coordinates are relative to the CROP BOX's own origin, not to (0,0): fixed
 *  mode sizes its page div from that box, so a crop box whose y0 is not zero
 *  would otherwise push every control off the page.
 *
 *  **Invariant:** a /DA size of 0 means AUTO-SIZE and must never become
 *  `font-size:0`, which renders an invisible value. The widget's own height is
 *  what the PDF's appearance generator fits the value to. */
function styleFor(
  doc: Document, field: Field, w: PdfDict, acro: PdfDict | undefined, crop: number[],
): string | undefined {
  const r = rectOf(doc, w);
  if (!r) return undefined;
  const [x0, y0, x1, y1] = r;
  const width = x1 - x0, height = y1 - y0;
  if (!(width > 0) || !(height > 0)) return undefined;
  const cropX0 = Math.min(crop[0], crop[2]), cropY1 = Math.max(crop[1], crop[3]);
  // CSS y runs down from the page top; PDF y runs up from the bottom.
  const parts = [
    `left:${fmtPt(x0 - cropX0)}pt`, `top:${fmtPt(cropY1 - y1)}pt`,
    `width:${fmtPt(width)}pt`, `height:${fmtPt(height)}pt`,
  ];

  const mkRaw = doc.resolve(w.get('MK'));
  const mk = isDict(mkRaw) ? mkRaw : undefined;
  const border = mkColor(doc, mk, 'BC');
  const bg = mkColor(doc, mk, 'BG');
  if (border) {
    const bs = doc.resolve(w.get('BS'));
    const bw = isDict(bs) ? doc.resolve(bs.get('W')) : undefined;
    parts.push(`border:${typeof bw === 'number' ? fmtPt(bw) : 1}pt solid ${border}`);
  } else parts.push('border:none');
  if (bg) parts.push(`background:${bg}`);

  if (acro) {
    const da = resolveDA(doc, field.Dict, acro);
    const size = da.size > 0 ? da.size : Math.max(4, height * 0.66);
    parts.push(`font-size:${fmtPt(size)}pt`);
    parts.push(`color:rgb(${da.color.map((c) => Math.round(c * 255)).join(',')})`);
  }
  return parts.join(';');
}

/** True when this widget is currently on: its /AS, else the field's /V. */
function isOn(doc: Document, w: PdfDict, state: string, value: unknown): boolean {
  const as = doc.resolve(w.get('AS'));
  if (isName(as)) return as.name === state;
  if (typeof value === 'string') return value === state;
  return value === true;
}

const ATTR = (name: string, v: string | undefined) =>
  v === undefined ? '' : ` ${name}="${escapeHtml(v)}"`;

/** True when `w` is in `page`'s /Annots. A field's widgets may sit on several
 *  pages, so this is per widget rather than per field. */
function onThisPage(doc: Document, page: Page, w: PdfDict): boolean {
  const annots = doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return false;
  for (const e of annots) if (doc.resolve(e) === w) return true;
  return false;
}

/** One widget's control, or undefined when this field type does not convert. */
function controlFor(
  doc: Document, field: Field, w: PdfDict, acro: PdfDict | undefined,
  crop: number[], nextTabIndex: () => number,
): { html: string; submits: boolean } | undefined {
  const style = styleFor(doc, field, w, acro, crop);
  if (style === undefined) return undefined;      // no usable /Rect: nowhere to put it
  const tab = ` tabindex="${nextTabIndex()}"`;
  const name = ATTR('name', field.FullName);
  const ro = field.ReadOnly ? ' readonly' : '';
  const req = field.Required ? ' required' : '';
  const s = ` style="${style}"`;

  if (field.Type === 'text') {
    const tf = field as TextField;
    const v = typeof field.Value === 'string' ? field.Value : '';
    if (tf.Multiline)
      return {
        html: `<textarea${name}${s}${tab}${ro}${req}>${escapeHtml(v)}</textarea>`,
        submits: false,
      };
    const type = tf.Password ? 'password' : 'text';
    const max = tf.MaxLen > 0 ? ` maxlength="${tf.MaxLen}"` : '';
    return {
      html: `<input type="${type}"${name}${ATTR('value', v)}${max}${s}${tab}${ro}${req}>`,
      submits: false,
    };
  }

  if (field.Type === 'checkbox' || field.Type === 'radio') {
    const state = widgetOnState(doc, w);
    if (state === undefined) return undefined;
    const type = field.Type === 'checkbox' ? 'checkbox' : 'radio';
    const on = isOn(doc, w, state, field.Value) ? ' checked' : '';
    const dis = field.ReadOnly ? ' disabled' : '';
    return {
      html: `<input type="${type}"${name}${ATTR('value', state)}${on}${s}${tab}${dis}${req}>`,
      submits: false,
    };
  }

  if (field.Type === 'choice') {
    // **Invariant:** through parseOptions + displayOf, never inline. An /Opt
    // entry may be a plain string or an [export, display] pair, and /V holds
    // the EXPORT — every consumer that kept only one half got it wrong.
    const opts = parseOptions(doc, field.Dict);
    const v = field.Value;
    const chosen = new Set(Array.isArray(v) ? v : typeof v === 'string' ? [v] : []);
    const options = opts.map((o) =>
      `<option value="${escapeHtml(o.export)}"${chosen.has(o.export) ? ' selected' : ''}>`
      + `${escapeHtml(displayOf(o))}</option>`).join('');
    const dis = field.ReadOnly ? ' disabled' : '';
    return { html: `<select${name}${s}${tab}${dis}${req}>${options}</select>`, submits: false };
  }

  if (field.Type === 'pushbutton') {
    // Only submit and reset mean anything in HTML. Any other push button — a
    // JavaScript action, or none — would become a control that does nothing, so
    // it keeps its appearance and is deliberately NOT claimed.
    const a = parseAction(doc, w);
    if (!a || (a.type !== 'submit' && a.type !== 'reset')) return undefined;
    const caption = captionOf(doc, w) ?? (a.type === 'submit' ? 'Submit' : 'Reset');
    return {
      html: `<button type="${a.type}"${name}${s}${tab}>${escapeHtml(caption)}</button>`,
      submits: true,
    };
  }

  if (field.Type === 'signature') {
    // Converted, unlike Go, which leaves it painted — but DISABLED, because a
    // signature cannot be produced in a browser. It carries what the document
    // CLAIMS (/V /Name and /V /M), never a verification result: running
    // sigverify here would make an HTML export depend on trust stores and
    // network-fetched revocation data.
    const sig = doc.resolve(field.Dict.get('V'));
    let label = `Unsigned signature field: ${field.FullName}`;
    let value: string | undefined;
    if (isDict(sig)) {
      const who = doc.resolve(sig.get('Name'));
      const when = doc.resolve(sig.get('M'));
      const parts: string[] = [];
      if (isString(who)) parts.push(decodePdfText(who.bytes));
      if (isString(when)) {
        // parsePdfDate returns the raw string when it cannot parse, so a
        // malformed date degrades to showing itself rather than throwing.
        const d = parsePdfDate(decodePdfText(when.bytes));
        parts.push(d instanceof Date ? d.toISOString().slice(0, 10) : d);
      }
      if (parts.length) value = parts.join(', ');
      label = `Signature field: ${field.FullName}`;
    }
    return {
      html: `<input type="text" disabled${name}${ATTR('value', value)}`
        + `${ATTR('aria-label', label)}${s}${tab}>`,
      submits: false,
    };
  }

  return undefined;
}

/** A push button's caption: /MK /CA. */
function captionOf(doc: Document, w: PdfDict): string | undefined {
  const mk = doc.resolve(w.get('MK'));
  if (!isDict(mk)) return undefined;
  const ca = doc.resolve(mk.get('CA'));
  return isString(ca) ? decodePdfText(ca.bytes) : undefined;
}

/** The document `<form>`'s action and method, from the first SubmitForm action
 *  found on any push button.
 *
 *  One form for the whole document, not one per page: an AcroForm is
 *  document-scoped and a field's widgets may sit on different pages, so
 *  per-page forms would each submit a fragment of the field set. */
export function formEnvelope(
  doc: Document, form: Form,
): { action: string; method: string } | undefined {
  for (const field of form.Fields) {
    if (field.Type !== 'pushbutton') continue;
    for (const w of field.Widgets) {
      const a = parseAction(doc, w);
      if (a?.type === 'submit') return { action: a.url, method: 'post' };
    }
  }
  return undefined;
}

/** Every control for one page, plus the widgets they claim. */
export function pageFormControls(
  doc: Document, page: Page, form: Form, nextTabIndex: () => number,
): PageFormControls {
  const converted = new Set<PdfDict>();
  const out: string[] = [];
  let submits = false;
  const acro = form.Dict;
  const crop = page.CropBox;

  for (const field of form.Fields) {
    for (const w of field.Widgets) {
      if (!onThisPage(doc, page, w)) continue;
      try {
        const emitted = controlFor(doc, field, w, acro, crop, nextTabIndex);
        if (!emitted) continue;
        out.push(emitted.html);
        converted.add(w);
        if (emitted.submits) submits = true;
      } catch {
        // **Invariant:** a field that will not convert is NOT claimed, so its
        // /AP still renders. Never leave a hole where content used to be.
      }
    }
  }
  return { html: out.join(''), converted, submits };
}
