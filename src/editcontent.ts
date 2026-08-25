import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfStream, PdfRef, isArray, isDict, isStream, isRef } from './types.js';
import { ContentOp, parseContentStream, serializeContentStream } from './content.js';
import { streamOf, ensureOwnResources, ensureOwnSubdict } from './pagecontent.js';
import { inflateStream } from './flate.js';

/** Address of an operator within a page's content. */
export interface ContentAddr {
  /** XObject resource-name chain descended from the page; [] = top-level page content. */
  readonly path: readonly string[];
  /** Index into the page's /Contents array. Always 0 when path is non-empty (an XObject has one stream). */
  readonly streamIndex: number;
  /** Index of the operator within that parsed stream. */
  readonly opIndex: number;
}

/** The resolved stream objects of a page's /Contents, in order. */
function contentStreams(doc: Document, page: Page): PdfStream[] {
  const c = doc.resolve(page.Dict.get('Contents'));
  const out: PdfStream[] = [];
  if (isStream(c)) out.push(c);
  else if (isArray(c)) for (const e of c) { const s = doc.resolve(e); if (isStream(s)) out.push(s); }
  return out;
}

/** Editable per-stream view of a page's content (Phase 4 foundation, F1). */
export class EditableContent {
  private readonly doc: Document;
  private readonly page: Page;
  private readonly streams: PdfStream[];
  private readonly parsed: (ContentOp[] | undefined)[]; // lazily parsed per stream
  private readonly dirty = new Set<number>();
  // path.join('\0') -> the deepest clone's owning XObject subdict + name, its
  // dict (preserved across re-serialization), and its parsed/edited ops.
  private readonly xobj = new Map<string,
    { path: string[]; nm: string; dict: PdfDict; ops: ContentOp[]; dirty: boolean }>();

  constructor(doc: Document, page: Page) {
    this.doc = doc;
    this.page = page;
    this.streams = contentStreams(doc, page);
    this.parsed = new Array(this.streams.length).fill(undefined);
  }

  get streamCount(): number { return this.streams.length; }

  topOps(streamIndex: number): readonly ContentOp[] {
    const cached = this.parsed[streamIndex];
    if (cached) return cached;
    const s = this.streams[streamIndex];
    if (!s) throw new RangeError(`no content stream at index ${streamIndex}`);
    const ops = parseContentStream(inflateStream(s));
    this.parsed[streamIndex] = ops;
    return ops;
  }

  setTopOps(streamIndex: number, ops: ContentOp[]): void {
    if (streamIndex < 0 || streamIndex >= this.streams.length)
      throw new RangeError(`no content stream at index ${streamIndex}`);
    this.parsed[streamIndex] = ops.slice();
    this.dirty.add(streamIndex);
  }

  xobjectOps(path: readonly string[]): readonly ContentOp[] {
    return this.cowXObject(path).ops;
  }

  /** Paths of the Form XObjects copied-on-write so far (edited scopes). */
  editedXObjectPaths(): string[][] {
    return [...this.xobj.keys()].map((k) => k.split('\0'));
  }

  /** The COW'd /Resources dict of an edited XObject scope, or undefined when it
   *  has none of its own (inherits the parent's). Mutable and page-owned. */
  xobjectResources(path: readonly string[]): PdfDict | undefined {
    const e = this.xobj.get(path.join('\0'));
    if (!e) return undefined;
    const r = this.doc.resolve(e.dict.get('Resources'));
    return isDict(r) ? r : undefined;
  }

  /** Force the copy-on-write of the Form XObject at `path` and return its own
   *  /Resources, creating an empty one when the form has none.
   *
   *  `xobjectResources` reports what a COW'd scope already has and returns
   *  undefined otherwise; this is the write side. A caller that needs a form's
   *  resources copy-on-written WITHOUT rewriting its content stream (repointing
   *  an /XObject entry, say) has no other way to trigger the COW than calling
   *  `xobjectOps` for its side effect. The scope is left NOT dirty, so `commit`
   *  skips it — which is correct, because `cowXObject` has already repointed
   *  the parent entry at the clone by then. */
  ownXObjectResources(path: readonly string[]): PdfDict {
    const e = this.cowXObject(path);
    const r = this.doc.resolve(e.dict.get('Resources'));
    if (isDict(r)) return r;
    const fresh: PdfDict = new Map();
    e.dict.set('Resources', fresh);
    return fresh;
  }

  setXobjectOps(path: readonly string[], ops: ContentOp[]): void {
    const e = this.cowXObject(path);
    e.ops = ops.slice();
    e.dirty = true;
  }

  /** Clone each XObject along `path` (once), repointing the page's own resources,
   *  and return the deepest clone's parsed-op entry. */
  private cowXObject(path: readonly string[]):
      { path: string[]; nm: string; dict: PdfDict; ops: ContentOp[]; dirty: boolean } {
    const key = path.join('\0');
    const hit = this.xobj.get(key);
    if (hit) return hit;
    if (path.length === 0) throw new RangeError('xobjectOps requires a non-empty path');

    let resources: PdfDict = ensureOwnResources(this.doc, this.page);
    let clone: PdfStream | undefined;
    let lastNm = '';
    for (const nm of path) {
      const xobjDict = ensureOwnSubdict(this.doc, resources, 'XObject');
      const cur = this.doc.resolve(xobjDict.get(nm));
      if (!isStream(cur)) throw new RangeError(`XObject /${nm} not found`);
      // Clone the stream (dict copy + shared raw bytes) and repoint the resource name.
      const cloned: PdfStream = { kind: 'stream', dict: new Map(cur.dict), raw: cur.raw };
      xobjDict.set(nm, this.doc.allocObject(cloned));
      lastNm = nm;
      clone = cloned;
      const childRes = this.doc.resolve(cloned.dict.get('Resources'));
      if (isDict(childRes)) { const copy = new Map(childRes); cloned.dict.set('Resources', copy); resources = copy; }
      else resources = new Map();
    }
    const entry = {
      path: [...path], nm: lastNm, dict: clone!.dict,
      ops: parseContentStream(inflateStream(clone!)), dirty: false,
    };
    this.xobj.set(key, entry);
    return entry;
  }

  /** Re-resolve the XObject sub-dict that currently owns the clone at `path`,
   *  by walking the page's live resources. Done at commit time because resource
   *  sanitization may have replaced a sub-dict captured during the COW walk. */
  private ownerOf(path: readonly string[]): { ownerDict: PdfDict; nm: string } | undefined {
    let resources: PdfDict = ensureOwnResources(this.doc, this.page);
    for (let d = 0; d < path.length; d++) {
      const xobjDict = this.doc.resolve(resources.get('XObject'));
      if (!isDict(xobjDict)) return undefined;
      if (d === path.length - 1) return { ownerDict: xobjDict, nm: path[d] };
      const child = this.doc.resolve(xobjDict.get(path[d]));
      if (!isStream(child)) return undefined;
      const childRes = this.doc.resolve(child.dict.get('Resources'));
      resources = isDict(childRes) ? childRes : new Map();
    }
    return undefined;
  }

  /** Write modified streams back into fresh page-owned stream objects. */
  commit(): void {
    // Flush copy-on-written XObject streams: repoint each owner to a fresh,
    // uncompressed clone carrying the edited ops (PdfStream.raw is immutable).
    for (const e of this.xobj.values()) {
      if (!e.dirty) continue;
      const raw = serializeContentStream(e.ops);
      const dict: PdfDict = new Map(e.dict);
      dict.delete('Filter');                 // we wrote raw (uncompressed) bytes
      dict.set('Length', raw.length);
      const stream: PdfStream = { kind: 'stream', dict, raw };
      const owner = this.ownerOf(e.path);
      if (owner) owner.ownerDict.set(owner.nm, this.doc.allocObject(stream));
      e.dirty = false;
    }
    // Flush top-level streams.
    if (this.dirty.size > 0) {
      const refs = this.contentRefs();
      for (const i of this.dirty) {
        const bytes = serializeContentStream(this.parsed[i]!);
        refs[i] = this.doc.allocObject(streamOf(bytes)); // fresh page-owned object
      }
      this.page.Dict.set('Contents', refs);
      this.dirty.clear();
    }
  }

  /** Current /Contents as a stream-ref array aligned with `this.streams`. */
  private contentRefs(): PdfRef[] {
    const c = this.page.Dict.get('Contents');
    const out: PdfRef[] = [];
    if (isRef(c)) out.push(c);
    else if (isArray(c)) for (const e of c) if (isRef(e)) out.push(e);
    return out;
  }
}
