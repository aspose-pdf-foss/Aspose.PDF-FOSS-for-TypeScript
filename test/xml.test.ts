import { describe, expect, it } from 'vitest';
import { parseXml, writeXml, escapeXml, unescapeXml, XmlNode } from '../src/xml.js';
import { PdfParseError } from '../src/errors.js';

const enc = (s: string) => new TextEncoder().encode(s);
const node = (name: string, attrs: Record<string, string> = {}, children: XmlNode[] = [], text = ''): XmlNode =>
  ({ name, attrs: new Map(Object.entries(attrs)), children, text, nodes: [] });

describe('parseXml', () => {
  it('parses elements, attributes and text', () => {
    const r = parseXml(enc('<a x="1" y=\'2\'><b>hi</b></a>'));
    expect(r.name).toBe('a');
    expect(r.attrs.get('x')).toBe('1');
    expect(r.attrs.get('y')).toBe('2');
    expect(r.children).toHaveLength(1);
    expect(r.children[0].name).toBe('b');
    expect(r.children[0].text).toBe('hi');
  });

  it('skips the declaration, comments and processing instructions', () => {
    const r = parseXml(enc('<?xml version="1.0"?>\n<!-- note --><a><!--x--><b/></a>'));
    expect(r.name).toBe('a');
    expect(r.children).toHaveLength(1);
    expect(r.children[0].name).toBe('b');
  });

  it('handles self-closing elements', () => {
    const r = parseXml(enc('<a><b n="1"/></a>'));
    expect(r.children[0].attrs.get('n')).toBe('1');
    expect(r.children[0].children).toHaveLength(0);
  });

  it('strips namespace prefixes from element names', () => {
    const r = parseXml(enc('<x:a xmlns:x="urn:z"><x:b>v</x:b></x:a>'));
    expect(r.name).toBe('a');
    expect(r.children[0].name).toBe('b');
  });

  it('unescapes entities in text and attributes', () => {
    const r = parseXml(enc('<a t="&lt;&amp;&quot;&#65;"> &gt;&#x42; </a>'));
    expect(r.attrs.get('t')).toBe('<&"A');
    expect(r.text).toBe(' >B ');
  });

  it('reads CDATA as literal text', () => {
    const r = parseXml(enc('<a><![CDATA[<b>&raw]]></a>'));
    expect(r.text).toBe('<b>&raw');
  });

  it('records raw inner source', () => {
    const r = parseXml(enc('<a><b><i>x</i> y</b></a>'));
    expect(r.children[0].raw).toBe('<i>x</i> y');
  });

  it('throws PdfParseError on mismatched tags', () => {
    expect(() => parseXml(enc('<a><b></a></b>'))).toThrow(PdfParseError);
  });

  it('throws PdfParseError on an unterminated element', () => {
    expect(() => parseXml(enc('<a><b>'))).toThrow(PdfParseError);
  });

  it('throws PdfParseError when there is no root element', () => {
    expect(() => parseXml(enc('<?xml version="1.0"?>'))).toThrow(PdfParseError);
  });
});

describe('writeXml', () => {
  it('emits a declaration, attributes and nested elements', () => {
    const out = writeXml(node('a', { x: '1' }, [node('b', {}, [], 'hi')]));
    expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(out).toContain('<a x="1">');
    expect(out).toContain('<b>hi</b>');
  });

  it('self-closes empty elements', () => {
    expect(writeXml(node('a', {}, [node('b')]))).toContain('<b/>');
  });

  it('escapes attribute values and text', () => {
    const out = writeXml(node('a', { t: '<&">' }, [], ''));
    expect(out).toContain('t="&lt;&amp;&quot;&gt;"');
  });

  it('emits raw content unescaped', () => {
    const n = node('a');
    n.raw = '<i>x</i>';
    expect(writeXml(n)).toContain('<a><i>x</i></a>');
  });

  it('round-trips through parseXml', () => {
    const src = node('a', { k: 'v&w' }, [node('b', {}, [], 'te<xt')]);
    const back = parseXml(new TextEncoder().encode(writeXml(src)));
    expect(back.attrs.get('k')).toBe('v&w');
    expect(back.children[0].text).toBe('te<xt');
  });
});

describe('escape helpers', () => {
  it('escapes and unescapes symmetrically', () => {
    expect(unescapeXml(escapeXml('a<b>&"c'))).toBe('a<b>&"c');
  });
});

describe('parseXml — mixed content ordering', () => {
  it('records text chunks and children in source order', () => {
    const root = parseXml(enc('<text>Hello <tspan>big</tspan> world</text>'));
    expect(root.nodes.map((n) => (typeof n === 'string' ? n : `<${n.name}>`)))
      .toEqual(['Hello ', '<tspan>', ' world']);
  });

  it('leaves text and children exactly as they were', () => {
    const root = parseXml(enc('<text>Hello <tspan>big</tspan> world</text>'));
    expect(root.text).toBe('Hello  world');
    expect(root.children.map((c) => c.name)).toEqual(['tspan']);
  });

  it('gives a self-closing element an empty nodes array', () => {
    const root = parseXml(enc('<svg><rect/></svg>'));
    expect(root.children[0].nodes).toEqual([]);
  });

  it('unescapes entities in a chunk and keeps CDATA as its own chunk', () => {
    const root = parseXml(enc('<t>a &amp; b<![CDATA[<raw>]]>c</t>'));
    expect(root.nodes).toEqual(['a & b', '<raw>', 'c']);
  });

  it('keeps a chunk that is only whitespace', () => {
    // The SVG whitespace rules run downstream and need the space to collapse.
    const root = parseXml(enc('<text><tspan>a</tspan> <tspan>b</tspan></text>'));
    expect(root.nodes.filter((n) => typeof n === 'string')).toEqual([' ']);
  });
});
