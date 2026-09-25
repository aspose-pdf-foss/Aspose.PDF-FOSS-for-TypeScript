import { describe, it, expect } from 'vitest';
import { parseRdfPacket, serializeRdfPacket, RDF_NS, type RdfProperty } from '../src/xmprdf.js';
import { PdfParseError } from '../src/errors.js';

const enc = (s: string) => new TextEncoder().encode(s);
const DC = 'http://purl.org/dc/elements/1.1/';
const MM = 'http://ns.adobe.com/xap/1.0/mm/';
const EVT = 'http://ns.adobe.com/xap/1.0/sType/ResourceEvent#';
const REF = 'http://ns.adobe.com/xap/1.0/sType/ResourceRef#';
const NS = `xmlns:dc="${DC}" xmlns:xmpMM="${MM}" xmlns:stEvt="${EVT}" xmlns:stRef="${REF}"`;
const wrap = (body: string) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">${body}</rdf:RDF></x:xmpmeta>`;
const desc = (inner: string, attrs = '') => `<rdf:Description rdf:about="" ${NS}${attrs}>${inner}</rdf:Description>`;
const props = (inner: string, attrs = '') => parseRdfPacket(enc(wrap(desc(inner, attrs)))).properties;
const simple = (value: string) => ({ kind: 'simple' as const, value });

describe('parseRdfPacket: simple values', () => {
  it('reads a simple property element', () => {
    expect(props('<dc:format>application/pdf</dc:format>'))
      .toEqual([{ ns: DC, name: 'format', value: simple('application/pdf') }]);
  });

  it('reads a property written as a Description attribute', () => {
    expect(props('', ' dc:format="application/pdf"'))
      .toEqual([{ ns: DC, name: 'format', value: simple('application/pdf') }]);
  });

  it('keeps a simple value as written, whitespace included', () => {
    expect(props('<dc:format>  a b \n</dc:format>')[0].value).toEqual(simple('  a b \n'));
  });

  it('reads an empty element as the empty string', () => {
    expect(props('<dc:format/>')[0].value).toEqual(simple(''));
  });

  it('reads xml:lang on a property element', () => {
    expect(props('<dc:format xml:lang="en">x</dc:format>')[0])
      .toEqual({ ns: DC, name: 'format', value: simple('x'), lang: 'en' });
  });

  it('reads rdf:resource as a URI-flagged simple value', () => {
    expect(props('<dc:source rdf:resource="http://e.com/a"/>')[0].value)
      .toEqual({ kind: 'simple', value: 'http://e.com/a', uri: true });
  });
});

describe('parseRdfPacket: arrays', () => {
  it('reads Bag, Seq and Alt with their items in order', () => {
    const p = props(
      '<dc:subject><rdf:Bag><rdf:li>a</rdf:li><rdf:li>b</rdf:li></rdf:Bag></dc:subject>'
      + '<dc:creator><rdf:Seq><rdf:li>c</rdf:li></rdf:Seq></dc:creator>'
      + '<dc:rights><rdf:Alt><rdf:li>d</rdf:li></rdf:Alt></dc:rights>');
    expect(p.map((x) => x.value)).toEqual([
      { kind: 'array', form: 'Bag', items: [{ value: simple('a') }, { value: simple('b') }] },
      { kind: 'array', form: 'Seq', items: [{ value: simple('c') }] },
      { kind: 'array', form: 'Alt', items: [{ value: simple('d') }] },
    ]);
  });

  it('reads an empty container as an empty array', () => {
    expect(props('<dc:creator><rdf:Bag/></dc:creator>')[0].value)
      .toEqual({ kind: 'array', form: 'Bag', items: [] });
  });

  it('reads a language alternative with xml:lang on each item', () => {
    expect(props('<dc:title><rdf:Alt><rdf:li xml:lang="x-default">T</rdf:li>'
      + '<rdf:li xml:lang="de-DE">Titel</rdf:li></rdf:Alt></dc:title>')[0].value).toEqual({
      kind: 'array', form: 'Alt',
      items: [{ value: simple('T'), lang: 'x-default' }, { value: simple('Titel'), lang: 'de-DE' }],
    });
  });
});

describe('parseRdfPacket: structs', () => {
  const derived = { kind: 'struct', fields: [
    { ns: REF, name: 'documentID', value: simple('d') },
    { ns: REF, name: 'instanceID', value: simple('i') },
  ] };

  it('reads rdf:parseType="Resource" on a property element', () => {
    expect(props('<xmpMM:DerivedFrom rdf:parseType="Resource"><stRef:documentID>d</stRef:documentID>'
      + '<stRef:instanceID>i</stRef:instanceID></xmpMM:DerivedFrom>')[0].value).toEqual(derived);
  });

  it('reads a nested rdf:Description, its attributes before its elements', () => {
    expect(props('<xmpMM:DerivedFrom><rdf:Description stRef:documentID="d">'
      + '<stRef:instanceID>i</stRef:instanceID></rdf:Description></xmpMM:DerivedFrom>')[0].value).toEqual(derived);
  });

  it('reads an empty property element carrying property attributes as a struct', () => {
    expect(props('<xmpMM:DerivedFrom stRef:documentID="d" stRef:instanceID="i"/>')[0].value).toEqual(derived);
  });

  it('reads a Seq of structs in both item syntaxes', () => {
    const v = props('<xmpMM:History><rdf:Seq>'
      + '<rdf:li rdf:parseType="Resource"><stEvt:action>created</stEvt:action></rdf:li>'
      + '<rdf:li><rdf:Description stEvt:action="saved"/></rdf:li>'
      + '</rdf:Seq></xmpMM:History>')[0].value;
    expect(v).toEqual({ kind: 'array', form: 'Seq', items: [
      { value: { kind: 'struct', fields: [{ ns: EVT, name: 'action', value: simple('created') }] } },
      { value: { kind: 'struct', fields: [{ ns: EVT, name: 'action', value: simple('saved') }] } },
    ] });
  });
});

describe('parseRdfPacket: namespaces and packet shape', () => {
  it('resolves a property by namespace URI, not by prefix', () => {
    expect(props(`<foo:format xmlns:foo="${DC}">x</foo:format>`)[0])
      .toEqual({ ns: DC, name: 'format', value: simple('x') });
  });

  it('honours a prefix rebound on an inner element', () => {
    const p = props('<dc:format xmlns:dc="http://other/">x</dc:format><dc:type>t</dc:type>');
    expect(p.map((x) => x.ns)).toEqual(['http://other/', DC]);
  });

  it('merges several rdf:Description elements in document order', () => {
    const p = parseRdfPacket(enc(wrap(desc('<dc:format>f</dc:format>') + desc('', ' dc:type="t"')))).properties;
    expect(p.map((x) => x.name)).toEqual(['format', 'type']);
  });

  it('keeps the first of two duplicate properties and drops the rest', () => {
    const p = parseRdfPacket(enc(wrap(desc('<dc:format>first</dc:format>') + desc('<dc:format>second</dc:format>')))).properties;
    expect(p).toEqual([{ ns: DC, name: 'format', value: simple('first') }]);
  });

  it('accepts a bare rdf:RDF root and the legacy x:xapmeta root', () => {
    const body = desc('<dc:format>f</dc:format>');
    expect(parseRdfPacket(enc(`<rdf:RDF xmlns:rdf="${RDF_NS}">${body}</rdf:RDF>`)).properties).toHaveLength(1);
    expect(parseRdfPacket(enc(`<x:xapmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">${body}</rdf:RDF></x:xapmeta>`)).properties).toHaveLength(1);
  });

  it('accepts BOM, xpacket PIs and trailing padding', () => {
    const text = `﻿<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n${wrap(desc('<dc:format>f</dc:format>'))}\n${' '.repeat(2048)}\n<?xpacket end="w"?>`;
    expect(parseRdfPacket(enc(text)).properties).toHaveLength(1);
  });

  it('records the prefix each namespace was written under', () => {
    const r = parseRdfPacket(enc(wrap(desc('<dc:format>f</dc:format>'))));
    expect(r.prefixes.get(DC)).toBe('dc');
    expect(r.prefixes.get(MM)).toBe('xmpMM');
  });
});

describe('parseRdfPacket: refusals', () => {
  const refuses = (src: string, what: RegExp) => {
    expect(() => parseRdfPacket(enc(src))).toThrow(PdfParseError);
    expect(() => parseRdfPacket(enc(src))).toThrow(what);
  };

  it('refuses a DOCTYPE and an ENTITY declaration', () => {
    refuses(`<!DOCTYPE x [<!ENTITY e "boom">]>${wrap(desc(''))}`, /DTD/);
    refuses(`<!ENTITY e "boom">${wrap(desc(''))}`, /DTD/);
  });

  it('refuses a root that is not an XMP packet', () => {
    refuses('<html/>', /not an XMP packet root/);
  });

  it('refuses an xmpmeta with no rdf:RDF', () => {
    refuses('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>', /no rdf:RDF/);
  });

  it('refuses an unbound prefix', () => {
    refuses(wrap(desc('<zz:format>f</zz:format>')), /prefix "zz" is not bound/);
  });

  it('refuses text mixed with elements', () => {
    refuses(wrap(desc('<dc:subject>oops<rdf:Bag/></dc:subject>')), /both text and elements/);
  });

  it('refuses an unknown rdf:parseType', () => {
    refuses(wrap(desc('<dc:subject rdf:parseType="Literal">x</dc:subject>')), /parseType="Literal"/);
  });

  it('refuses a non-Description child of rdf:RDF', () => {
    refuses(wrap('<dc:format xmlns:dc="u">f</dc:format>'), /expected rdf:Description/);
  });

  it('refuses a non-li element inside an array', () => {
    refuses(wrap(desc('<dc:subject><rdf:Bag><dc:x>a</dc:x></rdf:Bag></dc:subject>')), /expected rdf:li/);
  });

  it('refuses a property holding a non-RDF node or two nodes', () => {
    refuses(wrap(desc('<dc:subject><dc:x>a</dc:x></dc:subject>')), /not an RDF node/);
    refuses(wrap(desc('<dc:subject><rdf:Bag/><rdf:Bag/></dc:subject>')), /more than one node/);
  });
});

const write = (properties: RdfProperty[], prefixes = new Map<string, string>()) =>
  serializeRdfPacket({ properties, prefixes });
const back = (properties: RdfProperty[]) => parseRdfPacket(enc(write(properties))).properties;

describe('serializeRdfPacket', () => {
  const model: RdfProperty[] = [
    { ns: DC, name: 'format', value: simple('application/pdf') },
    { ns: DC, name: 'title', value: { kind: 'array', form: 'Alt', items: [
      { value: simple('T'), lang: 'x-default' }, { value: simple('Titel'), lang: 'de-DE' }] } },
    { ns: DC, name: 'creator', value: { kind: 'array', form: 'Bag', items: [] } },
    { ns: MM, name: 'DerivedFrom', value: { kind: 'struct', fields: [
      { ns: REF, name: 'documentID', value: simple('d') }] } },
    { ns: MM, name: 'History', value: { kind: 'array', form: 'Seq', items: [
      { value: { kind: 'struct', fields: [
        { ns: EVT, name: 'action', value: simple('created') },
        { ns: EVT, name: 'tags', value: { kind: 'array', form: 'Bag', items: [{ value: simple('x') }] } }] } },
      { value: { kind: 'struct', fields: [] } }] } },
    { ns: DC, name: 'description', value: simple(''), lang: 'en' },
  ];

  it('round-trips every shape of the model', () => {
    expect(back(model)).toEqual(model);
  });

  it('writes one rdf:Description declaring every namespace used, struct fields included', () => {
    const s = write(model);
    expect(s.match(/<rdf:Description/g)).toHaveLength(1);
    for (const decl of [`xmlns:dc="${DC}"`, `xmlns:xmpMM="${MM}"`, `xmlns:stRef="${REF}"`, `xmlns:stEvt="${EVT}"`])
      expect(s).toContain(decl);
    expect(s.startsWith('<?xpacket begin="\uFEFF"')).toBe(true);
    expect(s.endsWith('<?xpacket end="w"?>')).toBe(true);
  });

  it('escapes text, attribute and namespace values', () => {
    const odd = 'http://e.com/?a=1&b="2"';
    const m: RdfProperty[] = [
      { ns: odd, name: 'v', value: simple(' a & <b> "c" ]]>\nd '), lang: 'x"y' },
    ];
    expect(back(m)).toEqual(m);
  });

  it('prefers the prefix the source used, then a well-known one, then nsN', () => {
    const s = write(
      [{ ns: 'http://a/', name: 'p', value: simple('1') }, { ns: MM, name: 'q', value: simple('2') },
        { ns: 'http://b/', name: 'r', value: simple('3') }],
      new Map([['http://a/', 'mine']]));
    expect(s).toContain('xmlns:mine="http://a/"');
    expect(s).toContain(`xmlns:xmpMM="${MM}"`);
    expect(s).toContain('xmlns:ns1="http://b/"');
  });

  it('renames a colliding prefix', () => {
    const m: RdfProperty[] = [
      { ns: 'http://fake-dc/', name: 'p', value: simple('1') },
      { ns: DC, name: 'format', value: simple('2') },
    ];
    const s = write(m, new Map([['http://fake-dc/', 'dc']]));
    expect(s).toContain('xmlns:dc="http://fake-dc/"');
    expect(s).toContain(`xmlns:ns1="${DC}"`);
    expect(back(m)).toEqual(m);
  });

  it('never assigns a reserved prefix', () => {
    const s = write([{ ns: 'http://a/', name: 'p', value: simple('1') }], new Map([['http://a/', 'rdf']]));
    expect(s).toContain('xmlns:ns1="http://a/"');
  });

  it('accepts a non-ASCII NCName', () => {
    const m: RdfProperty[] = [{ ns: 'http://a/', name: 'Form\u21820020fields', value: simple('fillable') }];
    expect(back(m)).toEqual(m);
  });

  it('refuses a model it cannot write', () => {
    expect(() => write([{ ns: '', name: 'p', value: simple('') }])).toThrow(TypeError);
    expect(() => write([{ ns: 'http://a/', name: 'a b', value: simple('') }])).toThrow(TypeError);
    expect(() => write([{ ns: RDF_NS, name: 'li', value: simple('') }])).toThrow(TypeError);
  });
});

describe('xmprdf: final-review fixes', () => {
  it('refuses to serialize characters XML 1.0 forbids, in values, langs and namespaces', () => {
    for (const bad of ['a\u0001b', 'a\u0000b', 'a\uD800b', 'a\uFFFEb']) {
      expect(() => write([{ ns: 'http://a/', name: 'p', value: simple(bad) }])).toThrow(TypeError);
      expect(() => write([{ ns: 'http://a/', name: 'p', value: simple('ok'), lang: bad }])).toThrow(TypeError);
      expect(() => write([{ ns: `http://a/${bad}`, name: 'p', value: simple('ok') }])).toThrow(TypeError);
    }
    const nested: RdfProperty[] = [{ ns: MM, name: 'History', value: { kind: 'array', form: 'Seq', items: [
      { value: { kind: 'struct', fields: [{ ns: EVT, name: 'action', value: simple('x\u0007') }] } }] } }];
    expect(() => write(nested)).toThrow(TypeError);
    expect(() => write([{ ns: DC, name: 'title', value: { kind: 'array', form: 'Alt',
      items: [{ value: simple('t'), lang: 'en\u0002' }] } }])).toThrow(TypeError);
  });

  it('still writes tab, newline, astral characters and U+FFFD', () => {
    const m: RdfProperty[] = [{ ns: 'http://a/', name: 'p', value: simple('a\tb\nc \u{1F600} \uFFFD') }];
    expect(back(m)).toEqual(m);
  });

  it('refuses at parse a property name the serializer could not write', () => {
    expect(() => props('<dc:a$b>x</dc:a$b>')).toThrow(PdfParseError);
    expect(() => props('<dc:a$b>x</dc:a$b>')).toThrow(/not an XML NCName/);
    expect(() => props('', ' dc:a$b="x"')).toThrow(/not an XML NCName/);
  });
});
