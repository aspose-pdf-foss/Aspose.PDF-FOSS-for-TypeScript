import { deflateSync } from 'node:zlib';
import {
  PdfDict, PdfObject, PdfRef, PdfStream, name,
  isArray, isDict, isName, isRef, isString, isStream,
} from './types.js';
import { decodePdfText, encodePdfText, formatPdfDate, parsePdfDate } from './metadata.js';
import { md5 } from './crypto.js';
import { inflateStream } from './flate.js';
import { collectNameTree, removeNameTreeEntry, upsertNameTreeEntry } from './nametree.js';
import { PdfParseError } from './errors.js';
import type { Document } from './document.js';

/** Options shared by document-level attachments and FileAttachment annotations. */
export interface AttachmentOptions {
  /** MIME type written to the embedded stream's /Subtype (e.g. 'application/pdf'). */
  mimeType?: string;
  /** Human-readable description written to the filespec's /Desc. */
  description?: string;
  /** Compress the bytes with FlateDecode on save. Default true. */
  compress?: boolean;
  /** /Params /CreationDate. Default: now. */
  creationDate?: Date;
  /** /Params /ModDate. Default: now. */
  modDate?: Date;
}

const pdfStr = (s: string): PdfObject => ({ kind: 'string', bytes: encodePdfText(s) });

/** Build a /Filespec dict over a freshly allocated /EmbeddedFile stream. The
 *  stream is allocated through `alloc` (its /EF /F and /UF share one object);
 *  the returned /Filespec is NOT allocated — the caller decides where it lives
 *  (name tree value and/or annotation /FS). The /CheckSum is the MD5 of the
 *  UNCOMPRESSED bytes. */
export function buildFilespec(
  bytes: Uint8Array, fileName: string, opts: AttachmentOptions,
  alloc: (o: PdfObject) => PdfRef,
): PdfDict {
  if (typeof fileName !== 'string' || fileName === '')
    throw new RangeError('attachment name must be a non-empty string');
  const compress = opts.compress ?? true;
  const body = compress ? new Uint8Array(deflateSync(Buffer.from(bytes))) : bytes;

  const params: PdfDict = new Map<string, PdfObject>();
  params.set('Size', bytes.length);
  params.set('CheckSum', { kind: 'string', bytes: md5(bytes) });
  params.set('CreationDate', pdfStr(formatPdfDate(opts.creationDate ?? new Date())));
  params.set('ModDate', pdfStr(formatPdfDate(opts.modDate ?? new Date())));

  const streamDict: PdfDict = new Map<string, PdfObject>();
  streamDict.set('Type', name('EmbeddedFile'));
  if (opts.mimeType) streamDict.set('Subtype', name(opts.mimeType));
  if (compress) streamDict.set('Filter', name('FlateDecode'));
  streamDict.set('Params', params);
  const stream: PdfStream = { kind: 'stream', dict: streamDict, raw: body };
  const efRef = alloc(stream);

  const fs: PdfDict = new Map<string, PdfObject>();
  fs.set('Type', name('Filespec'));
  fs.set('F', pdfStr(fileName));
  fs.set('UF', pdfStr(fileName));
  if (opts.description) fs.set('Desc', pdfStr(opts.description));
  fs.set('EF', new Map<string, PdfObject>([['F', efRef], ['UF', efRef]]));
  return fs;
}

/** The filespec's display name, preferring the Unicode /UF over /F. */
export function filespecName(doc: Document, fs: PdfDict): string {
  const uf = fs.get('UF');
  if (isString(uf)) return decodePdfText(uf.bytes);
  const f = fs.get('F');
  if (isString(f)) return decodePdfText(f.bytes);
  return '';
}

/** Decode the embedded bytes of a /Filespec, inflating FlateDecode if present. */
export function readFilespecBytes(doc: Document, fsObj: PdfObject): Uint8Array {
  const fs = doc.resolve(fsObj);
  if (!isDict(fs)) throw new PdfParseError('attachment: /Filespec is not a dictionary');
  const ef = doc.resolve(fs.get('EF'));
  if (!isDict(ef)) throw new PdfParseError('attachment: missing /EF');
  const stream = doc.resolve(ef.get('F') ?? ef.get('UF'));
  if (!isStream(stream)) throw new PdfParseError('attachment: /EF /F is not a stream');
  return stream.dict.get('Filter') === undefined ? stream.raw : inflateStream(stream);
}

/** Encode a /CI field value: string→PDF string, number→PDF number,
 *  Date→PDF date string. Throws on anything else. */
function encodeFieldValue(value: string | number | Date): PdfObject {
  if (value instanceof Date) return { kind: 'string', bytes: encodePdfText(formatPdfDate(value)) };
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return { kind: 'string', bytes: encodePdfText(value) };
  throw new TypeError('field value must be a string, number, or Date');
}

/** A live handle over one embedded file's /Filespec. Read accessors and
 *  GetBytes decode on demand; GetField/SetField manage the per-file /CI
 *  (CollectionItem) custom field values used by a /Collection portfolio. */
export class Attachment {
  constructor(
    private readonly doc: Document,
    /** The live /Filespec dict from the objects map. */
    readonly Dict: PdfDict,
    /** Name-tree key used when the filespec carries no /F or /UF. */
    private readonly fallbackName: string = '',
  ) {}

  get Name(): string { return filespecName(this.doc, this.Dict) || this.fallbackName; }

  get Description(): string | undefined {
    const d = this.Dict.get('Desc');
    return isString(d) ? decodePdfText(d.bytes) : undefined;
  }

  private embeddedStream(): PdfStream | undefined {
    const ef = this.doc.resolve(this.Dict.get('EF'));
    if (!isDict(ef)) return undefined;
    const s = this.doc.resolve(ef.get('F') ?? ef.get('UF'));
    return isStream(s) ? s : undefined;
  }

  get MimeType(): string | undefined {
    const sub = this.embeddedStream()?.dict.get('Subtype');
    return isName(sub) ? sub.name : undefined;
  }

  private params(): PdfDict | undefined {
    const s = this.embeddedStream();
    const p = s ? this.doc.resolve(s.dict.get('Params')) : undefined;
    return isDict(p) ? p : undefined;
  }

  get Size(): number | undefined {
    const v = this.params()?.get('Size');
    return typeof v === 'number' ? v : undefined;
  }

  get CreationDate(): Date | undefined { return this.paramDate('CreationDate'); }
  get ModDate(): Date | undefined { return this.paramDate('ModDate'); }

  private paramDate(key: string): Date | undefined {
    const v = this.params()?.get(key);
    if (isString(v)) { const d = parsePdfDate(decodePdfText(v.bytes)); if (d instanceof Date) return d; }
    return undefined;
  }

  /** Decode the embedded bytes, inflating FlateDecode if present. */
  GetBytes(): Uint8Array { return readFilespecBytes(this.doc, this.Dict); }

  /** Read a custom /CI field. number→number; a /CollectionSubitem is unwrapped
   *  to its /D; a string is returned as a Date when it parses as a PDF date,
   *  otherwise as the raw string. */
  GetField(field: string): string | number | Date | undefined {
    const ci = this.doc.resolve(this.Dict.get('CI'));
    if (!isDict(ci)) return undefined;
    let v = this.doc.resolve(ci.get(field));
    if (isDict(v)) v = this.doc.resolve(v.get('D')); // /CollectionSubitem
    if (typeof v === 'number') return v;
    if (isString(v)) { const d = parsePdfDate(decodePdfText(v.bytes)); return d instanceof Date ? d : decodePdfText(v.bytes); }
    return undefined;
  }

  /** Upsert a custom /CI field value. */
  SetField(field: string, value: string | number | Date): void {
    if (typeof field !== 'string' || field === '') throw new RangeError('field name must be a non-empty string');
    const encoded = encodeFieldValue(value); // validate before mutating
    let ci = this.doc.resolve(this.Dict.get('CI'));
    if (!isDict(ci)) { ci = new Map<string, PdfObject>([['Type', name('CollectionItem')]]); this.Dict.set('CI', ci); }
    ci.set(field, encoded);
    this.doc.markModified();
  }

  /** Remove a custom /CI field value, dropping /CI when only /Type remains. */
  RemoveField(field: string): void {
    const ci = this.doc.resolve(this.Dict.get('CI'));
    if (!isDict(ci)) return;
    if (ci.delete(field) && [...ci.keys()].every((k) => k === 'Type')) this.Dict.delete('CI');
    this.doc.markModified();
  }
}

/** Wrap a /Filespec in an Attachment handle, or undefined when not a dict. */
export function readFilespec(doc: Document, fsObj: PdfObject, fallbackName = ''): Attachment | undefined {
  const fs = doc.resolve(fsObj);
  if (!isDict(fs)) return undefined;
  return new Attachment(doc, fs, fallbackName);
}

/** All document-level embedded files from /Root /Names /EmbeddedFiles, sorted. */
export function readAttachments(doc: Document): Attachment[] {
  const names = doc.resolve(doc.catalog().get('Names'));
  if (!isDict(names)) return [];
  const collected: Array<[string, PdfObject]> = [];
  collectNameTree(doc, names.get('EmbeddedFiles') ?? null, collected);
  const out: Attachment[] = [];
  for (const [key, v] of collected) {
    const att = readFilespec(doc, v, key);
    if (att) out.push(att);
  }
  return out.sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0));
}

/** Add a filespec ref to the catalog's /AF associated-files array (PDF 2.0),
 *  creating it on first use and de-duplicating by object number. */
function addAssociatedFile(doc: Document, fsRef: PdfRef): void {
  const catalog = doc.catalog();
  let af = doc.resolve(catalog.get('AF'));
  if (!isArray(af)) { af = []; catalog.set('AF', af); }
  if (!af.some((r) => isRef(r) && r.num === fsRef.num)) af.push(fsRef);
}

/** Remove a filespec ref from /AF, dropping the array when it empties. */
function removeAssociatedFile(doc: Document, fsRef: PdfRef): void {
  const catalog = doc.catalog();
  const af = doc.resolve(catalog.get('AF'));
  if (!isArray(af)) return;
  const i = af.findIndex((r) => isRef(r) && r.num === fsRef.num);
  if (i >= 0) af.splice(i, 1);
  if (af.length === 0) catalog.delete('AF');
}

/** Upsert `key` → `fsRef` into /Root /Names /EmbeddedFiles (single flat node,
 *  no rebalancing) and register the filespec in /AF. */
export function upsertEmbeddedFile(doc: Document, key: string, fsRef: PdfRef): void {
  if (typeof key !== 'string' || key === '')
    throw new RangeError('attachment name must be a non-empty string');
  upsertNameTreeEntry(doc, 'EmbeddedFiles', key, fsRef);
  addAssociatedFile(doc, fsRef);
}

/** Remove `key` from /EmbeddedFiles (collapsing empty containers) and from /AF.
 *  Returns false when the name was absent. */
export function removeEmbeddedFile(doc: Document, key: string): boolean {
  const removed = removeNameTreeEntry(doc, 'EmbeddedFiles', key);
  if (removed === undefined) return false;
  if (isRef(removed)) removeAssociatedFile(doc, removed);
  return true;
}
