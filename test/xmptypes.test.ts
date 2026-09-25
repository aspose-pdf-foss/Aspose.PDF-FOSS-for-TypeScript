import { describe, it, expect } from 'vitest';
import { XmpTypeRegistry, isXmpDate } from '../src/xmptypes.js';
import { VALUE_TYPES_2004, VALUE_TYPES_2005 } from '../src/xmpschemadata.js';
import type { RdfValue } from '../src/xmprdf.js';

const S = (value: string): RdfValue => ({ kind: 'simple', value });
const A = (form: 'Bag' | 'Seq' | 'Alt', ...items: (RdfValue | [RdfValue, string])[]): RdfValue =>
  ({ kind: 'array', form, items: items.map((i) => (Array.isArray(i) ? { value: i[0], lang: i[1] } : { value: i })) });
const DIM = 'http://ns.adobe.com/xap/1.0/sType/Dimensions#';
const St = (ns: string, f: Record<string, RdfValue>): RdfValue =>
  ({ kind: 'struct', fields: Object.entries(f).map(([name, value]) => ({ ns, name, value })) });
const r04 = XmpTypeRegistry.forEra('2004');
const r05 = XmpTypeRegistry.forEra('2005');

describe('isXmpDate — XMPCore ISO8601Converter.parse', () => {
  it.each(['', '2024', '-0044', '2024-06', '2024-06-03', '2024-06-03T12', '2024-06-03T12:30', '2024-06-03T12Z',
    '2024-06-03T12:30:45Z', '2024-06-03T12:30:45.123+02:00', '2024-13-40T99:99', '2024-06-03T12:30+0200'])('accepts %j', (s) =>
    expect(isXmpDate(s)).toBe(true));
  it.each(['yesterday', '2024/06/03', '2024-06-03 12:30', '2024-06-03X', '2024-06-03T', '2024-06-03T12:30:45Zjunk',
    '2024-06-03T12:30:45+02-00', '2024-06-03T12:30:45.', '2024-06-03T12.5', 'T12', '2024-'])('refuses %j', (s) =>
    expect(isXmpDate(s)).toBe(false));
});

describe('XmpTypeRegistry', () => {
  it('knows exactly its era\'s types', () => {
    expect(r04.knownTypes().sort()).toEqual([...VALUE_TYPES_2004].sort());
    expect(r05.knownTypes().sort()).toEqual([...VALUE_TYPES_2005].sort());
    expect(r05.isKnownType('Seq ProperName')).toBe(true);
    expect(r05.isKnownType('closed Choice of Integer')).toBe(true);
    expect(r05.isKnownType('Nonsense')).toBe(false);
  });

  it('matches simple patterns against the WHOLE value', () => {
    expect(r05.validate(S('+12'), 'Integer')).toBe(true);
    expect(r05.validate(S('1.5'), 'Integer')).toBe(false);
    for (const v of ['1.', '.5', '-3.25', '7']) expect(r05.validate(S(v), 'Real'), v).toBe(true);
    for (const v of ['abc', '', '1.2.3']) expect(r05.validate(S(v), 'Real'), v).toBe(false);
    expect(r05.validate(S('True'), 'Boolean')).toBe(true);
    expect(r05.validate(S('true'), 'Boolean')).toBe(false);
    expect(r05.validate(S('application/pdf'), 'MIMEType')).toBe(true);
    expect(r05.validate(S('pdf'), 'MIMEType')).toBe(false);
    expect(r05.validate(S('a\nb'), 'Text')).toBe(true);           // (?s)
    expect(r05.validate(A('Bag', S('x')), 'Text')).toBe(false);    // simple only
  });

  it('checks GPSCoordinate by era', () => {
    expect(r04.validate(S('52,31.47N'), 'GPSCoordinate')).toBe(true);
    expect(r04.validate(S('152,31.4789N'), 'GPSCoordinate')).toBe(false);
    expect(r05.validate(S('152,31.4789N'), 'GPSCoordinate')).toBe(true);
  });

  it('checks dates, URIs, URLs and XPath', () => {
    expect(r05.validate(S('2024-06-03'), 'Date')).toBe(true);
    expect(r05.validate(S('soon'), 'Date')).toBe(false);
    expect(r05.validate({ kind: 'simple', value: 'x', uri: true }, 'URI')).toBe(true);
    expect(r05.validate(S('not a url'), 'URL')).toBe(true);
    expect(r05.validate(S('//['), 'XPath')).toBe(true);            // divergence: simple only
    expect(r05.validate(A('Seq'), 'URI')).toBe(false);
  });

  it('checks array forms and item types', () => {
    expect(r05.validate(A('Seq', S('a'), S('b')), 'Seq ProperName')).toBe(true);
    expect(r05.validate(A('Bag', S('a')), 'Seq ProperName')).toBe(false);
    expect(r05.validate(A('Alt', S('a')), 'Seq Text')).toBe(false);
    expect(r05.validate(A('Bag', S('1'), S('x')), 'Bag Integer')).toBe(false);
    expect(r05.validate(A('Bag', S('a')), 'bag')).toBe(true);      // bare array = of Text
    expect(r05.validate(A('Seq', A('Bag', S('1'))), 'Seq Bag Integer')).toBe(true);
  });

  it('checks Lang Alt: some item with a language, or empty', () => {
    expect(r05.validate(A('Alt', [S('T'), 'x-default']), 'Lang Alt')).toBe(true);
    expect(r05.validate(A('Alt'), 'Lang Alt')).toBe(true);
    expect(r05.validate(A('Alt', S('T')), 'Lang Alt')).toBe(false);
    expect(r05.validate(S('T'), 'Lang Alt')).toBe(false);
    expect(r05.validate(A('Seq', [S('T'), 'en']), 'Lang Alt')).toBe(false);
  });

  it('checks structs: declared fields, in the type namespace, each valid', () => {
    expect(r05.validate(St(DIM, { w: S('10'), h: S('2.5'), unit: S('mm') }), 'Dimensions')).toBe(true);
    expect(r05.validate(St(DIM, { w: S('wide') }), 'Dimensions')).toBe(false);
    expect(r05.validate(St(DIM, { depth: S('1') }), 'Dimensions')).toBe(false);
    expect(r05.validate(St('http://other/', { w: S('1') }), 'Dimensions')).toBe(false);
    expect(r05.validate(S('10x2'), 'Dimensions')).toBe(false);
  });

  it('treats any as always valid and an unknown type as invalid', () => {
    expect(r05.validate(A('Bag'), 'any')).toBe(true);
    expect(r05.validate(S('x'), 'Nonsense')).toBe(false);
  });

  it('extends with a schema\'s own value types, without touching the base', () => {
    const T = 'http://www.aiim.org/pdfa/ns/type#';
    const F = 'http://www.aiim.org/pdfa/ns/field#';
    const vt = (type: string, ns?: string, fields: [string, string][] = []): RdfValue => St(T, {
      type: S(type),
      ...(ns !== undefined ? { namespaceURI: S(ns) } : {}),
      ...(fields.length ? { field: A('Seq', ...fields.map(([n, t]) => St(F, { name: S(n), valueType: S(t) }))) } : {}),
    });
    const ext = r05.extend(A('Seq', vt('Point', 'http://acme/pt#', [['x', 'Integer'], ['y', 'Integer']]), vt('Code')));
    const PT = 'http://acme/pt#';
    expect(ext.validate(St(PT, { x: S('1'), y: S('2') }), 'Point')).toBe(true);
    expect(ext.validate(St(PT, { x: S('a') }), 'Point')).toBe(false);
    expect(ext.validate(S('anything'), 'Code')).toBe(true);        // no fields: Text
    expect(r05.isKnownType('Point')).toBe(false);
    expect(r05.extend(A('Seq', vt('NoNs', undefined, [['a', 'Text']]))).isKnownType('NoNs')).toBe(false);
  });
});
