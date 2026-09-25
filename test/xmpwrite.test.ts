import { describe, it, expect } from 'vitest';
import { checkXmpWrite, toRdfValue, type XmpValueInput } from '../src/xmpwrite.js';
import { XmpValue } from '../src/xmpvalue.js';
import { RDF_NS } from '../src/xmprdf.js';

const DC = 'http://purl.org/dc/elements/1.1/';
const ACME = 'http://acme.example/ns/1.0/';
const read = (v: XmpValueInput) => new XmpValue(toRdfValue(v));
const ok = (v: XmpValueInput | null, prefix?: string) => () => checkXmpWrite(ACME, 'P', v, prefix === undefined ? {} : { prefix });

describe('toRdfValue round-trips through XmpValue', () => {
  it('scalars', () => {
    expect(read('hi').asText()).toBe('hi');
    expect(read(42).asInt()).toBe(42);
    expect(read(-2.5).asReal()).toBe(-2.5);
    expect(read(true).asBool()).toBe(true);
    expect(read(false).asBool()).toBe(false);
    const at = new Date(Date.UTC(2024, 5, 3, 12, 30, 45));
    expect(read(at).asDate()!.date).toEqual(at);
  });

  it('spells a boolean True/False exactly — asBool reads either case, veraPDF\'s ^True$|^False$ does not', () => {
    expect(toRdfValue(true)).toEqual({ kind: 'simple', value: 'True' });
    expect(toRdfValue(false)).toEqual({ kind: 'simple', value: 'False' });
  });

  it('arrays keep their form and convert items recursively', () => {
    const seq = toRdfValue({ seq: ['a', 1] });
    expect(seq).toMatchObject({ kind: 'array', form: 'Seq' });
    expect(read({ bag: ['a', 'b'] }).asArray()!.map((x) => x.asText())).toEqual(['a', 'b']);
    expect(toRdfValue({ alt: ['x'] })).toMatchObject({ kind: 'array', form: 'Alt' });
    expect(read({ seq: [{ bag: ['n'] }] }).asArray()![0].asArray()![0].asText()).toBe('n');
  });

  it('a lang map writes x-default FIRST, whatever order it was given in', () => {
    const v = toRdfValue({ lang: { de: 'Hallo', 'x-default': 'Hello', fr: 'Bonjour' } });
    expect(v.kind === 'array' && v.items.map((i) => i.lang)).toEqual(['x-default', 'de', 'fr']);
    expect(read({ lang: { de: 'Hallo', 'x-default': 'Hello' } }).asText('de')).toBe('Hallo');
    expect(read({ lang: { de: 'Hallo', 'x-default': 'Hello' } }).asText()).toBe('Hello');
  });

  it('uri and struct', () => {
    expect(read({ uri: 'http://x' }).asUri()).toBe('http://x');
    expect(read({ uri: 'http://x' }).asText()).toBeUndefined();
    expect(toRdfValue({ struct: [{ namespace: ACME, name: 'a', value: 1 }] }))
      .toEqual({ kind: 'struct', fields: [{ ns: ACME, name: 'a', value: { kind: 'simple', value: '1' } }] });
  });
});

describe('checkXmpWrite', () => {
  it('accepts every shape, and null', () => {
    for (const v of ['s', 1, true, new Date(0), { seq: [] }, { bag: ['a'] }, { alt: ['a'] },
      { lang: { 'x-default': 'a' } }, { uri: 'u' }, { struct: [{ namespace: ACME, name: 'f', value: 'v' }] }, null] as const)
      expect(ok(v as XmpValueInput | null)).not.toThrow();
  });

  it('refuses the wrong kind of thing with TypeError', () => {
    for (const bad of [Number.NaN, Infinity, new Date(Number.NaN), ['bare array'], {}, { seq: [], bag: [] },
      { seq: 'x' }, { lang: {} }, { lang: { de: 1 } }, { uri: 1 }, { struct: [{ namespace: '', name: 'f', value: 'v' }] },
      { struct: [{ namespace: ACME, name: 'no space', value: 'v' }] }, { nope: 1 }, { seq: [null] }] as unknown[])
      expect(ok(bad as XmpValueInput), JSON.stringify(bad)).toThrow(TypeError);
  });

  it('refuses a number written in exponent notation, which asReal could not read back', () => {
    expect(ok(1e21)).toThrow(TypeError);
    expect(ok(1e-7)).toThrow(TypeError);
    expect(ok(123456789012345)).not.toThrow();
  });

  it('refuses a bad namespace, name or prefix with TypeError', () => {
    expect(() => checkXmpWrite('', 'P', 'v', {})).toThrow(TypeError);
    expect(() => checkXmpWrite(RDF_NS, 'P', 'v', {})).toThrow(TypeError);
    expect(() => checkXmpWrite('http://www.w3.org/XML/1998/namespace', 'P', 'v', {})).toThrow(TypeError);
    expect(() => checkXmpWrite(ACME, 'a b', 'v', {})).toThrow(TypeError);
    expect(ok('v', 'no:colon')).toThrow(TypeError);
  });

  it('refuses a Date outside years 0-9999 with RangeError: toISOString writes ±YYYYYY, which asDate cannot read back', () => {
    expect(ok(new Date(Date.UTC(10000, 0, 1)))).toThrow(RangeError);
    const bc = new Date(0); bc.setUTCFullYear(-1);
    expect(ok(bc)).toThrow(RangeError);
    const y999 = new Date(0); y999.setUTCFullYear(999);
    expect(ok(y999)).not.toThrow();
    expect(ok({ seq: [new Date(Date.UTC(10000, 0, 1))] })).toThrow(RangeError);
  });

  it('refuses a well-known prefix for a different namespace, beyond the six built-ins', () => {
    // The serializer gives these prefixes to their own namespaces, so the
    // caller's claim would lose — or push xmpMM off its own prefix.
    for (const p of ['xmpMM', 'stRef', 'stEvt', 'pdfaExtension', 'pdfaSchema', 'pdfaProperty'])
      expect(ok('v', p), p).toThrow(RangeError);
    expect(() => checkXmpWrite('http://ns.adobe.com/xap/1.0/mm/', 'DocumentID', 'v', { prefix: 'xmpMM' })).not.toThrow();
  });

  it('refuses a reserved prefix for a DIFFERENT namespace with RangeError, and allows its own', () => {
    expect(ok('v', 'dc')).toThrow(RangeError);
    expect(ok('v', 'rdf')).toThrow(RangeError);
    expect(ok('v', 'xmlns')).toThrow(RangeError);
    expect(() => checkXmpWrite(DC, 'coverage', 'v', { prefix: 'dc' })).not.toThrow();
    expect(ok('v', 'acme')).not.toThrow();
  });
});
