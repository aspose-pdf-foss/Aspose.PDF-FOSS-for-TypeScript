import { describe, it, expect } from 'vitest';
import { parseNsXml, nsAttr, nsChild, nsFind, XML_NS, MC_NS } from '../src/xmlns.js';
import { parseWml, W, displayName, onOff, numAttr, hexColor } from '../src/wmlns.js';
import { PdfParseError } from '../src/errors.js';
import { enc, W_NS, W_STRICT, docXml, p, r } from './helpers/wml.js';

describe('parseNsXml', () => {
  it('resolves element and attribute prefixes through xmlns scopes', () => {
    const el = parseNsXml(enc('<x:a xmlns:x="urn:x" xmlns:y="urn:y" y:k="1" k="2"><b xmlns="urn:d"><x:c/></b></x:a>'));
    expect([el.ns, el.local]).toEqual(['urn:x', 'a']);
    expect(nsAttr(el, 'urn:y', 'k')).toBe('1');
    expect(nsAttr(el, '', 'k')).toBe('2');
    const b = el.children[0];
    expect([b.ns, b.local]).toEqual(['urn:d', 'b']);
    expect(nsChild(b, 'urn:x', 'c')).toBeDefined();
  });

  it('gives an UNPREFIXED attribute no namespace, even under a default namespace', () => {
    const el = parseNsXml(enc('<a xmlns="urn:d" k="v"/>'));
    expect(el.ns).toBe('urn:d');
    expect(nsAttr(el, '', 'k')).toBe('v');
    expect(nsAttr(el, 'urn:d', 'k')).toBeUndefined();
  });

  it('rebinds a prefix for a subtree only', () => {
    const el = parseNsXml(enc('<p:a xmlns:p="urn:1"><p:b xmlns:p="urn:2"/><p:c/></p:a>'));
    expect(el.children.map((c) => c.ns)).toEqual(['urn:2', 'urn:1']);
  });

  it('binds the xml prefix without a declaration', () => {
    expect(nsAttr(parseNsXml(enc('<a xml:space="preserve"/>')), XML_NS, 'space')).toBe('preserve');
  });

  it('canonicalizes declared URIs through canon', () => {
    const el = parseNsXml(enc('<o:a xmlns:o="urn:old"/>'), undefined, { canon: (u) => (u === 'urn:old' ? 'urn:new' : u) });
    expect(el.ns).toBe('urn:new');
  });

  it('keeps text verbatim', () => {
    expect(parseNsXml(enc('<a>  two  spaces </a>')).text).toBe('  two  spaces ');
  });

  it('finds a descendant depth first', () => {
    const el = parseNsXml(enc('<a xmlns:q="urn:q"><b><q:t>1</q:t></b><q:t>2</q:t></a>'));
    expect(nsFind(el, 'urn:q', 't')?.text).toBe('1');
  });
});

describe('parseNsXml: markup compatibility', () => {
  const opts = { understood: new Set(['urn:known', MC_NS]) };
  const mc = (inner: string, extra = ''): Uint8Array =>
    enc(`<k:root xmlns:k="urn:known" xmlns:u="urn:unknown" xmlns:mc="${MC_NS}"${extra}>${inner}</k:root>`);
  const ns = (bytes: Uint8Array) => parseNsXml(bytes, undefined, opts).children.map((c) => nsAttr(c, '', 'n') ?? c.local);

  it('splices in the first Choice whose Requires are all understood', () => {
    expect(ns(mc('<mc:AlternateContent><mc:Choice Requires="u"><k:x n="1"/></mc:Choice>'
      + '<mc:Choice Requires="k"><k:x n="2"/><k:x n="2b"/></mc:Choice><mc:Fallback><k:x n="3"/></mc:Fallback>'
      + '</mc:AlternateContent>'))).toEqual(['2', '2b']);
  });

  it('takes the Fallback when no Choice qualifies', () => {
    expect(ns(mc('<mc:AlternateContent><mc:Choice Requires="u"><k:x n="1"/></mc:Choice>'
      + '<mc:Fallback><k:x n="3"/></mc:Fallback></mc:AlternateContent>'))).toEqual(['3']);
  });

  it('yields nothing when no Choice qualifies and there is no Fallback', () => {
    expect(ns(mc('<mc:AlternateContent><mc:Choice Requires="u"><k:x n="1"/></mc:Choice></mc:AlternateContent>'))).toEqual([]);
  });

  it('treats a Requires prefix that is not declared as not understood', () => {
    expect(ns(mc('<mc:AlternateContent><mc:Choice Requires="zz"><k:x n="1"/></mc:Choice>'
      + '<mc:Fallback><k:x n="3"/></mc:Fallback></mc:AlternateContent>'))).toEqual(['3']);
  });

  it('keeps the CONTENT of an ignored element named by ProcessContent, by name or by wildcard', () => {
    const named = parseNsXml(mc('<u:wrap><k:x n="1"/></u:wrap><u:other><k:x n="2"/></u:other>',
      ' mc:Ignorable="u" mc:ProcessContent="u:wrap"'), undefined, opts);
    expect(named.children.map((c) => nsAttr(c, '', 'n'))).toEqual(['1']);
    const any = parseNsXml(mc('<u:wrap><k:x n="1"/></u:wrap><u:other><k:x n="2"/></u:other>',
      ' mc:Ignorable="u" mc:ProcessContent="u:*"'), undefined, opts);
    expect(any.children.map((c) => nsAttr(c, '', 'n'))).toEqual(['1', '2']);
  });

  it('applies ProcessContent to descendants of the element declaring it', () => {
    const root = parseNsXml(mc('<k:holder mc:ProcessContent="u:wrap"><u:wrap><k:x n="1"/></u:wrap></k:holder>',
      ' mc:Ignorable="u"'), undefined, opts);
    expect(root.children[0].children.map((c) => nsAttr(c, '', 'n'))).toEqual(['1']);
  });

  it('refuses a document whose MustUnderstand names a namespace not understood', () => {
    expect(() => parseNsXml(mc('<k:x/>', ' mc:MustUnderstand="u"'), undefined, opts)).toThrow(PdfParseError);
    expect(parseNsXml(mc('<k:x/>', ' mc:MustUnderstand="k"'), undefined, opts).children).toHaveLength(1);
    // Without an understood set no Markup Compatibility is applied, MustUnderstand included.
    expect(parseNsXml(mc('<k:x/>', ' mc:MustUnderstand="u"')).children).toHaveLength(1);
  });

  it('drops elements and attributes of an Ignorable namespace that is not understood', () => {
    const root = parseNsXml(mc('<u:gone/><k:kept u:a="x" k:a="y"/>', ' mc:Ignorable="u"'), undefined, opts);
    expect(root.children.map((c) => c.local)).toEqual(['kept']);
    expect([...root.children[0].attrs.keys()]).toEqual(['urn:known a']);
  });

  it('keeps an unknown element that is not Ignorable — recording it is the caller\'s', () => {
    expect(parseNsXml(mc('<u:stays/>'), undefined, opts).children[0].ns).toBe('urn:unknown');
  });

  it('leaves Markup Compatibility alone when no understood set is given', () => {
    expect(parseNsXml(mc('<mc:AlternateContent/>')).children[0].local).toBe('AlternateContent');
  });

  it('refuses a document whose ROOT markup compatibility removed', () => {
    const bytes = enc(`<u:root xmlns:u="urn:unknown" xmlns:mc="${MC_NS}" mc:Ignorable="u"/>`);
    expect(() => parseNsXml(bytes, undefined, opts)).toThrow(PdfParseError);
  });
});

describe('wmlns', () => {
  it('reads a Strict document as transitional', () => {
    const el = parseWml(enc(`<w:document xmlns:w="${W_STRICT}"><w:body/></w:document>`));
    expect([el.ns, el.local]).toEqual([W, 'document']);
  });

  it('is prefix-agnostic', () => {
    const el = parseWml(enc(`<x:document xmlns:x="${W_NS}"/>`));
    expect([el.ns, el.local]).toEqual([W, 'document']);
  });

  it('takes the Fallback of a w14 Choice, a namespace it does not understand', () => {
    const body = parseWml(docXml(p('<mc:AlternateContent><mc:Choice Requires="w14">' + r('choice')
      + '</mc:Choice><mc:Fallback>' + r('fallback') + '</mc:Fallback></mc:AlternateContent>'))).children[0];
    expect(nsFind(body, W, 't')?.text).toBe('fallback');
  });

  it('names elements for the unsupported report by conventional prefix', () => {
    const el = parseWml(enc(`<q:document xmlns:q="${W_NS}"><z:x xmlns:z="urn:q"/></q:document>`));
    expect(displayName(el)).toBe('w:document');
    expect(displayName(el.children[0])).toBe('{urn:q}x');
  });

  it('reads ST_OnOff', () => {
    const v = (x: string) => onOff(parseWml(enc(`<w:b xmlns:w="${W_NS}"${x}/>`)));
    expect(v('')).toBe(true);
    for (const f of ['0', 'false', 'off']) expect(v(` w:val="${f}"`)).toBe(false);
    for (const t of ['1', 'true', 'on']) expect(v(` w:val="${t}"`)).toBe(true);
    expect(onOff(undefined)).toBeUndefined();
  });

  it('reads numbers strictly — an empty value is not 0', () => {
    expect(numAttr('24')).toBe(24);
    expect(numAttr('-3.5')).toBe(-3.5);
    expect(numAttr('')).toBeUndefined();
    expect(numAttr('12pt')).toBeUndefined();
  });

  it('reads colours: auto is null, hex is 0..1, junk is undefined', () => {
    expect(hexColor('auto')).toBeNull();
    expect(hexColor('FF8000')).toEqual([1, 128 / 255, 0]);
    expect(hexColor('red')).toBeUndefined();
    expect(hexColor(undefined)).toBeUndefined();
  });
});
