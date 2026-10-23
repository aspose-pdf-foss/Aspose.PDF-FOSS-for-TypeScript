// The Adobe Reader paper-barcode probes (2srz.4), shared by the generator
// (scripts/gen-paper-barcode-probes.ts) and the oracle test, so the document
// Reader computed and the one we recompute cannot drift.
//
// Each probe is a form whose fields hold values in /V, plus a barcode field
// carrying every field. In 'oracle' mode the barcode's script is Acrobat's
// template WITHOUT its `ADBE.PMD_Need_Version` guard -- Reader has no ADBE, so
// the guarded script only ever yields " " there -- and an /OpenAction makes
// Reader calculate and write JSON.stringify of the barcode's value, and of
// each field's value and type, into a visible `dbg` field. In 'ours' mode the
// barcode is exactly what AddBarcodeField writes.
import { Document } from '../../src/document.js';
import { PageFormat } from '../../src/pageformat.js';
import { buildTabScript } from '../../src/pmd.js';

export type ProbeField =
  | { kind: 'text'; name: string; value: string; format?: string; password?: boolean; comb?: number }
  | { kind: 'checkbox'; name: string; checked: boolean; exportValue?: string }
  | { kind: 'radio'; name: string; options: string[]; selected?: string }
  | { kind: 'combo'; name: string; options: string[]; value: string }
  | { kind: 'list'; name: string; options: string[]; value: string | string[]; multi?: boolean }
  | { kind: 'button'; name: string };

export interface Probe {
  name: string;
  /** Created in this order. */
  fields: ProbeField[];
  fieldNames?: boolean;
  symbology?: 'pdf417' | 'datamatrix' | 'qr';
  /** Make the barcode field itself multiline (/Ff bit 13). */
  barcodeMultiline?: boolean;
}

export const PROBES: readonly Probe[] = [
  { name: 'order', fields: [
    { kind: 'text', name: 'zeta', value: 'z' }, { kind: 'text', name: 'alpha', value: 'a' },
    { kind: 'text', name: 'mid.b', value: 'mb' }, { kind: 'text', name: 'mid.a', value: 'ma' },
    { kind: 'text', name: 'Beta', value: 'B' }, { kind: 'text', name: 'a10', value: '10' },
    { kind: 'text', name: 'a9', value: '9' }, { kind: 'text', name: '_u', value: 'u' },
    { kind: 'text', name: 'été', value: 'e' }, { kind: 'text', name: 'midx', value: 'm' },
  ] },
  { name: 'numbers', fields: [
    { kind: 'text', name: 'n1', value: '007' }, { kind: 'text', name: 'n2', value: '1.50' },
    { kind: 'text', name: 'n3', value: '1e3' }, { kind: 'text', name: 'n4', value: '-0' },
    { kind: 'text', name: 'n5', value: ' 42 ' }, { kind: 'text', name: 'n6', value: '0x1F' },
    { kind: 'text', name: 'n7', value: '12345678901234567890' }, { kind: 'text', name: 'n8', value: '.5' },
  ] },
  { name: 'buttons', fields: [
    { kind: 'checkbox', name: 'cb1', checked: true }, { kind: 'checkbox', name: 'cb2', checked: false },
    { kind: 'checkbox', name: 'cb3', checked: true, exportValue: 'Si' },
    { kind: 'radio', name: 'r1', options: ['a', 'b'], selected: 'b' },
    { kind: 'radio', name: 'r2', options: ['x', 'y'] },
    { kind: 'button', name: 'pb' },
  ] },
  { name: 'choices', fields: [
    { kind: 'combo', name: 'c1', options: ['One', 'Two'], value: 'Two' },
    { kind: 'list', name: 'l1', options: ['A', 'B', 'C'], value: 'B' },
    { kind: 'list', name: 'l2', options: ['A', 'B', 'C'], value: ['A', 'C'], multi: true },
  ] },
  { name: 'empty', fields: [{ kind: 'text', name: 'e1', value: '' }, { kind: 'text', name: 'e2', value: '' }] },
  { name: 'header', fieldNames: true, fields: [{ kind: 'text', name: 'a', value: 'x' }, { kind: 'text', name: 'b', value: 'y' }] },
  { name: 'text', fields: [
    { kind: 'text', name: 't1', value: 'é' }, { kind: 'text', name: 't2', value: 'Ж' },
    { kind: 'text', name: 't3', value: 'a\tb' }, { kind: 'text', name: 't4', value: 'a\nb' },
  ] },
  { name: 'multiline', fieldNames: true, barcodeMultiline: true, fields: [
    { kind: 'text', name: 'm1', value: 'a\nb' }, { kind: 'text', name: 'm2', value: 'c\r\nd' },
    { kind: 'text', name: 'm3', value: 'e\rf' },
  ] },
  { name: 'linebreaks', fields: [
    { kind: 'text', name: 'm2', value: 'c\r\nd' }, { kind: 'text', name: 'm3', value: 'e\rf' },
  ] },
  { name: 'numbers2', fields: [
    { kind: 'text', name: 'k01', value: '+5' }, { kind: 'text', name: 'k02', value: '1.' },
    { kind: 'text', name: 'k03', value: '-.5' }, { kind: 'text', name: 'k04', value: '1,5' },
    { kind: 'text', name: 'k05', value: '00' }, { kind: 'text', name: 'k06', value: '-007' },
    { kind: 'text', name: 'k07', value: '1.2.3' }, { kind: 'text', name: 'k08', value: '-' },
    { kind: 'text', name: 'k09', value: '1 000' }, { kind: 'text', name: 'k10', value: 'Infinity' },
    { kind: 'text', name: 'k11', value: '0.1000' }, { kind: 'text', name: 'k12', value: '1e-7' },
    { kind: 'text', name: 'k13', value: '0.0000001' }, { kind: 'text', name: 'k14', value: '123456789012345678901234' },
    { kind: 'combo', name: 'k15', options: ['007', '8'], value: '007' },
    { kind: 'list', name: 'k16', options: ['007', '1.50', 'x'], value: ['007', '1.50'], multi: true },
  ] },
  { name: 'misc', fields: [
    { kind: 'list', name: 'j1', options: ['007', 'x'], value: '007' },
    { kind: 'checkbox', name: 'j2', checked: true, exportValue: '007' },
    { kind: 'radio', name: 'j3', options: ['007', '8'], selected: '007' },
    { kind: 'text', name: 'j4', value: 'secret', password: true },
    { kind: 'text', name: 'j5', value: '0042', comb: 4 },
  ] },
  { name: 'format', fields: [
    { kind: 'text', name: 'f1', value: '3', format: 'AFNumber_Format(2, 0, 0, 0, "", true);' },
  ] },
];

/** The barcode field's name in every probe. */
export const BARCODE = 'bc';

export function buildPaperBarcodeProbe(p: Probe, mode: 'oracle' | 'ours'): Document {
  const doc = Document.New();
  doc.AddPage(PageFormat.custom(612, 500));
  const f = doc.Form;
  let y = 470;
  const row = (): [number, number, number, number] => { const r: [number, number, number, number] = [10, y, 200, y + 18]; y -= 22; return r; };
  for (const d of p.fields) {
    if (d.kind === 'text') {
      f.AddTextField({ name: d.name, page: 1, rect: row(), value: d.value, multiline: d.value.includes('\n'),
        ...(d.password ? { password: true } : {}), ...(d.comb ? { comb: true, maxLen: d.comb } : {}),
        ...(d.format === undefined ? {} : { actions: { format: { type: 'javascript', script: d.format } } }) });
    } else if (d.kind === 'checkbox') {
      f.AddCheckbox({ name: d.name, page: 1, rect: row(), checked: d.checked, ...(d.exportValue ? { exportValue: d.exportValue } : {}) });
    } else if (d.kind === 'radio') {
      const r = row();
      f.AddRadioGroup({ name: d.name, ...(d.selected ? { selected: d.selected } : {}),
        options: d.options.map((e, i) => ({ page: 1, rect: [r[0] + 30 * i, r[1], r[0] + 30 * i + 18, r[3]] as [number, number, number, number], export: e })) });
    } else if (d.kind === 'combo') {
      f.AddComboBox({ name: d.name, page: 1, rect: row(), options: d.options, value: d.value });
    } else if (d.kind === 'list') {
      f.AddListBox({ name: d.name, page: 1, rect: row(), options: d.options, value: d.value, multiSelect: d.multi === true });
    } else {
      f.AddPushButton({ name: d.name, page: 1, rect: row(), caption: 'Go' });
    }
  }
  const bc = f.AddBarcodeField({
    name: BARCODE, page: 1, rect: [220, 300, 600, 490], readOnly: true,
    ...(p.symbology ? { symbology: p.symbology } : {}), ...(p.fieldNames ? { fieldNames: true } : {}),
  });
  if (p.barcodeMultiline) bc.Multiline = true;
  if (mode === 'ours') return doc;

  const names = p.fields.map((d) => d.name);
  const unguarded = buildTabScript({ fields: names, fieldNames: p.fieldNames ?? false }).split('\ntry\n')[0]
    + `\nevent.value = strTabDelimited({oDoc: this, aFields: ${JSON.stringify(names)}, bFieldNames: ${p.fieldNames ?? false}});`;
  bc.SetActions({ calculate: { type: 'javascript', script: unguarded } });
  f.AddTextField({ name: 'dbg', page: 1, rect: [10, 10, 602, 290], multiline: true, readOnly: true, fontSize: 9 });
  doc.SetOpenAction({
    type: 'javascript',
    script: 'this.calculateNow();'
      + ' var s = "BC=" + JSON.stringify(this.getField("bc").value) + "\\n";'
      + ' for (var i = 0; i < this.numFields; ++i) { var n = this.getNthFieldName(i); if (n == "dbg") continue;'
      + ' var v = this.getField(n).value; s += i + " " + n + " " + this.getField(n).type + " " + (typeof v) + " " + JSON.stringify(v) + "\\n"; }'
      + ' this.getField("dbg").value = s;',
  });
  return doc;
}
