import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isString } from './types.js';
import { decodePdfText } from './metadata.js';
import { Field, classify, wrapField } from './formfield.js';
import type {
  TextField, CheckboxField, RadioField, ChoiceField, ButtonField,
} from './formfield.js';
import {
  addTextField, addCheckbox, addRadioGroup, addComboBox, addListBox, addPushButton,
  type TextFieldInit, type CheckboxInit, type RadioGroupInit,
  type ComboBoxInit, type ListBoxInit, type PushButtonInit,
} from './formcreate.js';
import { removeField } from './formremove.js';

// Re-exported so existing import sites (appearance.ts, formdata.ts, index.ts)
// and downstream consumers keep working after the split.
export { Field, wrapField } from './formfield.js';
export type { FieldType } from './formfield.js';
export {
  TextField, CheckboxField, RadioField, ChoiceField, ButtonField,
} from './formfield.js';

/** The document's interactive form: terminal fields of the /AcroForm tree. */
export class Form {
  private fields: Field[] = [];
  private readonly doc: Document;

  constructor(doc: Document) {
    this.doc = doc;
    this.build();
  }

  /** The terminal fields of the /AcroForm tree, in tree order. Rebuilt in place
   *  after each Add*, so a held Form instance stays canonical. */
  get Fields(): Field[] {
    return this.fields;
  }

  /** The live /AcroForm dict, or undefined when the document has no form.
   *
   *  Exposed for `htmlforms.ts`, which needs it as `resolveDA`'s fallback for a
   *  field carrying no /DA of its own. Re-resolving `/Root /AcroForm` there
   *  would be a second reader of one dict, and the two would eventually
   *  disagree about /DA inheritance. */
  get Dict(): PdfDict | undefined {
    const acro = this.doc.resolve(this.doc.catalog().get('AcroForm'));
    return isDict(acro) ? acro : undefined;
  }

  /** (Re)walk the /AcroForm tree into `this.fields`. */
  private build(): void {
    this.fields = [];
    const doc = this.doc;
    const acro = doc.resolve(doc.catalog().get('AcroForm'));
    if (!isDict(acro)) return;
    const fields = doc.resolve(acro.get('Fields'));
    if (!isArray(fields)) return;

    const seen = new Set<PdfDict>();
    const walk = (node: PdfObject, path: string, ft: string | undefined, ff: number, v: PdfObject): void => {
      const d = doc.resolve(node);
      if (!isDict(d) || seen.has(d)) return;
      seen.add(d);
      const t = doc.resolve(d.get('T'));
      const part = isString(t) ? decodePdfText(t.bytes) : '';
      const full = part === '' ? path : path === '' ? part : `${path}.${part}`;
      const ftRaw = doc.resolve(d.get('FT'));
      const ftHere = isName(ftRaw) ? ftRaw.name : ft;
      const ffRaw = doc.resolve(d.get('Ff'));
      const ffHere = typeof ffRaw === 'number' ? ffRaw : ff;
      const vHere = d.has('V') ? doc.resolve(d.get('V')) : v;

      // Kids with /T are child fields; kids without /T are widgets of this field.
      let hasFieldKids = false;
      const kids = doc.resolve(d.get('Kids'));
      if (isArray(kids)) {
        for (const k of kids) {
          const kd = doc.resolve(k);
          if (isDict(kd) && kd.has('T')) {
            hasFieldKids = true;
            walk(k, full, ftHere, ffHere, vHere);
          }
        }
      }
      if (!hasFieldKids)
        this.fields.push(wrapField(doc, acro, d, part, full, classify(ftHere, ffHere), ffHere, vHere));
    };
    for (const f of fields) walk(f, '', undefined, 0, null);
  }

  /** The field whose FullName matches exactly, or undefined. */
  Get(fullName: string): Field | undefined {
    return this.Fields.find((f) => f.FullName === fullName);
  }

  /** Create a single-line text field on `init.page` and return its handle.
   *  Creates /AcroForm, its /DR font resource and any intermediate field nodes
   *  named by a dotted `init.name` as needed. Throws without mutating the
   *  document on a malformed argument, an out-of-range page, a duplicate name,
   *  or a name routed through an existing terminal field. */
  AddTextField(init: TextFieldInit): TextField {
    const field = addTextField(this.doc, init);
    this.build();
    return field;
  }

  /** Create a checkbox on `init.page` and return its handle. The widget carries
   *  both /AP states from the start, keyed by `init.exportValue` (default
   *  'Yes'). Throws without mutating the document on a malformed argument, an
   *  out-of-range page, a duplicate name, or an export value of 'Off'. */
  AddCheckbox(init: CheckboxInit): CheckboxField {
    const field = addCheckbox(this.doc, init);
    this.build();
    return field;
  }

  /** Create a radio group whose kid widgets may sit on different pages, and
   *  return the parent field's handle. There is no Page.AddRadioGroup: a group
   *  is not bound to one page. Throws without mutating the document on an empty
   *  options array, an empty, duplicated or 'Off' export value, a `selected`
   *  matching no option, or an out-of-range page. */
  AddRadioGroup(init: RadioGroupInit): RadioField {
    const field = addRadioGroup(this.doc, init);
    this.build();
    return field;
  }

  /** Create a combo box (a dropdown) on `init.page` and return its handle.
   *  With `editable`, the user may type a value outside `init.options`. Throws
   *  without mutating the document on a malformed or duplicated option, a value
   *  matching no option on a non-editable field, or `multiSelect`. */
  AddComboBox(init: ComboBoxInit): ChoiceField {
    const field = addComboBox(this.doc, init);
    this.build();
    return field;
  }

  /** Create a list box on `init.page` and return its handle. With
   *  `multiSelect`, `init.value` may be a string[]. Throws without mutating the
   *  document on a malformed or duplicated option, a value matching no option,
   *  or `editable`. */
  AddListBox(init: ListBoxInit): ChoiceField {
    const field = addListBox(this.doc, init);
    this.build();
    return field;
  }

  /** Create a push button on `init.page` and return its handle. A push button
   *  has no value — give it a `caption`, an `icon`, or both, and an `action`.
   *  Throws without mutating the document on a malformed caption, an unknown
   *  `iconPosition`, an icon-bearing layout with no icon (or the reverse), or a
   *  malformed action. */
  AddPushButton(init: PushButtonInit): ButtonField {
    const field = addPushButton(this.doc, init);
    this.build();
    return field;
  }

  /** Remove a terminal field: unwire it from /AcroForm /Fields (or its parent's
   *  /Kids) and drop its widgets from every page's /Annots. Accepts a FullName
   *  or a Field handle.
   *
   *  Returns false, changing nothing, when the field is not in this document —
   *  an unknown name, or a handle whose field is already gone — so removal is
   *  idempotent. Page.RemoveAnnotation is a no-op off-page for the same reason:
   *  the Add* family throws to protect an allocation it has not made yet, and
   *  there is nothing here to protect. */
  RemoveField(field: Field | string): boolean {
    const target = typeof field === 'string' ? this.Get(field) : field;
    if (target === undefined) return false;
    if (!(target instanceof Field))
      throw new TypeError('RemoveField takes a Field or a full field name');
    if (!removeField(this.doc, target.Dict)) return false;
    this.build();
    return true;
  }

  /** Generate appearance streams for every field, then drop the AcroForm
   *  /NeedAppearances flag so the document renders identically everywhere. */
  GenerateAppearances(): void {
    for (const f of this.Fields) f.GenerateAppearance();
    const acro = this.doc.resolve(this.doc.catalog().get('AcroForm'));
    if (isDict(acro)) acro.delete('NeedAppearances');
    this.doc.markModified();
  }
}
