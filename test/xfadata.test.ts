import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseXfaDatasets, bindFieldValue, parseXfaDataGroups } from '../src/xfadata.js';
import type { XfaField } from '../src/xfatemplate.js';

const ds = (inner: string) => parseXfaDatasets(parseXml(
  new TextEncoder().encode(`<datasets><data>${inner}</data></datasets>`),
));

/** A minimal template field; only its data path and the bind keys matter to the
 *  join. The data path is the name unless a case says otherwise. */
const field = (name: string, extra: Partial<XfaField> = {}): XfaField => ({
  name, dataPath: name, ui: 'text', readOnly: false, required: false, multiLine: false,
  layouts: [], ...extra,
});

// fdq3: the SOM name counts an unnamed container (`#subform[0]`), the data has
// no element for it, so the join is on the DATA path.
describe('bindFieldValue: the data path, not the SOM name', () => {
  it('binds through an unnamed container the SOM name counts', () => {
    const v = ds(`<form1><st>UT</st></form1>`);
    expect(bindFieldValue(field('form1[0].#subform[0].st[0]', { dataPath: 'form1[0].st[0]' }), v))
      .toBe('UT');
  });
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

const groups = (inner: string) => parseXfaDataGroups(parseXml(
  new TextEncoder().encode(`<datasets><data>${inner}</data></datasets>`),
));

// 164g.2: a repeating subform is instantiated once per same-named data group,
// and OPM 1644's Header groups are EMPTY -- which parseXfaDatasets, a map of
// leaf values, cannot count.
describe('parseXfaDataGroups', () => {
  it('counts the children of each name at a data path, empty groups included', () => {
    const g = groups(`<form1><S><Header/><Header></Header><Header><x>1</x></Header><Row1/></S></form1>`);
    expect(g.empty).toBe(false);
    expect(g.count('form1[0].S[0]', 'Header')).toBe(3);
    expect(g.count('form1[0].S[0]', 'Row1')).toBe(1);
    expect(g.count('form1[0].S[0]', 'Nope')).toBe(0);
    expect(g.count('', 'form1')).toBe(1);
  });

  it('keys paths exactly as parseXfaDatasets does, per name among siblings', () => {
    const inner = `<form1><R><a>one</a></R><Q/><R><a>two</a></R></form1>`;
    const g = groups(inner);
    expect(g.count('form1[0].R[1]', 'a')).toBe(1);
    expect(ds(inner).get('form1[0].R[1].a[0]')).toBe('two');
  });

  it('answers 0 under a path that names no data node', () => {
    expect(groups('<form1/>').count('form1[0].S[4]', 'Header')).toBe(0);
  });

  it('is an EMPTY merge with no data element, with an empty one, or with no packet', () => {
    expect(parseXfaDataGroups(parseXml(new TextEncoder().encode('<datasets/>'))).empty).toBe(true);
    expect(groups('').empty).toBe(true);
    expect(parseXfaDataGroups(undefined).empty).toBe(true);
    expect(parseXfaDataGroups(undefined).count('', 'form1')).toBe(0);
  });
});
