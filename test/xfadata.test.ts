import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseXfaDatasets, bindFieldValue } from '../src/xfadata.js';
import type { XfaField } from '../src/xfatemplate.js';

const ds = (inner: string) => parseXfaDatasets(parseXml(
  new TextEncoder().encode(`<datasets><data>${inner}</data></datasets>`),
));

/** A minimal template field; only `name` and the bind keys matter to the join. */
const field = (name: string, extra: Partial<XfaField> = {}): XfaField => ({
  name, ui: 'text', readOnly: false, required: false, multiLine: false,
  geom: {}, layouts: [], offsets: [], ...extra,
});

describe('parseXfaDatasets', () => {
  // The data path is SOM-shaped -- occurrence indices and all -- so the join is
  // a Map lookup on the field's own name rather than a second path grammar.
  it('keys leaf values by their SOM-shaped path', () => {
    const v = ds(`<form1><Page1><f1_01>Bob</f1_01></Page1></form1>`);
    expect(v.get('form1[0].Page1[0].f1_01[0]')).toBe('Bob');
  });

  it('indexes repeated elements from zero, per name', () => {
    const v = ds(`<form1><row><c>a</c></row><row><c>b</c></row></form1>`);
    expect(v.get('form1[0].row[0].c[0]')).toBe('a');
    expect(v.get('form1[0].row[1].c[0]')).toBe('b');
  });

  it('records an empty leaf as an empty string, not as absent', () => {
    const v = ds(`<form1><a/></form1>`);
    expect(v.has('form1[0].a[0]')).toBe(true);
    expect(v.get('form1[0].a[0]')).toBe('');
  });

  // A multi-select list box's value is an array. XFA writes it as repeated
  // <value> children of the leaf.
  it('reads repeated <value> children as an array', () => {
    const v = ds(`<form1><tags><value>a</value><value>b</value></tags></form1>`);
    expect(v.get('form1[0].tags[0]')).toEqual(['a', 'b']);
  });

  it('is empty for a datasets packet with no <data>', () => {
    const v = parseXfaDatasets(parseXml(new TextEncoder().encode('<datasets/>')));
    expect(v.size).toBe(0);
  });

  // XmlNode.text is the concatenation of a subtree's text, so recording a
  // container's own text invents a datum spanning every field beneath it.
  it('records a leaf whose parent also has element children only at the leaf', () => {
    const v = ds(`<form1><a>text<b>inner</b></a></form1>`);
    expect(v.get('form1[0].a[0].b[0]')).toBe('inner');
    expect(v.has('form1[0].a[0]')).toBe(false);
  });
});

describe('bindFieldValue', () => {
  const values = ds(`<form1><Page1><f1_01>Bob</f1_01><f1_02/></Page1>
    <alt>Other</alt></form1>`);

  it('binds by implicit name match on the SOM path', () => {
    expect(bindFieldValue(field('form1[0].Page1[0].f1_01[0]'), values)).toBe('Bob');
  });

  it('binds an empty datum, which is a value someone cleared', () => {
    expect(bindFieldValue(field('form1[0].Page1[0].f1_02[0]'), values)).toBe('');
  });

  it('binds nothing when no datum matches', () => {
    expect(bindFieldValue(field('form1[0].Page1[0].nope[0]'), values)).toBeUndefined();
  });

  it('follows an explicit bind ref, indices supplied where absent', () => {
    expect(bindFieldValue(
      field('form1[0].Page1[0].f1_01[0]', { bindRef: 'form1.alt' }), values,
    )).toBe('Other');
  });

  it('strips a $record. / $data. prefix from an explicit ref', () => {
    expect(bindFieldValue(
      field('form1[0].Page1[0].f1_01[0]', { bindRef: '$record.form1.alt' }), values,
    )).toBe('Other');
  });

  // match="none" says this field is deliberately unbound. Binding it anyway
  // puts the wrong person's answer in the box.
  it('binds nothing for match="none", even when a datum matches by name', () => {
    expect(bindFieldValue(
      field('form1[0].Page1[0].f1_01[0]', { bindMatch: 'none' }), values,
    )).toBeUndefined();
  });

  // The form stated where this field's data lives, and it is not there.
  it('does not fall back to the name match when an explicit ref resolves to nothing', () => {
    expect(bindFieldValue(
      field('form1[0].Page1[0].f1_01[0]', { bindRef: 'form1.missing' }), values,
    )).toBeUndefined();
  });
});
