import { describe, expect, it } from 'vitest';
import { readXfdf, writeXfdf } from '../src/xfdf.js';
import type { FormData } from '../src/formdata.js';
import type { AnnotData } from '../src/annotdata.js';
import { PdfObject, name } from '../src/types.js';
import { PdfParseError } from '../src/errors.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const f = (name: string, values: string[], richText?: string) =>
  ({ name, type: 'text' as const, values, ...(richText !== undefined ? { richText } : {}) });
const byName = (d: FormData, n: string) => d.fields.find((x) => x.name === n);

describe('writeXfdf', () => {
  it('emits the xfdf root with the Adobe namespace', () => {
    const out = dec(writeXfdf({ fields: [] }));
    expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(out).toContain('xmlns="http://ns.adobe.com/xfdf/"');
  });

  it('nests fields by dotted name segment', () => {
    const out = dec(writeXfdf({ fields: [f('parent.child', ['kid'])] }));
    expect(out).toMatch(/<field name="parent">[\s\S]*<field name="child">/);
    expect(out).toContain('<value>kid</value>');
  });

  it('shares a parent element between sibling fields', () => {
    const out = dec(writeXfdf({ fields: [f('a.x', ['1']), f('a.y', ['2'])] }));
    expect(out.match(/<field name="a">/g)).toHaveLength(1);
  });

  it('emits one value element per multi-select value', () => {
    const out = dec(writeXfdf({ fields: [f('tags', ['a', 'b'])] }));
    expect(out.match(/<value>/g)).toHaveLength(2);
  });

  it('escapes text and attribute content', () => {
    const out = dec(writeXfdf({ fields: [f('a&b', ['<x>'])] }));
    expect(out).toContain('name="a&amp;b"');
    expect(out).toContain('<value>&lt;x&gt;</value>');
  });

  it('emits rich text as unescaped markup', () => {
    const out = dec(writeXfdf({ fields: [f('n', ['A'], '<body><b>A</b></body>')] }));
    expect(out).toContain('<value-richtext><body><b>A</b></body></value-richtext>');
  });

  it('emits f and ids only when present', () => {
    expect(dec(writeXfdf({ fields: [] }))).not.toContain('<f ');
    const out = dec(writeXfdf({ fields: [], file: 'form.pdf', id: ['aa', 'bb'] }));
    expect(out).toContain('<f href="form.pdf"/>');
    expect(out).toContain('<ids original="aa" modified="bb"/>');
  });
});

describe('readXfdf', () => {
  it('reads flat and nested fields into dotted names', () => {
    const d = readXfdf(enc(
      '<xfdf xmlns="http://ns.adobe.com/xfdf/"><fields>' +
      '<field name="name"><value>Ada</value></field>' +
      '<field name="parent"><field name="child"><value>kid</value></field></field>' +
      '</fields></xfdf>'));
    expect(byName(d, 'name')?.values).toEqual(['Ada']);
    expect(byName(d, 'parent.child')?.values).toEqual(['kid']);
    expect(byName(d, 'parent')).toBeUndefined(); // container only, no value
  });

  it('collects repeated values in document order', () => {
    const d = readXfdf(enc('<xfdf><fields><field name="t"><value>a</value><value>b</value></field></fields></xfdf>'));
    expect(byName(d, 't')?.values).toEqual(['a', 'b']);
  });

  it('reads without the namespace declaration and through a prefix', () => {
    const d = readXfdf(enc('<x:xfdf xmlns:x="http://ns.adobe.com/xfdf/"><x:fields><x:field name="n"><x:value>v</x:value></x:field></x:fields></x:xfdf>'));
    expect(byName(d, 'n')?.values).toEqual(['v']);
  });

  it('reads CDATA values', () => {
    const d = readXfdf(enc('<xfdf><fields><field name="n"><value><![CDATA[a<b]]></value></field></fields></xfdf>'));
    expect(byName(d, 'n')?.values).toEqual(['a<b']);
  });

  it('reads rich text as raw markup', () => {
    const d = readXfdf(enc('<xfdf><fields><field name="n"><value>A</value><value-richtext><body><b>A</b></body></value-richtext></field></fields></xfdf>'));
    expect(byName(d, 'n')?.richText).toBe('<body><b>A</b></body>');
  });

  it('reads f and ids', () => {
    const d = readXfdf(enc('<xfdf><f href="form.pdf"/><ids original="aa" modified="bb"/><fields/></xfdf>'));
    expect(d.file).toBe('form.pdf');
    expect(d.id).toEqual(['aa', 'bb']);
  });

  it('tolerates a document with no fields element', () => {
    expect(readXfdf(enc('<xfdf/>')).fields).toEqual([]);
  });

  it('throws PdfParseError on a wrong root element', () => {
    expect(() => readXfdf(enc('<fdf/>'))).toThrow(PdfParseError);
  });

  it('throws PdfParseError on malformed XML', () => {
    expect(() => readXfdf(enc('<xfdf><fields>'))).toThrow(PdfParseError);
  });

  it('round-trips through writeXfdf', () => {
    const src: FormData = {
      fields: [f('name', ['Ada']), f('parent.child', ['kid']), f('tags', ['a', 'b']), f('rt', ['A'], '<body>A</body>')],
      file: 'form.pdf',
      id: ['aa', 'bb'],
    };
    const back = readXfdf(writeXfdf(src));
    expect(back.file).toBe('form.pdf');
    expect(back.id).toEqual(['aa', 'bb']);
    for (const want of src.fields) {
      const got = byName(back, want.name);
      expect(got?.values).toEqual(want.values);
      expect(got?.richText).toBe(want.richText);
    }
  });
});

const sq = (page = 1): AnnotData => ({
  page,
  dict: new Map<string, PdfObject>([
    ['Type', name('Annot')], ['Subtype', name('Square')], ['Rect', [0, 0, 10, 10]],
  ]),
});

describe('XFDF annotations', () => {
  it('writes an <annots> section when annots are present', () => {
    const out = dec(writeXfdf({ fields: [], annots: [sq()] }));
    expect(out).toContain('<annots>');
    expect(out).toContain('<square');
    expect(out).toContain('page="1"');
  });

  it('omits <annots> entirely when there are none', () => {
    expect(dec(writeXfdf({ fields: [] }))).not.toContain('<annots');
  });

  it('round-trips an annotation through write and read', () => {
    const back = readXfdf(writeXfdf({ fields: [], annots: [sq()] }));
    expect(back.annots?.length).toBe(1);
    expect(back.annots![0].page).toBe(1);
    expect(back.annots![0].dict.get('Rect')).toEqual([0, 0, 10, 10]);
  });

  it('reads a file with no <annots> as having no annotations', () => {
    expect(readXfdf(writeXfdf({ fields: [] })).annots ?? []).toEqual([]);
  });

  it('carries fields and annotations in the same file', () => {
    const back = readXfdf(writeXfdf({
      fields: [{ name: 'name', type: 'text', values: ['Bob'] }],
      annots: [sq()],
    }));
    expect(byName(back, 'name')?.values).toEqual(['Bob']);
    expect(back.annots?.length).toBe(1);
  });

  it('surfaces an unreadable annotation element as annotSkips', () => {
    const back = readXfdf(enc(
      '<xfdf><annots><movie page="0" rect="0,0,1,1"/></annots></xfdf>'));
    expect(back.annotSkips).toEqual([{ reason: 'unsupported annotation type' }]);
  });
});
