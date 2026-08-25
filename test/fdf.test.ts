import { describe, expect, it } from 'vitest';
import { readFdf, writeFdf } from '../src/fdf.js';
import type { FormData } from '../src/formdata.js';
import type { AnnotData } from '../src/annotdata.js';
import { PdfDict, PdfObject, name } from '../src/types.js';
import { PdfParseError } from '../src/errors.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const byName = (d: FormData, n: string) => d.fields.find((x) => x.name === n);

describe('writeFdf', () => {
  it('emits a header, a trailer and no xref', () => {
    const out = dec(writeFdf({ fields: [] }));
    expect(out.startsWith('%FDF-1.2')).toBe(true);
    expect(out).toContain('trailer');
    expect(out.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(out).not.toContain('xref');
  });

  it('writes checkbox and radio values as names, text as a string', () => {
    const out = dec(writeFdf({ fields: [
      { name: 'agree', type: 'checkbox', values: ['Yes'] },
      { name: 'color', type: 'radio', values: ['Red'] },
      { name: 'name', type: 'text', values: ['Bob'] },
    ] }));
    expect(out).toContain('/V /Yes');
    expect(out).toContain('/V /Red');
    expect(out).toContain('/V (Bob)');
  });

  it('writes a multi-value choice as an array', () => {
    const out = dec(writeFdf({ fields: [{ name: 'tags', type: 'choice', values: ['a', 'b'] }] }));
    expect(out).toContain('/V [(a) (b)]');
  });

  it('writes full dotted names in a flat field list', () => {
    const out = dec(writeFdf({ fields: [{ name: 'parent.child', type: 'text', values: ['kid'] }] }));
    expect(out).toContain('/T (parent.child)');
  });

  it('writes f and ids only when present', () => {
    expect(dec(writeFdf({ fields: [] }))).not.toContain('/F (');
    expect(dec(writeFdf({ fields: [] }))).not.toContain('/ID');
    const out = dec(writeFdf({ fields: [], file: 'form.pdf', id: ['aabb', 'ccdd'] }));
    expect(out).toContain('/F (form.pdf)');
    // serializeValue emits PDF *literal* strings, so the id bytes 0xaa 0xbb
    // come out octal-escaped, not as <aabb>. readFdf hex-encodes them back;
    // the round-trip test below is what pins the actual value.
    expect(out).toContain('/ID [');
  });

  it('writes rich text as /RV', () => {
    const out = dec(writeFdf({ fields: [{ name: 'n', type: 'text', values: ['A'], richText: '<body>A</body>' }] }));
    expect(out).toContain('/RV (<body>A</body>)');
  });
});

describe('readFdf', () => {
  const doc = (fdfDict: string) =>
    enc(`%FDF-1.2\n1 0 obj\n<< /FDF ${fdfDict} >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);

  it('reads names, strings and arrays as string values', () => {
    const d = readFdf(doc('<< /Fields [<< /T (name) /V (Bob) >> << /T (agree) /V /Yes >> << /T (tags) /V [(a) (b)] >>] >>'));
    expect(byName(d, 'name')?.values).toEqual(['Bob']);
    expect(byName(d, 'agree')?.values).toEqual(['Yes']);
    expect(byName(d, 'tags')?.values).toEqual(['a', 'b']);
  });

  it('always reports type unknown, for the form to resolve', () => {
    const d = readFdf(doc('<< /Fields [<< /T (name) /V (Bob) >>] >>'));
    expect(byName(d, 'name')?.type).toBe('unknown');
  });

  it('flattens a /Kids tree into dotted names', () => {
    const d = readFdf(doc('<< /Fields [<< /T (parent) /Kids [<< /T (child) /V (kid) >>] >>] >>'));
    expect(byName(d, 'parent.child')?.values).toEqual(['kid']);
    expect(byName(d, 'parent')).toBeUndefined();
  });

  it('reads /RV rich text', () => {
    const d = readFdf(doc('<< /Fields [<< /T (n) /V (A) /RV (<body>A</body>) >>] >>'));
    expect(byName(d, 'n')?.richText).toBe('<body>A</body>');
  });

  it('reads /F and /ID', () => {
    const d = readFdf(doc('<< /Fields [] /F (form.pdf) /ID [<aabb> <ccdd>] >>'));
    expect(d.file).toBe('form.pdf');
    expect(d.id).toEqual(['aabb', 'ccdd']);
  });

  it('follows indirect references', () => {
    const src = enc('%FDF-1.2\n1 0 obj\n<< /FDF 2 0 R >>\nendobj\n2 0 obj\n<< /Fields [3 0 R] >>\nendobj\n3 0 obj\n<< /T (name) /V (Bob) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
    expect(byName(readFdf(src), 'name')?.values).toEqual(['Bob']);
  });

  it('tolerates an xref table when present', () => {
    const src = enc('%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [<< /T (n) /V (v) >>] >> >>\nendobj\nxref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Root 1 0 R /Size 2 >>\nstartxref\n0\n%%EOF\n');
    expect(byName(readFdf(src), 'n')?.values).toEqual(['v']);
  });

  it('throws PdfParseError without an %FDF- header', () => {
    expect(() => readFdf(enc('%PDF-1.7\ntrailer\n<< /Root 1 0 R >>\n'))).toThrow(PdfParseError);
  });

  it('throws PdfParseError with no trailer', () => {
    expect(() => readFdf(enc('%FDF-1.2\n1 0 obj\n<< >>\nendobj\n'))).toThrow(PdfParseError);
  });

  it('throws PdfParseError when /Root has no /FDF dictionary', () => {
    expect(() => readFdf(enc('%FDF-1.2\n1 0 obj\n<< >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n'))).toThrow(PdfParseError);
  });

  it('round-trips through writeFdf', () => {
    const src: FormData = {
      fields: [
        { name: 'name', type: 'text', values: ['Bob'] },
        { name: 'agree', type: 'checkbox', values: ['Yes'] },
        { name: 'parent.child', type: 'text', values: ['kid'] },
        { name: 'tags', type: 'choice', values: ['a', 'b'] },
        { name: 'rt', type: 'text', values: ['A'], richText: '<body>A</body>' },
      ],
      file: 'form.pdf',
      id: ['aabb', 'ccdd'],
    };
    const back = readFdf(writeFdf(src));
    expect(back.file).toBe('form.pdf');
    expect(back.id).toEqual(['aabb', 'ccdd']);
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

describe('FDF annotations', () => {
  it('writes /Annots and its objects when annots are present', () => {
    const out = dec(writeFdf({ fields: [], annots: [sq()] }));
    expect(out).toContain('/Annots');
    expect(out).toContain('/Subtype /Square');
    expect(out).toContain('2 0 obj');   // the annotation, after the FDF catalog
  });

  it('omits /Annots entirely when there are none', () => {
    expect(dec(writeFdf({ fields: [] }))).not.toContain('/Annots');
  });

  it('round-trips an annotation through write and read', () => {
    const back = readFdf(writeFdf({ fields: [], annots: [sq()] }));
    expect(back.annots?.length).toBe(1);
    expect(back.annots![0].page).toBe(1);
    expect(back.annots![0].dict.get('Rect')).toEqual([0, 0, 10, 10]);
  });

  it('reads a file with no /Annots as having no annotations', () => {
    expect(readFdf(writeFdf({ fields: [] })).annots ?? []).toEqual([]);
  });

  it('carries fields and annotations in the same file', () => {
    const back = readFdf(writeFdf({
      fields: [{ name: 'name', type: 'text', values: ['Bob'] }],
      annots: [sq()],
    }));
    expect(byName(back, 'name')?.values).toEqual(['Bob']);
    expect(back.annots?.length).toBe(1);
  });

  it('preserves a binary appearance payload byte-for-byte', () => {
    // Bytes above 0x7F would be mangled if the file were assembled as a JS
    // string and then UTF-8 encoded.
    const raw = new Uint8Array([0x78, 0x9c, 0xff, 0x00, 0x80, 0xfe, 0x41]);
    const a = sq();
    a.dict.set('AP', new Map<string, PdfObject>([['N', {
      kind: 'stream',
      dict: new Map<string, PdfObject>([['Subtype', name('Form')]]),
      raw,
    }]]));
    const back = readFdf(writeFdf({ fields: [], annots: [a] }));
    const ap = back.annots![0].dict.get('AP') as PdfDict;
    expect((ap.get('N') as { raw: Uint8Array }).raw).toEqual(raw);
  });
});
