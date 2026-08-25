import { describe, it, expect } from 'vitest';
import {
  buildFilespec, type AttachmentOptions,
} from '../src/embeddedfile.js';
import { md5 } from '../src/crypto.js';
import { inflateStream } from '../src/flate.js';
import { decodePdfText } from '../src/metadata.js';
import {
  isStream, isName, isString, isRef, isDict, type PdfRef, type PdfObject, type PdfStream,
} from '../src/types.js';
import { Document } from '../src/document.js';
import { readAttachments } from '../src/embeddedfile.js';
import { buildEmbeddedFileTarget } from './helpers/build-attachment-pdf.js';
import { buildBlankPage } from './helpers/build-annot-target.js';
import { FileAttachmentAnnotation } from '../src/annotation.js';

/** Collect objects an `alloc` callback receives, handing back sequential refs. */
function fakeAlloc() {
  const objs: PdfObject[] = [];
  const alloc = (o: PdfObject): PdfRef => {
    objs.push(o);
    return { kind: 'ref', num: objs.length, gen: 0 };
  };
  return { objs, alloc };
}

describe('buildFilespec', () => {
  const bytes = new TextEncoder().encode('hello attachment');

  it('builds a /Filespec over a compressed /EmbeddedFile stream with /Params', () => {
    const { objs, alloc } = fakeAlloc();
    const fs = buildFilespec(bytes, 'readme.txt', { description: 'A readme', mimeType: 'text/plain' }, alloc);

    expect(isName(fs.get('Type')!) && (fs.get('Type') as any).name).toBe('Filespec');
    expect(isString(fs.get('F')!) && decodePdfText((fs.get('F') as any).bytes)).toBe('readme.txt');
    expect(isString(fs.get('UF')!) && decodePdfText((fs.get('UF') as any).bytes)).toBe('readme.txt');
    expect(isString(fs.get('Desc')!) && decodePdfText((fs.get('Desc') as any).bytes)).toBe('A readme');

    const ef = fs.get('EF') as Map<string, PdfObject>;
    const ref = ef.get('F')!;
    expect(isRef(ref)).toBe(true);
    expect(ef.get('UF')).toBe(ref); // same shared stream object

    const stream = objs[(ref as PdfRef).num - 1] as PdfStream;
    expect(isStream(stream)).toBe(true);
    expect((stream.dict.get('Type') as any).name).toBe('EmbeddedFile');
    expect((stream.dict.get('Subtype') as any).name).toBe('text/plain');
    expect((stream.dict.get('Filter') as any).name).toBe('FlateDecode');

    const params = stream.dict.get('Params') as Map<string, PdfObject>;
    expect(params.get('Size')).toBe(bytes.length);
    expect([...(params.get('CheckSum') as any).bytes]).toEqual([...md5(bytes)]);
    expect(isString(params.get('CreationDate')!)).toBe(true);
    expect(isString(params.get('ModDate')!)).toBe(true);

    expect([...inflateStream(stream)]).toEqual([...bytes]); // round-trips
  });

  it('stores raw bytes with no /Filter when compress is false', () => {
    const { objs, alloc } = fakeAlloc();
    const fs = buildFilespec(bytes, 'a.bin', { compress: false }, alloc);
    const ref = (fs.get('EF') as Map<string, PdfObject>).get('F') as PdfRef;
    const stream = objs[ref.num - 1] as PdfStream;
    expect(stream.dict.get('Filter')).toBeUndefined();
    expect([...stream.raw]).toEqual([...bytes]);
  });

  it('throws on an empty name', () => {
    const { alloc } = fakeAlloc();
    expect(() => buildFilespec(bytes, '', {}, alloc)).toThrow(RangeError);
  });
});

describe('reading embedded files', () => {
  it('reads a nested /EmbeddedFiles Kids tree into Attachment metadata', () => {
    const doc = Document.Open(buildEmbeddedFileTarget());
    const list = readAttachments(doc);
    expect(list.map((a) => a.Name)).toEqual(['readme.txt']);
    const a = list[0];
    expect(a.Description).toBe('A readme');
    expect(a.Size).toBe(16);
    expect(new TextDecoder().decode(a.GetBytes())).toBe('hello attachment');
  });
});

describe('Document attachment API', () => {
  const data = new TextEncoder().encode('payload-bytes');

  it('round-trips AddAttachment through Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    doc.AddAttachment('notes.txt', data, { description: 'my notes', mimeType: 'text/plain' });
    const re = Document.Open(doc.Save());
    const list = re.GetAttachments();
    expect(list.map((a) => a.Name)).toEqual(['notes.txt']);
    expect(list[0].Description).toBe('my notes');
    expect(list[0].MimeType).toBe('text/plain');
    expect(new TextDecoder().decode(list[0].GetBytes())).toBe('payload-bytes');
  });

  it('keeps existing entries when adding a second attachment', () => {
    const doc = Document.Open(buildBlankPage());
    doc.AddAttachment('a.txt', new TextEncoder().encode('A'), {});
    doc.AddAttachment('b.txt', new TextEncoder().encode('B'), {});
    const re = Document.Open(doc.Save());
    expect(re.GetAttachments().map((a) => a.Name)).toEqual(['a.txt', 'b.txt']);
  });

  it('upserts on duplicate name', () => {
    const doc = Document.Open(buildBlankPage());
    doc.AddAttachment('x.txt', new TextEncoder().encode('old'), {});
    doc.AddAttachment('x.txt', new TextEncoder().encode('new'), {});
    const list = Document.Open(doc.Save()).GetAttachments();
    expect(list).toHaveLength(1);
    expect(new TextDecoder().decode(list[0].GetBytes())).toBe('new');
  });

  it('removes an attachment and reports presence', () => {
    const doc = Document.Open(buildBlankPage());
    doc.AddAttachment('gone.txt', data, {});
    expect(doc.RemoveAttachment('gone.txt')).toBe(true);
    expect(doc.RemoveAttachment('gone.txt')).toBe(false);
    expect(Document.Open(doc.Save()).GetAttachments()).toEqual([]);
  });
});

describe('FileAttachment annotation', () => {
  const bytes = new TextEncoder().encode('annotated file');

  it('places a FileAttachment annotation and reads it back', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const a = page.AddFileAttachment({ rect: [10, 10, 30, 30], name: 'clip.txt', bytes, icon: 'Paperclip' });
    expect(a).toBeInstanceOf(FileAttachmentAnnotation);
    expect(a.Icon).toBe('Paperclip');
    expect(a.FileName).toBe('clip.txt');

    const re = Document.Open(doc.Save());
    const annots = re.Pages[0].Annotations; // getter, not a method
    const fa = annots.find((x) => x.Subtype === 'FileAttachment') as FileAttachmentAnnotation;
    expect(fa).toBeInstanceOf(FileAttachmentAnnotation);
    expect(fa.FileName).toBe('clip.txt');
    expect(new TextDecoder().decode(fa.GetBytes())).toBe('annotated file');
    // annotation-only by default → not in the catalog list
    expect(re.GetAttachments()).toEqual([]);
  });

  it('also lists in the catalog when addToCatalog is true', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddFileAttachment({ rect: [0, 0, 20, 20], name: 'both.txt', bytes, addToCatalog: true });
    const re = Document.Open(doc.Save());
    expect(re.GetAttachments().map((x) => x.Name)).toEqual(['both.txt']);
    expect(new TextDecoder().decode(re.GetAttachments()[0].GetBytes())).toBe('annotated file');
  });

  it('defaults the icon to PushPin', () => {
    const doc = Document.Open(buildBlankPage());
    const a = doc.Pages[0].AddFileAttachment({ rect: [0, 0, 20, 20], name: 'p.txt', bytes });
    expect(a.Icon).toBe('PushPin');
  });
});

describe('Attachment /CI custom fields', () => {
  const bytes = new TextEncoder().encode('field payload');

  it('AddAttachment returns a handle whose fields round-trip', () => {
    const doc = Document.Open(buildBlankPage());
    const att = doc.AddAttachment('data.bin', bytes, {});
    att.SetField('reviewer', 'Alice');
    att.SetField('revision', 3);
    const when = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
    att.SetField('approved', when);

    const re = Document.Open(doc.Save());
    const got = re.GetAttachments()[0];
    expect(got.GetField('reviewer')).toBe('Alice');
    expect(got.GetField('revision')).toBe(3);
    const d = got.GetField('approved');
    expect(d).toBeInstanceOf(Date);
    expect((d as Date).getTime()).toBe(when.getTime());
  });

  it('RemoveField drops the value and empty /CI', () => {
    const doc = Document.Open(buildBlankPage());
    const att = doc.AddAttachment('r.bin', bytes, {});
    att.SetField('only', 'x');
    att.RemoveField('only');
    const re = Document.Open(doc.Save());
    expect(re.GetAttachments()[0].GetField('only')).toBeUndefined();
  });

  it('SetField rejects unsupported value types and empty names', () => {
    const doc = Document.Open(buildBlankPage());
    const att = doc.AddAttachment('v.bin', bytes, {});
    expect(() => att.SetField('', 'x')).toThrow(RangeError);
    expect(() => att.SetField('k', {} as any)).toThrow(TypeError);
  });
});
