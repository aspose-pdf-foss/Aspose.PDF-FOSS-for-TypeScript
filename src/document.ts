import { Lexer } from './lexer.js';
import { ObjectParser } from './object-parser.js';
import { readXref, XrefEntry, PdfRevision } from './xref.js';
import { sweepObjects, ObjCandidate, SweepResult } from './recover.js';
import {
  expandObjectStreams, findEncryptDict, rebuildTrailer, TrailerChoice,
} from './rebuild.js';
import { decodeObjStm, ObjStmDamage } from './objstm.js';
import { PdfObject, PdfDict, PdfRef, PdfStream, isRef, isDict, isStream, isName, isArray, isString, ref, name } from './types.js';
import { PdfParseError, UnsupportedFeatureError, InvalidPasswordError } from './errors.js';
import { Metadata, MetadataUpdate, readMetadata, applyUpdate, decodePdfText, encodePdfText } from './metadata.js';
import { StructTreeRoot } from './struct.js';
import { renderDocumentToHtml, HtmlOptions } from './html.js';
import { renderDocumentToDocx, type DocxOptions } from './docxexport.js';
import { renderEpub, type EpubOptions } from './epubexport.js';
import { renderDocumentToTiff, type TiffExportOptions } from './raster.js';
import { addImagePages, type AddImagePagesOptions, type AddImagePagesResult } from './imagepages.js';
import {
  renderDocumentToMarkdown, renderDocumentToMarkdownAssets,
  type MarkdownExportOptions, type MarkdownExportResult,
} from './mdexport.js';
import { validatePdfUa, ValidationReport } from './structvalidate.js';
import { validatePdfA, type PdfALevel } from './pdfavalidate.js';
import { convertToPdfA, type ConvertOptions, type ConversionReport } from './pdfaconvert.js';
import { convertToPdfUa, type PdfUaConvertOptions } from './pdfuaconvert.js';
import { validatePdfX, type PdfXLevel } from './pdfxvalidate.js';
import { convertToPdfX, type PdfXConvertOptions } from './pdfxconvert.js';
import { ensureStructTree } from './structwrite.js';
import { autoTag, type AutoTagOptions, type AutoTagReport } from './autotag.js';
import { inflateStream } from './flate.js';
import { readXmp, buildXmp, mergeXmp, mirrorMetaToXmp, mirrorXmpToMeta, XmpMetadata, XmpUpdate } from './xmp.js';
import { Page } from './page.js';
import { stitchTables, type TableStitchOptions } from './tablestitch.js';
import type { Table, TableExtractOptions } from './tablemodel.js';
import type { Rect } from './text.js';
import type { RedactOptions } from './redact.js';
import type { ApplyRedactionsOptions, MarkRedactTextOptions } from './redactapply.js';
import { flattenForm } from './flatten.js';
import { optimizeDocument, OptimizeOptions, OptimizeReport } from './optimize.js';
import { convertToGrayscale, GrayscaleOptions, GrayscaleReport } from './grayconvert.js';
import { Form } from './form.js';
import { appendField, attachWidget, ensureAcroForm } from './formcreate.js';
import {
  collectFormData, applyFormData,
  type ExportFormDataOptions, type ImportOptions, type ImportReport,
} from './formdata.js';
import { readFdf, writeFdf } from './fdf.js';
import { readXfdf, writeXfdf } from './xfdf.js';
import { OptionalContent } from './ocg.js';
import { buildPages, PageTree } from './pagetree.js';
import {
  OutlineItem, PageDest, readOutlineTree, buildOutlineObjects, validateOutlineItems,
  NamedDestination, readNamedDestinations, encodeDest,
} from './outline.js';
import { removeNameTreeEntry, upsertNameTreeEntry } from './nametree.js';
import type { PdfAction } from './actions.js';
import {
  OpenAction, readOpenAction, removeOpenAction, setOpenAction, setOpenDestination,
  DocumentJavaScript, readDocumentJavaScripts, removeDocumentJavaScript,
  setDocumentJavaScript,
} from './docaction.js';
import {
  AttachmentOptions, Attachment, buildFilespec, readAttachments,
  upsertEmbeddedFile, removeEmbeddedFile,
} from './embeddedfile.js';
import {
  CollectionSettings, buildCollection, readCollection,
} from './collection.js';
import { PageLabel, parsePageLabels, buildPageLabels, resolvePageLabel } from './pagelabels.js';
import { extractPage, defaultPrunePolicy, PrunePolicy, cloneShallow, rewriteRefs } from './extractor.js';
import { preserveStructure, PageOrigin } from './structpreserve.js';
import { overlay, OverlayOptions, placeFitted, resolveNUpBorder, NUpOptions } from './compose.js';
import { PageGraphics, buildTilingPattern, type VectorGraphics } from './graphics.js';
import { Template } from './template.js';
import type {
  TilingPattern, TilingPatternOptions,
  ColoredTilingPattern, UncoloredTilingPattern,
} from './tiling.js';
import { bookletSides, bookletCells, type BookletOptions, type BookletMetrics } from './booklet.js';
import {
  addWatermark, addHeaderFooter, addBatesNumbering,
  type WatermarkOptions, type HeaderFooterOptions, type BatesOptions,
} from './decorate.js';
import { serializeDocument, serializeSignedDocument, SerializeOptions } from './serializer.js';
import { appendSignatureUpdate, appendIncrementalUpdate } from './incremental.js';
import { diffObjects } from './incrementaldelta.js';
import { DEFAULT_PLACEHOLDER_BYTES, fillSignature } from './sigplaceholder.js';
import { buildTimeStampRequest, extractTimeStampToken, type TimestampProvider } from './rfc3161.js';
import { Flow, type FlowOptions } from './flow.js';
import type { MarkdownFlowOptions } from './mdflow.js';
import { documentTitle, type HtmlFlowOptions } from './htmlflow.js';
import { parseHtml } from './htmltree.js';
import type { HtmlDocument } from './htmldom.js';
import type { UnsupportedDeclaration } from './cssprop.js';
import type { NotRendered } from './htmlreport.js';
import type { MdDocument } from './mdast.js';
import { FloatingBox, type FloatBoxOptions } from './floatbox.js';
import { PageFormat } from './pageformat.js';
import type { DigestAlgorithm } from './sigalg.js';
import { buildSignedData, CmsSigner, commitmentTypeOid } from './cms.js';
import { Signer, resolveSigner } from './signer.js';
import {
  SignOptions, CertifyOptions, DocMdpPermission, SignatureField,
  buildSigValueDict, buildDocMdpReference, subFilterName,
  digestByteRange, digestName, derTotalLength, pdfString,
  buildDocTimeStampDict, DocumentTimestampOptions,
} from './signature.js';
import {
  buildSignatureAppearance, defaultAppearanceText, signerDisplayName,
} from './sigappearance.js';
import {
  SignatureReport, VerifyOptions, RevocationFetcher,
  verifySignature, checkSignatureRevocation,
  DocumentTimestampReport, verifyDocumentTimestamp,
} from './sigverify.js';
import { parseSignedData } from './cms.js';
import { findIssuer } from './revocation.js';
import {
  docMdpVerdict, readDocMdpLevel, type DocMdpDoc, type DocMdpEnv,
} from './docmdp.js';
import {
  buildDss, readDssMaterial, readDssCerts, vriKey, dedupBlobs,
  type DssEntry, type ValidationDataOptions,
} from './dss.js';
import { buildDecryptor, Decryptor, CryptKeys } from './crypto.js';
import { buildPubSecDecryptor } from './pubsec.js';
import { parsePkcs12 } from './pkcs12.js';
import { Permissions, permissionsFromP, Encryptor, buildEncryptorFromKeys } from './encrypt.js';
import { X509Certificate, KeyObject } from 'node:crypto';
import { parseSfnt } from './sfnt.js';
import { EmbeddedFont } from './embeddedfont.js';
import { buildEmbeddedFont } from './fontembed.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { systemFontFolders, indexFolder, type FaceRecord } from './fontsource.js';
import {
  matchChain, deriveStyle, clampWeight,
  type LoadFontOptions, type FontMatch, type FontFamily,
} from './fontmatch.js';

/** True when `meta` carries at least one known (non-raw) XMP field. */
function hasXmpField(meta: XmpMetadata): boolean {
  return Object.entries(meta).some(([k, v]) => k !== 'raw' && v !== undefined);
}

export interface SplitOptions {
  /** Pruning policy applied while extracting each page's object graph. */
  prunePolicy?: PrunePolicy;
  /** Preserve the source's tagged structure tree (default true). */
  preserveStructure?: boolean;
}

export interface ExtractPagesOptions {
  /** Preserve the source's tagged structure tree (default true). */
  preserveStructure?: boolean;
}

export interface InsertPagesOptions {
  /** Preserve the source's tagged structure tree (default true). */
  preserveStructure?: boolean;
}

export interface AddFontOptions {
  /** Shape complex text (bidi/RTL, Arabic joining, GSUB/GPOS) by default when
   *  drawing with this font. Overridable per {@link Page.AddText} call. Default
   *  false — 1:1 glyph mapping, byte-identical to the non-shaped path. */
  shape?: boolean;
  /** Which face to take from a `.ttc`/`.otc` collection. Default 0, and
   *  ignored for a plain font -- a caller may not know which it was handed. */
  faceIndex?: number;
}

export type PubSecRecipient =
  | { pkcs12: Uint8Array; passphrase?: string }
  | { privateKey: KeyObject; certificate: string | Uint8Array };

export interface OpenOptions {
  /** Password for a standard-handler document; defaults to the empty user password. */
  password?: string;
  /** Recipient credential for a public-key (PubSec) document. */
  recipient?: PubSecRecipient;
}

/** True when the file ends with a startxref whose value is a plausible offset
 *  into it. Used only to classify *why* readXref failed — a pointer that is
 *  absent, malformed or out of range is a different fault from one that pointed
 *  somewhere real at an xref that would not parse. */
function startxrefIsUsable(buf: Uint8Array): boolean {
  const tail = new TextDecoder('latin1').decode(buf.subarray(Math.max(0, buf.length - 2048)));
  const i = tail.lastIndexOf('startxref');
  if (i < 0) return false;
  const m = /startxref\s+(\d+)/.exec(tail.slice(i));
  if (!m) return false;
  const at = parseInt(m[1], 10);
  return at > 0 && at < buf.length;
}

/** What trailer synthesis chose, when {@link Document.Open} had to rebuild a
 *  trailer that no longer existed anywhere in the file. */
export type { TrailerChoice } from './rebuild.js';

/** How {@link Document.Open} obtained its cross-reference data. Absent on a
 *  clean parse; present when the file was damaged and had to be recovered. */
export interface RecoveryReport {
  reason: 'startxref-unreadable' | 'xref-unparsable'
        | 'object-parse-failure' | 'root-not-catalog'
        | 'objstm-undecodable';
  /** e.g. 'startxref pointed at offset 91234, past end of file' */
  detail: string;
  /** Objects whose offset came from the sweep rather than the xref. */
  repaired: number[];
  /** Objects that never parsed; null in the model. Carries both a failed parse
   *  and an object a damaged /ObjStm declared but did not produce. */
  lost: number[];
  /** Present only when no trailer survived and one was rebuilt from the
   *  objects; describes what synthesis chose. */
  trailer?: TrailerChoice;
  /** Present when any /ObjStm container decoded only partially; one record per
   *  damaged container. This is the one loss recovery cannot backfill — an
   *  object inside a container exists nowhere else in the file. */
  objectStreams?: ObjStmDamage[];
}

/** One object-building pass over an entry map, from {@link Document.build}. */
interface BuildResult {
  objects: Map<number, PdfObject>;
  /** The key and `/Encrypt` dict this document was decrypted with, so a save
   *  can write it encrypted again. Absent for a plaintext document. */
  preserved?: { keys: CryptKeys; encryptDict: PdfDict };
  /** Object numbers whose parse threw, after any fallback candidates. Still
   *  fatal on a structurally sound file — see the rethrow in Open. */
  failed: Set<number>;
  /** Object numbers a damaged /ObjStm declared but did not produce. Reported,
   *  never fatal: an object inside a container has no `N G obj` header, so the
   *  sweep can never find it and there is no repair that failed. */
  lostInObjStm: Set<number>;
  /** Per-container damage records, in container order. */
  objStmDamage: ObjStmDamage[];
  /** Object numbers whose offset came from the sweep rather than the xref. */
  repaired: number[];
  permissions: Permissions | undefined;
}

/** Resolve an OpenOptions.recipient into a private key + DER certificate. */
function normalizeRecipient(recipient: PubSecRecipient): { privateKey: KeyObject; certificate: Uint8Array } {
  if ('pkcs12' in recipient) {
    const { privateKey, certificates } = parsePkcs12(recipient.pkcs12, recipient.passphrase ?? '');
    return { privateKey, certificate: certificates[0] };
  }
  const certificate = new Uint8Array(new X509Certificate(
    typeof recipient.certificate === 'string'
      ? recipient.certificate : Buffer.from(recipient.certificate)).raw);
  return { privateKey: recipient.privateKey, certificate };
}

/** Options for Save/WriteTo. */
export type SaveOptions = SerializeOptions;

/** Wrap a renumbered single-page object set in a /Pages node + /Catalog.
 *  Returns the full object set and the catalog's object number (the /Root). */
function assembleSinglePageDoc(
  objects: Map<number, PdfObject>, pageObjNum: number,
): { objects: Map<number, PdfObject>; rootNum: number } {
  const maxExisting = Math.max(...objects.keys());
  const pagesNum = maxExisting + 1;
  const catalogNum = maxExisting + 2;
  const page = objects.get(pageObjNum);
  if (isDict(page)) page.set('Parent', ref(pagesNum));
  const pagesNode: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Pages')],
    ['Count', 1],
    ['Kids', [ref(pageObjNum)]],
  ]);
  const catalog: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Catalog')],
    ['Pages', ref(pagesNum)],
  ]);
  const all = new Map(objects);
  all.set(pagesNum, pagesNode);
  all.set(catalogNum, catalog);
  return { objects: all, rootNum: catalogNum };
}

/** Add `offset` to every PdfRef nested in container `o` (mutates `o` in place). */
function offsetRefs(o: PdfObject, offset: number): void {
  if (isArray(o)) {
    for (let i = 0; i < o.length; i++) {
      const v = o[i];
      if (isRef(v)) o[i] = ref(v.num + offset, v.gen);
      else offsetRefs(v, offset);
    }
  } else if (isDict(o)) {
    for (const [k, v] of o) {
      if (isRef(v)) o.set(k, ref(v.num + offset, v.gen));
      else offsetRefs(v, offset);
    }
  } else if (isStream(o)) {
    for (const [k, v] of o.dict) {
      if (isRef(v)) o.dict.set(k, ref(v.num + offset, v.gen));
      else offsetRefs(v, offset);
    }
  }
}

/** First ancestor value of `key` up `src`'s /Parent chain in `doc` (raw, not
 *  resolved); null if none. Cycle-guarded. Does not read `src` itself. */
function inheritedValue(doc: Document, src: PdfDict, key: string): PdfObject {
  let node: PdfObject = doc.resolve(src.get('Parent'));
  const seen = new Set<PdfDict>();
  while (isDict(node)) {
    if (seen.has(node)) break;
    seen.add(node);
    if (node.has(key)) return node.get(key)!;
    node = doc.resolve(node.get('Parent'));
  }
  return null;
}

export class Document {
  /** One Page per page, in document order. Populated by the constructor. */
  readonly Pages: Page[];
  /** Object number backing each Pages slot (parallel to Pages). */
  private pageObjNums: number[];
  /** Object number of the root /Pages node, or undefined when /Pages is inline. */
  private readonly rootPagesNum: number | undefined;
  /** Fonts registered via AddFont, subset and embedded by the Save finalize pass. */
  private readonly embeddedFonts: EmbeddedFont[] = [];
  /** Folders to search for LoadFontByName, in registration order. */
  private readonly fontFolders: { dir: string; sniff: boolean }[] = [];
  /** Fonts already loaded by name, keyed by `path#faceIndex` so that one family
   *  drawn twice is embedded once -- and so that two faces of one collection,
   *  which share a path, do not collide. */
  private readonly fontsByPath = new Map<string, EmbeddedFont>();
  /** The bytes this document was opened from (absent when authored in memory).
   *  Required as the base for incremental-update (append) signing. */
  private originalBytes?: Uint8Array;
  /** The options `Open` was called with, retained so an incremental save can
   *  re-parse `originalBytes` into a pristine baseline. The password is the
   *  reason this is kept rather than re-derived: `build()` constructs its
   *  `Decryptor` locally and discards it. */
  private openOptions: OpenOptions = {};
  /** An Encryptor over the key and `/Encrypt` dict this document was opened
   *  with, so `Save` writes it encrypted again rather than silently in the
   *  clear. Absent for a plaintext document, which is what keeps an
   *  unencrypted save byte-identical. */
  private preservedEncryptor?: Encryptor;
  /** Set once the in-memory model diverges from `originalBytes` (any mutation
   *  through a tracked entry point), forcing sign-on-save instead of append. */
  private modified = false;
  /** The finished signed byte image cached by {@link Sign}; returned verbatim by
   *  {@link Save}/{@link WriteTo} so the signed bytes are never re-serialized. */
  private pendingSignedBytes?: Uint8Array;
  /** Set once this session produced signed bytes, and NEVER cleared -- unlike
   *  `pendingSignedBytes`, which `markModified` clears. From that moment the
   *  live model is permanently behind the bytes for the signature object, so an
   *  incremental save is unsafe whether or not anything was edited after. */
  private signedInSession = false;
  /** Revisions the `/Prev` chain named on open, oldest first — exactly what
   *  `readXref` could read, and empty when it could not read anything.
   *
   *  So it is empty for a document authored in memory and for one whose
   *  cross-reference structure had to be rebuilt, where the chain IS the
   *  structure that could not be read: an empty list says "we do not know"
   *  rather than "exactly one". A document recovered only at the OBJECT level
   *  keeps its revisions, because there the xref chain was read fine and it is
   *  individual objects that were damaged. */
  private revisions: PdfRevision[] = [];
  /** Access permissions recovered from an encrypted document (undefined when the
   *  document is not encrypted). Surfaced for the caller; not enforced. */
  private permissions?: Permissions;
  get Permissions(): Permissions | undefined { return this.permissions; }

  /** Every revision this file carries, OLDEST FIRST, so the index is the
   *  revision number and `[0]` is the document as originally written.
   *
   *  Each revision appends to the one before it, so `length` grows
   *  monotonically and `bytes.subarray(0, rev.length)` is that revision's
   *  complete document — which is how an earlier state is recovered, and how a
   *  signature's `/ByteRange` is checked against the revision it covers.
   *
   *  Empty when there is nothing to report: a document authored in memory, or
   *  one whose cross-reference structure had to be rebuilt. That is
   *  deliberately distinguishable from the single-entry list a clean,
   *  never-updated file yields. */
  get Revisions(): readonly PdfRevision[] { return this.revisions; }

  /** True when this file carries more than one revision, i.e. it was appended
   *  to after it was first written. False for an unknown chain, since an
   *  unreadable structure is not evidence of an update. */
  get hasIncrementalUpdates(): boolean { return this.revisions.length > 1; }
  /** Set when Open had to recover from a damaged cross-reference structure;
   *  undefined after a clean parse. */
  recovery?: RecoveryReport;

  private constructor(
    /** Every indirect object, eagerly parsed and live-mutable. */
    private readonly objects: Map<number, PdfObject>,
    readonly trailer: PdfDict,
  ) {
    const tree: PageTree = buildPages(this);
    this.Pages = tree.pages;
    this.pageObjNums = tree.pageObjNums;
    this.rootPagesNum = tree.rootPagesNum;
  }

  /** Extract tables from every page and stitch continuations across page
   *  boundaries into single logical tables. Pass `{ stitch: false }` for the
   *  flat per-page list. See `Page.GetTables` for per-page extraction. */
  GetTables(options?: TableExtractOptions & TableStitchOptions): Table[] {
    return stitchTables(this.Pages.map((p) => p.GetTables(options)), options);
  }

  /** Build an in-memory document from a complete object set rooted at `rootNum`. */
  private static fromObjects(objects: Map<number, PdfObject>, rootNum: number): Document {
    const trailer: PdfDict = new Map<string, PdfObject>([['Root', ref(rootNum)]]);
    return new Document(objects, trailer);
  }

  /** Create a new document from scratch: zero pages when `format` is omitted, or
   *  one blank page of that size when given. The counterpart to
   *  {@link Document.Open} for callers that generate a PDF rather than edit one
   *  — add pages with {@link Document.AddPage} and write to them with the
   *  `Page.Add*` authoring API, then {@link Document.Save}. */
  static New(format?: PageFormat): Document {
    if (format !== undefined && !(format instanceof PageFormat))
      throw new TypeError('Document.New: format must be a PageFormat');
    const doc = Document.createEmptyDocument();
    if (format !== undefined) doc.AddPage(format);
    return doc;
  }

  /** Build an empty document: a /Catalog (obj 1) plus an empty indirect /Pages
   *  root (obj 2). Shared by {@link Document.New} and Merge's accumulator. */
  private static createEmptyDocument(): Document {
    const objects = new Map<number, PdfObject>();
    const pagesRoot: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Pages')],
      ['Kids', []],
      ['Count', 0],
    ]);
    const catalog: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Catalog')],
      ['Pages', ref(2)],
    ]);
    objects.set(1, catalog);
    objects.set(2, pagesRoot);
    return Document.fromObjects(objects, 1);
  }

  /** Split into one new single-page Document per page, in page order. */
  Split(options: SplitOptions = {}): Document[] {
    const policy = options.prunePolicy ?? defaultPrunePolicy();
    const preserve = options.preserveStructure ?? true;
    return this.Pages.map((page, i) => {
      const { objects, pageNum } = extractPage(this, page.Dict, policy);
      const { objects: full, rootNum } = assembleSinglePageDoc(objects, pageNum);
      const out = Document.fromObjects(full, rootNum);
      if (preserve) preserveStructure(out, [{ srcDoc: this, srcPageNum: this.pageObjNums[i], newPageNum: pageNum }]);
      return out;
    });
  }

  /** Copy the given 1-based pages into a new self-contained Document, in the
   *  order given (repeats allowed, like Reorder). Shared resources are copied
   *  once — so repeated copies of the same page share their content streams —
   *  and inherited page attributes are flattened onto each page. Throws
   *  RangeError on an empty array or any non-integer/out-of-range entry. This
   *  document is not modified. */
  ExtractPages(numbers: number[], options: ExtractPagesOptions = {}): Document {
    const n = this.Pages.length;
    if (numbers.length === 0) throw new RangeError('ExtractPages: numbers must not be empty');
    for (const o of numbers)
      if (!Number.isInteger(o) || o < 1 || o > n)
        throw new RangeError(`ExtractPages: page number ${o} out of range 1..${n}`);
    const out = Document.createEmptyDocument();
    const selected = numbers.map((num) => this.Pages[num - 1]);
    const newNums = out.importPages(this, out.requireIndirectPagesRoot(), selected);
    out.syncPages(newNums.map((num) => ref(num)));
    if (options.preserveStructure ?? true) {
      const origins: PageOrigin[] = newNums.map((newNum, i) => ({
        srcDoc: this, srcPageNum: this.pageObjNums[selected[i].Number - 1], newPageNum: newNum,
      }));
      preserveStructure(out, origins);
    }
    return out;
  }

  /** Rearrange pages: new page i = old page order[i-1] (1-based). Repeats and
   *  omissions are allowed (omitted pages are dropped, not appended). Throws
   *  RangeError on empty, non-integer, or out-of-range input. Takes effect in
   *  Pages immediately and in Save() output. */
  Reorder(order: number[]): void {
    const n = this.Pages.length;
    if (order.length === 0) throw new RangeError('Reorder: order must not be empty');
    for (const o of order)
      if (!Number.isInteger(o) || o < 1 || o > n)
        throw new RangeError(`Reorder: page number ${o} out of range 1..${n}`);

    if (this.rootPagesNum === undefined)
      throw new UnsupportedFeatureError('cannot reorder: /Pages is not an indirect reference');
    const rootNum = this.rootPagesNum;
    for (const num of this.pageObjNums)
      if (num === 0) throw new UnsupportedFeatureError('cannot reorder: a page is not an indirect object');

    const srcNums = this.pageObjNums.slice();
    const kids: PdfObject[] = [];
    const used = new Set<number>();
    let maxObjNum = this.maxObjNum();

    for (const o of order) {
      let num = srcNums[o - 1];
      if (used.has(num)) {
        // Repeated page: clone the live dict into a fresh object.
        const src = this.objects.get(num);
        const clone: PdfDict = isDict(src) ? new Map(src) : new Map<string, PdfObject>();
        num = ++maxObjNum;
        this.objects.set(num, clone);
      }
      used.add(num);
      const pageDict = this.objects.get(num);
      if (isDict(pageDict)) {
        pageDict.set('Parent', ref(rootNum));
        if (!pageDict.has('Type')) pageDict.set('Type', name('Page'));
      }
      kids.push(ref(num));
    }

    this.syncPages(kids);
  }

  static Open(buf: Uint8Array, opts: OpenOptions = {}): Document {
    let entries = new Map<number, XrefEntry>();
    let trailer: PdfDict | undefined;
    let xrefFailure: RecoveryReport | undefined;
    let revisions: PdfRevision[] = [];
    try {
      const r = readXref(buf);
      entries = r.entries;
      trailer = r.trailer;
      revisions = r.revisions;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      // Classify by what is actually wrong, not by the message text: if the
      // startxref pointer is missing, malformed or out of range, the pointer is
      // the fault; otherwise it pointed somewhere real and the xref there broke.
      xrefFailure = {
        reason: startxrefIsUsable(buf) ? 'xref-unparsable' : 'startxref-unreadable',
        detail, repaired: [], lost: [],
      };
    }

    // Nothing to merge with: the cross-reference structure is gone, so both the
    // entry map and the trailer come from the sweep. This is the lossy case —
    // objects inside an /ObjStm carry no `N G obj` header and cannot be found.
    if (xrefFailure) {
      const sweep = sweepObjects(buf);
      // dxfk.1's first message, preserved: "nothing in the file" and "objects
      // but no catalog" mean very different things to a caller.
      if (sweep.candidates.size === 0) throw new PdfParseError('no indirect objects found');
      const merged = new Map<number, XrefEntry>();
      for (const [num, list] of sweep.candidates) {
        const c = list[list.length - 1];
        merged.set(num, { type: 'offset', offset: c.offset, gen: c.gen });
      }
      // A surviving trailer always wins; synthesis runs only when there is none.
      const existing = Document.recoverTrailer(buf, sweep, merged);
      // With no trailer there is no /Encrypt reference and no /ID. The dict is
      // findable by shape; /ID is not findable at all, and whether that is fatal
      // depends on the handler: R>=5 (AES-256) and PubSec derive their key
      // without it, R<=4 hashes it into the key and cannot.
      let encrypt: { num: number; dict: PdfDict } | undefined;
      if (!existing) {
        encrypt = findEncryptDict(merged, (n) => {
          const e = merged.get(n);
          if (!e || e.type !== 'offset') return null;
          return new ObjectParser(new Lexer(buf, e.offset)).parseIndirectObject().value;
        });
        const filter = encrypt?.dict.get('Filter');
        const R = encrypt?.dict.get('R');
        if (isName(filter) && filter.name === 'Standard' && typeof R === 'number' && R <= 4) {
          throw new PdfParseError(
            `cannot recover an encrypted document (revision ${R}): /ID was lost with `
            + 'the trailer and is required to derive the file key',
          );
        }
      }
      // The trailer's only role inside build() is /Encrypt and /ID, so a
      // provisional carrying just /Encrypt is enough to parse the whole document
      // and assemble the real trailer afterwards from what that one pass produced.
      const provisional: PdfDict = existing ?? new Map<string, PdfObject>();
      if (encrypt) provisional.set('Encrypt', ref(encrypt.num));
      const pass = Document.build(buf, merged, provisional, opts, sweep.candidates);
      let recovered = existing;
      if (!recovered) {
        const rebuilt = rebuildTrailer(pass.objects, merged, encrypt);
        recovered = rebuilt.trailer;
        xrefFailure.trailer = rebuilt.chosen;
      }
      xrefFailure.repaired = [...merged.keys()];
      xrefFailure.lost = [...pass.failed, ...pass.lostInObjStm];
      if (pass.objStmDamage.length > 0) xrefFailure.objectStreams = pass.objStmDamage;
      const doc = new Document(pass.objects, recovered);
      doc.originalBytes = buf;
      doc.openOptions = opts;
      doc.revisions = revisions;
      if (pass.preserved)
        doc.preservedEncryptor = buildEncryptorFromKeys(pass.preserved.keys, pass.preserved.encryptDict);
      doc.permissions = pass.permissions;
      doc.recovery = xrefFailure;
      return doc;
    }
    // Unreachable: readXref either threw (handled above) or produced a trailer.
    if (!trailer) throw new PdfParseError('no trailer found');

    let pass = Document.build(buf, entries, trailer, opts, undefined);

    // Three damage signals reachable from here: an object that would not parse
    // at the offset the xref gave, a /Root that is not a catalog (a byte shift
    // that happened to land on a valid but wrong object), or an /ObjStm that
    // decoded only partially.
    let report: RecoveryReport | undefined;
    if (pass.failed.size > 0) {
      report = {
        reason: 'object-parse-failure',
        detail: `object ${[...pass.failed][0]} could not be parsed at its xref offset`,
        repaired: [], lost: [],
      };
    } else if (!Document.rootIsCatalog(pass.objects, trailer)) {
      report = {
        reason: 'root-not-catalog',
        detail: 'the trailer /Root did not resolve to a /Type /Catalog',
        repaired: [], lost: [],
      };
    } else if (pass.objStmDamage.length > 0) {
      const d = pass.objStmDamage[0];
      report = {
        reason: 'objstm-undecodable',
        detail: `object stream ${d.container} decoded ${d.recovered.length} of `
          + `${d.recovered.length + d.lost.length} objects`,
        repaired: [], lost: [],
      };
    }

    // A damaged container is the one signal the sweep cannot answer: an object
    // inside an /ObjStm has no `N G obj` header, so there is nothing to find.
    // Sweeping anyway would be pure cost on a file whose xref read cleanly.
    if (report && report.reason !== 'objstm-undecodable') {
      const sweep = sweepObjects(buf);
      // Merge, never replace: entries the xref already had — including every
      // `compressed` one, which a sweep can never find — are kept, and swept
      // offsets fill only the gaps.
      const merged = new Map(entries);
      for (const [num, list] of sweep.candidates) {
        if (!merged.has(num)) {
          const c = list[list.length - 1];
          merged.set(num, { type: 'offset', offset: c.offset, gen: c.gen });
        }
      }
      pass = Document.build(buf, merged, trailer, opts, sweep.candidates);
      report.repaired = pass.repaired;
      // Strictness: reaching here means readXref succeeded, and the reason being
      // `object-parse-failure` means /Root resolved to a catalog (otherwise the
      // reason would be `root-not-catalog`). So the document is structurally
      // sound and an object that still will not parse is a genuine error —
      // exactly as before this feature existed. The sweep was a repair attempt,
      // not a licence to degrade. Only an already-damaged file degrades to null.
      //
      // `lostInObjStm` is deliberately not consulted here: an object inside a
      // container never had a repair to fail, so the rule this guard states does
      // not reach it. That is the whole of dxfk.3's exemption.
      //
      // Testing `rootIsCatalog` again here would be dead code: a document whose
      // /Root is not a catalog fails in the Document constructor regardless, so
      // the condition can never change the outcome. Verified by mutation.
      if (pass.failed.size > 0 && report.reason === 'object-parse-failure') {
        throw new PdfParseError(report.detail);
      }
    }

    if (report) {
      report.lost = [...pass.failed, ...pass.lostInObjStm];
      if (pass.objStmDamage.length > 0) report.objectStreams = pass.objStmDamage;
    }

    const doc = new Document(pass.objects, trailer);
    doc.originalBytes = buf;
    doc.openOptions = opts;
    doc.revisions = revisions;
    if (pass.preserved)
      doc.preservedEncryptor = buildEncryptorFromKeys(pass.preserved.keys, pass.preserved.encryptDict);
    doc.permissions = pass.permissions;
    doc.recovery = report;
    return doc;
  }

  /** Find a trailer that still exists in the file: a `trailer` keyword first,
   *  then the dict of a /Type /XRef stream — the only route for an xref-stream
   *  file, which has no `trailer` keyword anywhere. Returns undefined when
   *  neither survives, which is the case trailer synthesis handles. */
  private static recoverTrailer(
    buf: Uint8Array, sweep: SweepResult, entries: Map<number, XrefEntry>,
  ): PdfDict | undefined {
    for (const at of sweep.trailerOffsets) {
      try {
        const d = new ObjectParser(new Lexer(buf, at)).parseObject();
        if (isDict(d) && d.get('Root') !== undefined) return d;
      } catch { /* try the next one */ }
    }
    for (const e of entries.values()) {
      if (e.type !== 'offset') continue;
      try {
        const v = new ObjectParser(new Lexer(buf, e.offset)).parseIndirectObject().value;
        if (!isStream(v)) continue;
        const t = v.dict.get('Type');
        if (isName(t) && t.name === 'XRef' && v.dict.get('Root') !== undefined) return v.dict;
      } catch { /* try the next one */ }
    }
    return undefined;
  }

  /** True when the trailer's /Root resolves to a /Type /Catalog in `objects`. */
  private static rootIsCatalog(objects: Map<number, PdfObject>, trailer: PdfDict): boolean {
    const r = trailer.get('Root');
    const root = isRef(r) ? objects.get(r.num) : r;
    if (!isDict(root)) return false;
    const t = root.get('Type');
    return isName(t) && t.name === 'Catalog';
  }

  /** Parse every entry in `entries` into a live object map, collecting the
   *  object numbers whose parse threw rather than throwing on the first one.
   *  `alternates` supplies fallback offsets for an object whose entry does not
   *  parse; it is only ever set on the recovery path. */
  private static build(
    buf: Uint8Array,
    entries: Map<number, XrefEntry>,
    trailer: PdfDict,
    opts: OpenOptions,
    alternates: Map<number, ObjCandidate[]> | undefined,
  ): BuildResult {
    // Raw (un-decrypted) resolver for the /Encrypt dict and /ID — these are never
    // encrypted, and must be read before a Decryptor exists.
    const rawObject = (num: number): PdfObject => {
      const e = entries.get(num);
      if (!e || e.type !== 'offset') return null;
      const p = new ObjectParser(new Lexer(buf, e.offset), (lenObj) => {
        const r = isRef(lenObj) ? rawObject(lenObj.num) : lenObj;
        return typeof r === 'number' ? r : undefined;
      });
      return p.parseIndirectObject().value;
    };
    const resolveRaw = (o: PdfObject | undefined): PdfObject =>
      o === undefined ? null : isRef(o) ? rawObject(o.num) : o;

    let decryptor: Decryptor | undefined;
    let preserved: { keys: CryptKeys; encryptDict: PdfDict } | undefined;
    let permissions: Permissions | undefined;
    let encObjNum = -1;
    const encRef = trailer.get('Encrypt');
    if (encRef !== undefined) {
      if (isRef(encRef)) encObjNum = encRef.num;
      const encDict = resolveRaw(encRef);
      if (!isDict(encDict)) throw new PdfParseError('/Encrypt is not a dict');
      const filter = resolveRaw(encDict.get('Filter'));
      if (isName(filter) && filter.name === 'Adobe.PubSec') {
        if (!opts.recipient) throw new InvalidPasswordError();
        const result = buildPubSecDecryptor(encDict, normalizeRecipient(opts.recipient), resolveRaw);
        decryptor = { decryptObject: result.decryptObject, keys: result.keys };
        permissions = result.permissions;
        preserved = { keys: result.keys, encryptDict: encDict };
      } else {
        const idArr = trailer.get('ID');
        const id0 = isArray(idArr) && isString(idArr[0]) ? idArr[0].bytes : undefined;
        decryptor = buildDecryptor(encDict, id0, opts.password ?? '', resolveRaw);
        if (decryptor) preserved = { keys: decryptor.keys, encryptDict: encDict };
        const P = resolveRaw(encDict.get('P'));
        if (typeof P === 'number') permissions = permissionsFromP(P);
      }
    }

    const objects = new Map<number, PdfObject>();
    const objStmCache = new Map<number, Map<number, PdfObject>>();
    // Keyed by container so the two decode sites — expandObjectStreams below and
    // parseEntry's compressed branch — cannot record the same container twice.
    const damagedStreams = new Map<number, ObjStmDamage>();
    // Objects currently being parsed. A recovered offset map can produce a
    // self-referential indirect /Length, which would otherwise recurse forever:
    // parseEntry memoizes only after parsing returns, so nothing breaks the loop.
    const inProgress = new Set<number>();

    // Parse one xref entry into `objects`, memoizing; recurses for forward refs
    // (e.g. an indirect stream /Length) and for object-stream containers.
    const parseEntry = (num: number): PdfObject => {
      const existing = objects.get(num);
      if (existing !== undefined) return existing;
      if (inProgress.has(num)) return null;
      const entry = entries.get(num);
      if (!entry) return null;
      inProgress.add(num);
      try {
        let value: PdfObject;
        // A free entry is a tombstone: the number is not in use in this
        // revision, so it produces no object at all. It must be tested BEFORE
        // the offset/compressed split, which is a two-way branch that would
        // otherwise read it as compressed and dereference a missing
        // `streamObj`. Skipping it is what stops a superseded object being
        // resurrected into the live map, where the all-objects scans behind
        // PDF/A and PDF/X validation would still see it.
        if (entry.type === 'free') { inProgress.delete(num); return null; }
        if (entry.type === 'offset') {
          const parser = new ObjectParser(new Lexer(buf, entry.offset), (lenObj) => {
            const r = isRef(lenObj) ? parseEntry(lenObj.num) : lenObj;
            return typeof r === 'number' ? r : undefined;
          });
          value = parser.parseIndirectObject().value;
          // Decrypt top-level offset objects, except the /Encrypt dict and any
          // cross-reference stream (/Type /XRef is never encrypted).
          const xt = isStream(value) ? value.dict.get('Type') : undefined;
          const isXRefStream = isName(xt) && xt.name === 'XRef';
          if (decryptor && num !== encObjNum && !isXRefStream)
            value = decryptor.decryptObject(value, num, entry.gen);
        } else {
          let map = objStmCache.get(entry.streamObj);
          if (!map) {
            const s = parseEntry(entry.streamObj);
            if (!isStream(s)) throw new PdfParseError(`object stream ${entry.streamObj} is not a stream`);
            const r = decodeObjStm(s, entry.streamObj);
            if (r.damage) damagedStreams.set(entry.streamObj, r.damage);
            map = r.objects;
            objStmCache.set(entry.streamObj, map);
          }
          // A number the container declared but did not produce resolves to
          // null, per the spec rule for a reference to a non-existent object.
          value = map.get(num) ?? null;
          // Objects from an object stream are already plaintext — do not decrypt.
        }
        objects.set(num, value);
        return value;
      } finally {
        inProgress.delete(num);
      }
    };

    const failed = new Set<number>();
    const repaired: number[] = [];

    // Recovery path only (`alternates` is set nowhere else): an /ObjStm
    // container has its own `N G obj` header so the sweep finds it, but the
    // objects inside carry none. Register them before the build loop, or /Root
    // is unreachable in every compressed file. This must come *after* the
    // decryptor exists — an /ObjStm payload is encrypted — and parseEntry is
    // the loader that decrypts, which is why it is called here and not earlier.
    if (alternates) {
      const ex = expandObjectStreams(entries, parseEntry);
      repaired.push(...ex.added);
      for (const d of ex.damaged) damagedStreams.set(d.container, d);
    }

    for (const num of entries.keys()) {
      try {
        parseEntry(num);
      } catch {
        objects.delete(num);
        // Last occurrence wins, but only if it parses: on a tail-truncated file
        // the newest copy of an object is precisely the broken one, so walk the
        // candidate list downward to the previous good copy.
        const list = alternates?.get(num);
        let ok = false;
        for (let i = (list?.length ?? 0) - 1; i >= 0 && !ok; i--) {
          const c = list![i];
          if (entries.get(num)?.type === 'offset'
            && (entries.get(num) as { offset: number }).offset === c.offset) continue;
          entries.set(num, { type: 'offset', offset: c.offset, gen: c.gen });
          objects.delete(num);
          try {
            parseEntry(num);
            ok = true;
            repaired.push(num);
          } catch {
            objects.delete(num);
          }
        }
        if (!ok) failed.add(num);
      }
    }

    // A `compressed` object carries no offset of its own, so it cannot be
    // repaired from a candidate list — it fails only because its /ObjStm
    // container did. If the container was repaired later in the loop above, that
    // reason no longer holds, so retry until nothing more improves. Without this
    // every compressed object visited before its container stays lost, which on
    // a compressed file means /Root itself.
    for (let progress = true; progress && failed.size > 0;) {
      progress = false;
      for (const num of [...failed]) {
        objects.delete(num);
        try {
          parseEntry(num);
          failed.delete(num);
          progress = true;
        } catch {
          objects.delete(num);
        }
      }
    }

    // Object-stream containers were only holders; their contents now live
    // top-level, so drop the containers themselves.
    for (const [num, obj] of [...objects]) {
      if (isStream(obj)) {
        const t = obj.dict.get('Type');
        if (isName(t) && t.name === 'ObjStm') objects.delete(num);
      }
    }

    // Every number a damaged container declared but did not produce. Derived
    // from the damage records rather than from a throw, because a missing entry
    // resolves to null quietly — which is exactly why it must be reported.
    const lostInObjStm = new Set<number>();
    for (const d of damagedStreams.values()) for (const n of d.lost) lostInObjStm.add(n);

    return {
      objects, failed, lostInObjStm, preserved,
      objStmDamage: [...damagedStreams.values()],
      repaired, permissions,
    };
  }

  /** Open a PDF from a file path (synchronous), delegating to Open. */
  static OpenFile(fileName: string, opts: OpenOptions = {}): Document {
    return Document.Open(new Uint8Array(readFileSync(fileName)), opts);
  }

  /** Resolve a value: if it's a ref, fetch the object; otherwise return as-is. */
  resolve(o: PdfObject | undefined): PdfObject {
    if (o === undefined) return null;
    if (isRef(o)) return this.getObject(o.num);
    return o;
  }

  catalog(): PdfDict {
    const root = this.resolve(this.trailer.get('Root'));
    if (!isDict(root)) throw new PdfParseError('catalog (Root) is not a dict');
    return root;
  }

  /** Largest object number currently in the live map (0 when empty). */
  private maxObjNum(): number {
    let m = 0;
    for (const n of this.objects.keys()) if (n > m) m = n;
    return m;
  }

  /** @internal Allocate a fresh indirect object, returning its ref. */
  allocObject(obj: PdfObject): PdfRef {
    const n = this.maxObjNum() + 1;
    this.objects.set(n, obj);
    this.markModified();
    return ref(n);
  }

  /** @internal Replace the object stored at `num` in place, so every existing
   *  indirect reference to it sees the new value (used to rewrite a shared
   *  stream — whose `raw` is immutable — without repointing each referrer). */
  replaceObject(num: number, obj: PdfObject): void {
    this.objects.set(num, obj);
    this.markModified();
  }

  /** @internal Delete an indirect object from the live map. Callers must also
   *  remove any references to it. Used by PDF/A conversion to drop orphaned
   *  prohibited objects so re-validation (which scans all objects) agrees. */
  deleteObject(num: number): void {
    this.objects.delete(num);
    this.markModified();
  }

  /** @internal Record that the in-memory model has diverged from `originalBytes`,
   *  so the next signature must be a full rewrite, and invalidate any cached
   *  signed output. Called from every tracked mutation entry point — including
   *  the in-place handle setters in `page.ts`/`annotation.ts`/`form.ts`, which
   *  edit live dicts/arrays without allocating a new object. */
  markModified(): void {
    this.modified = true;
    this.pendingSignedBytes = undefined;
  }

  /** A pristine object map re-parsed from the bytes this document was opened
   *  from — the baseline an incremental save diffs the live model against.
   *
   *  Re-parsing rather than fingerprinting at open is deliberate: it puts the
   *  whole cost inside the operation that asks for it, on a path that is
   *  already writing a file, instead of taxing every `Open` in the library for
   *  a feature most callers never use. */
  private baselineObjects(): Map<number, PdfObject> {
    if (!this.originalBytes)
      throw new UnsupportedFeatureError(
        'cannot compute an incremental delta: this document was authored in memory, '
        + 'so there is no base byte image to compare against');
    return Document.Open(this.originalBytes, this.openOptions).objects;
  }

  /** The live /Info dict, or undefined when there is none. */
  private currentInfo(): PdfDict | undefined {
    const info = this.resolve(this.trailer.get('Info'));
    return isDict(info) ? info : undefined;
  }

  /** The interactive form (AcroForm) fields, rebuilt from the live catalog on
   *  each access. A document without /AcroForm yields a Form with no Fields. */
  get Form(): Form {
    return new Form(this);
  }

  /** Export the current form-field values as an FDF data file. Pass
   *  `{ annotations: true }` to carry this document's annotations too. */
  ExportFdf(opts: ExportFormDataOptions = {}): Uint8Array {
    return writeFdf(collectFormData(this, opts));
  }

  /** Export the current form-field values as an XFDF data file. See ExportFdf. */
  ExportXfdf(opts: ExportFormDataOptions = {}): Uint8Array {
    return writeXfdf(collectFormData(this, opts));
  }

  /** Import field values from an FDF data file. Fields with no match in this
   *  document, and values the field rejects, are reported rather than thrown.
   *  Appearance streams are regenerated for every field that is set.
   *
   *  Pass `{ annotations: true }` to apply the file's annotations as well: each
   *  is added to the page it names, replacing any annotation already there with
   *  the same /NM, so importing the same file twice is idempotent. */
  ImportFdf(bytes: Uint8Array, opts: ImportOptions = {}): ImportReport {
    return applyFormData(this, readFdf(bytes), opts);
  }

  /** Import field values from an XFDF data file. See ImportFdf. */
  ImportXfdf(bytes: Uint8Array, opts: ImportOptions = {}): ImportReport {
    return applyFormData(this, readXfdf(bytes), opts);
  }

  /** The document's optional-content (layers) model, rebuilt from the live
   *  catalog on each access. */
  get OptionalContent(): OptionalContent {
    return new OptionalContent(this);
  }

  GetMetadata(): Metadata {
    return readMetadata(this.currentInfo(), (o) => this.resolve(o));
  }

  /** The document-level XMP packet at /Root /Metadata as structured data; an
   *  empty object when there is no metadata stream. Read leniently. */
  GetXmp(): XmpMetadata {
    const md = this.resolve(this.catalog().get('Metadata'));
    if (!isStream(md)) return {};
    return readXmp(inflateStream(md));
  }

  /** Render every page to one Markdown document. See `Page.ToMarkdown`. */
  ToMarkdown(options?: MarkdownExportOptions): string {
    return renderDocumentToMarkdown(this, options);
  }

  /** Render every page to Markdown plus the image files it references.
   *
   *  With the default `images: 'inline'` this is `ToMarkdown` with an empty
   *  `images` list. With `images: 'external'` each distinct image becomes one
   *  asset the caller writes at `asset.path`, relative to the Markdown — see
   *  `saveMarkdownFile` in the Node helpers for the file-writing form. */
  ToMarkdownAssets(options?: MarkdownExportOptions): MarkdownExportResult {
    return renderDocumentToMarkdownAssets(this, options);
  }

  /** Render every page to one standalone HTML document. See `Page.ToHtml`. */
  ToHtml(options?: HtmlOptions): string {
    return renderDocumentToHtml(this, options);
  }

  /** Render every page to a `.docx` (Office Open XML).
   *
   *  `mode: 'flow'` (the default) reconstructs the document from the tagged
   *  structure tree when there is one and from font-size heuristics when there
   *  is not — the same model `ToHtml` and `ToMarkdown` read — and reflows it,
   *  with pages concatenated and no page break between them. Emphasis is
   *  *inferred* from the producing font rather than declared by the PDF.
   *
   *  `mode: 'textbox'` reproduces each page's own geometry instead: every run
   *  of text becomes a page-anchored frame at its PDF position, with one
   *  section per page carrying that page's size. Word re-measures the text with
   *  a substituted face, so intra-frame spacing is Word's rather than the
   *  PDF's. Rotated and vertical runs are placed unrotated, `/Link`
   *  hyperlinks are not recovered, and vector ink reaches the output only under
   *  `backdrop: 'raster'`.
   *
   *  Images travel inside the package either way, so there is no assets variant
   *  to call. Never throws. */
  ToDocx(options?: DocxOptions): Uint8Array {
    return renderDocumentToDocx(this, options);
  }

  /** Render every page to one EPUB 3 archive.
   *
   *  Reflows over the same model ToHtml, ToMarkdown and ToDocx read, as a
   *  single content document with a minimal navigation document; splitting at
   *  headings with a real TOC is future work. Images travel inside the package,
   *  so there is no assets variant to call.
   *
   *  There is deliberately no `Page.ToEpub`: a book is a document, and a
   *  one-page EPUB is not a thing anyone wants.
   *
   *  Never throws. */
  ToEpub(options?: EpubOptions): Uint8Array {
    return renderEpub(this, this.Pages, options ?? {});
  }

  /** Rasterize a page selection into ONE multi-page TIFF.
   *
   *  `pages` is an explicit 1-based list or a `"1-5,8,12-"` range string,
   *  defaulting to every page; the remaining options are `ToImage`'s, applied
   *  to every frame. Compression is Deflate unless `{ compression: 'none' }`.
   *
   *  This is the format document archival, fax gateways and scanning pipelines
   *  interchange in, and it is why the TIFF encoder takes a list of frames:
   *  encoded TIFFs cannot be concatenated, so a per-page call could never
   *  produce one. `background: 'transparent'` is honoured, TIFF being able to
   *  carry alpha where JPEG cannot. */
  ToTiff(options?: TiffExportOptions): Uint8Array {
    return renderDocumentToTiff(this, options ?? {});
  }

  /** Append one page per frame of an image file, sized to each frame.
   *
   *  A multi-frame TIFF — how a scanned or faxed document arrives — becomes one
   *  page per frame; a single-frame JPEG, PNG or BMP becomes one page, which is
   *  the ordinary image-to-PDF operation. `frames` selects a subset (0-based,
   *  normalized ascending and deduped) and `dpi` sizes the pages, defaulting to
   *  72 so one pixel is one point.
   *
   *  A frame that will not decode costs its own page and nothing else: it is
   *  reported in `skipped` so a partly-corrupt fax still yields what survives.
   *  Throws only when NO frame decoded. */
  AddImagePages(data: Uint8Array, options?: AddImagePagesOptions): AddImagePagesResult {
    return addImagePages(this, data, options ?? {});
  }

  /** The document's logical structure tree, or null when untagged. */
  GetStructTree(): StructTreeRoot | null {
    const stRef = this.catalog().get('StructTreeRoot');
    const st = this.resolve(stRef);
    if (!isDict(st)) return null;
    return new StructTreeRoot(this, st, isRef(stRef) ? stRef : undefined);
  }

  /** Validate the document against a curated, machine-checkable subset of
   *  PDF/UA-1 (ISO 14289-1) rules. Read-only; never mutates. */
  ValidatePdfUa(): ValidationReport {
    return validatePdfUa(this, this.catalog());
  }

  /** Validate the document against a curated, machine-decidable subset of
   *  PDF/A (ISO 19005, parts 1-3, levels b/u/a). Read-only; never mutates. */
  ValidatePdfA(level: PdfALevel): ValidationReport {
    return validatePdfA(this, this.catalog(), level);
  }

  /** Validate the document against a curated, machine-decidable subset of
   *  PDF/X (ISO 15930, levels 1a/3/4/4p). Read-only; never mutates. */
  ValidatePdfX(level: PdfXLevel): ValidationReport {
    return validatePdfX(this, this.catalog(), level);
  }

  /** Remediate the document toward PDF/A `level` (b/u), then re-validate.
   *  Mutates the live model in place; the result is emitted by the next Save(). */
  ConvertToPdfA(level: PdfALevel, opts?: ConvertOptions): ConversionReport {
    this.markModified();
    return convertToPdfA(this, this.catalog(), level, opts);
  }

  /** Remediate the document toward PDF/X `level`, then re-validate. Mutates the
   *  live model in place; the result is emitted by the next Save(). Defects that
   *  cannot be fixed mechanically (live transparency, non-embeddable fonts, RGB
   *  raster images) are reported in `unresolved`, not silently altered. */
  ConvertToPdfX(level: PdfXLevel, opts?: PdfXConvertOptions): ConversionReport {
    this.markModified();
    return convertToPdfX(this, this.catalog(), level, opts);
  }

  /** Remediate the document toward PDF/UA-1 (mechanical fixes only), then
   *  re-validate. Mutates the live model in place; defects requiring human
   *  authoring (alt text, structure, untagged content) are reported, not fixed. */
  ConvertToPdfUa(opts?: PdfUaConvertOptions): ConversionReport {
    this.markModified();
    return convertToPdfUa(this, this.catalog(), opts);
  }

  /** @internal Every indirect object with a gen-0 ref. For validators that must
   *  scan the whole object graph (e.g. prohibited filters anywhere). */
  *objectEntries(): Generator<[PdfRef, PdfObject]> {
    for (const [num, obj] of this.objects) yield [ref(num), obj];
  }

  /** @internal The effective PDF version: catalog `/Version` when present, else
   *  the `%PDF-x.y` header from the opened bytes, else undefined (in-memory). */
  headerVersion(): string | undefined {
    const cv = this.resolve(this.catalog().get('Version'));
    if (isName(cv)) return cv.name;
    if (!this.originalBytes) return undefined;
    const head = new TextDecoder('latin1').decode(this.originalBytes.subarray(0, 16));
    const m = /%PDF-(\d+\.\d+)/.exec(head);
    return m ? m[1] : undefined;
  }

  /** Build (or return the existing) document structure tree, marking the
   *  document Tagged (/MarkInfo /Marked true). Idempotent. */
  CreateStructTree(): StructTreeRoot {
    const { dict, ref: rootRef } = ensureStructTree(this);
    return new StructTreeRoot(this, dict, rootRef);
  }

  /** Infer and author a `/StructTreeRoot` from page layout (headings by
   *  font-size clustering, paragraphs, and — with `opts.alt` — figures). Marks
   *  the document Tagged and returns per-type counts. Heuristic; see the README
   *  limitations. Throws if the document is already tagged unless `opts.force`. */
  AutoTag(opts?: AutoTagOptions): AutoTagReport {
    return autoTag(this, opts);
  }

  /** Whether the catalog declares the document Tagged (/MarkInfo /Marked true). */
  get IsTagged(): boolean {
    const mi = this.resolve(this.catalog().get('MarkInfo'));
    return isDict(mi) && this.resolve(mi.get('Marked')) === true;
  }

  /** True when the opened file is linearized (its first indirect object is a
   *  /Linearized parameter dictionary, within the first 1024 bytes). False for
   *  in-memory/authored documents and for re-saved (non-linearized) output. */
  get IsLinearized(): boolean {
    if (!this.originalBytes) return false;
    const head = new TextDecoder('latin1').decode(this.originalBytes.subarray(0, 1024));
    const m = /\bobj\b([\s\S]*?)\bendobj\b/.exec(head);
    return m !== null && /\/Linearized\b/.test(m[1]);
  }

  /** The document default language (/Lang on the catalog), or undefined. */
  get Lang(): string | undefined {
    const l = this.resolve(this.catalog().get('Lang'));
    return isString(l) ? decodePdfText(l.bytes) : undefined;
  }

  /** Set the document default language (catalog /Lang), e.g. 'en-US'. */
  set Lang(v: string) {
    this.catalog().set('Lang', { kind: 'string', bytes: encodePdfText(v) });
    this.markModified();
  }

  /** Catalog /ViewerPreferences /DisplayDocTitle: whether a viewer shows the
   *  document's title rather than its file name. PDF/UA requires it true, and a
   *  /Info /Title without it satisfies neither — which is why the two are set
   *  together wherever this library sets either. */
  get DisplayDocTitle(): boolean {
    const vp = this.resolve(this.catalog().get('ViewerPreferences'));
    return isDict(vp) && this.resolve(vp.get('DisplayDocTitle')) === true;
  }

  set DisplayDocTitle(v: boolean) {
    let vp = this.resolve(this.catalog().get('ViewerPreferences'));
    if (!isDict(vp)) {
      vp = new Map<string, PdfObject>();
      this.catalog().set('ViewerPreferences', vp);
    }
    (vp as PdfDict).set('DisplayDocTitle', v);
    this.markModified();
  }

  /** @internal Map a page object ref to its Page handle, or undefined. */
  pageForRef(r: PdfRef): Page | undefined {
    const i = this.pageObjNums.indexOf(r.num);
    return i >= 0 ? this.Pages[i] : undefined;
  }

  /** Build the XMP packet for `meta` and install it as the catalog's /Metadata
   *  stream (uncompressed). Replaces any existing packet; the old object is
   *  dropped by the next Save() mark-sweep. */
  private installXmp(meta: XmpMetadata): void {
    const bytes = new TextEncoder().encode(buildXmp(meta));
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Metadata')], ['Subtype', name('XML')],
    ]);
    const stream: PdfStream = { kind: 'stream', dict, raw: bytes };
    this.catalog().set('Metadata', this.allocObject(stream));
  }

  /** @internal Resolve a destination's page object to its 1-based page number,
   *  or undefined. Consumed by GetOutlines and LinkAnnotation. */
  pageNumberOf(o: PdfObject): number | undefined {
    const d = this.resolve(o);
    if (!isDict(d)) return undefined;
    const i = this.Pages.findIndex((p) => p.Dict === d);
    return i === -1 ? undefined : i + 1;
  }

  /** The document outline (bookmark) tree; [] when there is no /Outlines. */
  GetOutlines(): OutlineItem[] {
    const outlines = this.resolve(this.catalog().get('Outlines'));
    if (!isDict(outlines)) return [];
    return readOutlineTree(this, outlines, (o) => this.pageNumberOf(o));
  }

  /** @internal The indirect ref for a 1-based page number; throws when that page
   *  is not an indirect object. */
  pageRef(page: number): PdfRef {
    const num = this.pageObjNums[page - 1];
    if (!num) throw new UnsupportedFeatureError('page is not an indirect object');
    return ref(num);
  }

  /** The page object ref for a 1-based page number; throws when that page is
   *  not an indirect object (consistent with Reorder). */
  private pageRefForNumber(page: number): PdfRef {
    const num = this.pageObjNums[page - 1];
    if (!num)
      throw new UnsupportedFeatureError('cannot set outline destination: target page is not an indirect object');
    return ref(num);
  }

  /** Delete the /Outlines root and every item object reachable via First/Next. */
  private deleteOutlineSubtree(): void {
    const rootRef = this.catalog().get('Outlines');
    if (!isRef(rootRef)) return;
    const seen = new Set<number>();
    const walk = (r: PdfObject): void => {
      let cur = r;
      while (isRef(cur) && !seen.has(cur.num)) {
        seen.add(cur.num);
        const d = this.objects.get(cur.num);
        const next = isDict(d) ? d.get('Next') ?? null : null;
        if (isDict(d)) walk(d.get('First') ?? null);
        this.objects.delete(cur.num);
        cur = next;
      }
    };
    const root = this.objects.get(rootRef.num);
    if (isDict(root)) walk(root.get('First') ?? null);
    this.objects.delete(rootRef.num);
  }

  /** Replace the document outline with `items`; an empty array removes it.
   *  Validates the whole tree first, so a throw leaves the document unchanged. */
  SetOutlines(items: OutlineItem[]): void {
    validateOutlineItems(items, this.Pages.length, (p) => { this.pageRefForNumber(p); });
    const catalog = this.catalog();
    this.deleteOutlineSubtree();
    if (items.length === 0) { catalog.delete('Outlines'); return; }
    const rootNum = buildOutlineObjects(items, {
      alloc: (obj) => { const n = this.maxObjNum() + 1; this.objects.set(n, obj); return n; },
      pageRef: (p) => this.pageRefForNumber(p),
    });
    catalog.set('Outlines', ref(rootNum));
  }

  /** The logical page-label ranges from /Root /PageLabels, ascending; [] when
   *  there is no /PageLabels. Leniently read. */
  GetPageLabels(): PageLabel[] {
    return parsePageLabels(this);
  }

  /** Replace /Root /PageLabels with `labels`; an empty array removes it. Ranges
   *  are sorted by startIndex and the first must start at 0 (else RangeError).
   *  The old number tree becomes unreachable and is dropped by the next Save(). */
  SetPageLabels(labels: PageLabel[]): void {
    const catalog = this.catalog();
    if (labels.length === 0) { catalog.delete('PageLabels'); return; }
    const root = buildPageLabels(labels, { alloc: (obj) => this.allocObject(obj) });
    catalog.set('PageLabels', root);
  }

  /** Resolve a 0-based page index to its rendered label (prefix + numeral).
   *  Falls back to the decimal page number when no range applies. */
  PageLabelFor(pageIndex: number): string {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.Pages.length)
      throw new RangeError(`page index ${pageIndex} out of range 0..${this.Pages.length - 1}`);
    return resolvePageLabel(this.GetPageLabels(), pageIndex);
  }

  /** All named destinations, merging the /Names /Dests name tree and the legacy
   *  /Dests dict (legacy wins on a clash), sorted by name. */
  GetNamedDestinations(): NamedDestination[] {
    return readNamedDestinations(this, (o) => this.pageNumberOf(o));
  }

  /** Upsert `name` → `dest` into the /Names /Dests name tree (creating the
   *  containers as needed), writing a single flat node — no balanced-tree
   *  rebalancing. Leaves the legacy /Dests dict untouched. */
  SetNamedDestination(name: string, dest: PageDest): void {
    if (typeof name !== 'string' || name === '') throw new TypeError('named destination name must be a non-empty string');
    const p = dest.page;
    if (!Number.isInteger(p) || p < 1 || p > this.Pages.length)
      throw new RangeError(`named destination page ${p} out of range 1..${this.Pages.length}`);
    upsertNameTreeEntry(this, 'Dests', name, encodeDest(this.pageRef(p), dest.view));
  }

  /** Remove `name` from both the name tree and the legacy /Dests dict, pruning
   *  the now-empty containers. A no-op when the name is absent.
   *
   *  Stays void and ignores the tree removal's result: the name may live in the
   *  tree, in the legacy dict, or in both, so the legacy pass runs either way. */
  RemoveNamedDestination(name: string): void {
    removeNameTreeEntry(this, 'Dests', name);
    const catalog = this.catalog();
    const legacy = this.resolve(catalog.get('Dests'));
    if (isDict(legacy) && legacy.delete(name) && legacy.size === 0) catalog.delete('Dests');
  }

  /** What this document does when it is opened: go to a view (`kind: 'dest'`)
   *  or run an action (`kind: 'action'`). Undefined when the catalog carries
   *  none, and also when it carries one in a form this library does not model —
   *  the position an annotation's /A already takes. */
  GetOpenAction(): OpenAction | undefined {
    return readOpenAction(this);
  }

  /** Open the document at `dest`, written as a destination. Throws RangeError
   *  for a page outside 1..Pages.length. */
  SetOpenDestination(dest: PageDest): void {
    setOpenDestination(this, dest);
  }

  /** Run `action` when the document is opened, written as an action dict.
   *  `{ type: 'goto', page }` is the action spelling of `SetOpenDestination`;
   *  both are legal and the two write different shapes, so pick the one you
   *  mean. */
  SetOpenAction(action: PdfAction): void {
    setOpenAction(this, action);
  }

  /** Remove the catalog /OpenAction. A no-op when there is none. */
  RemoveOpenAction(): void {
    removeOpenAction(this);
  }

  /** Document-level JavaScript: every entry of the /Names /JavaScript tree,
   *  sorted by name. An entry that is not a JavaScript action is skipped. */
  GetJavaScripts(): DocumentJavaScript[] {
    return readDocumentJavaScripts(this);
  }

  /** Upsert a document-level script, run by the viewer when the document opens.
   *  Throws TypeError for an empty name or an empty script. */
  SetJavaScript(name: string, script: string): void {
    setDocumentJavaScript(this, name, script);
  }

  /** Remove a document-level script. False when the name was absent. */
  RemoveJavaScript(name: string): boolean {
    return removeDocumentJavaScript(this, name);
  }

  /** All document-level embedded files (the /Names /EmbeddedFiles tree), sorted
   *  by name. Each result's GetBytes() decodes the file on demand. */
  GetAttachments(): Attachment[] {
    return readAttachments(this);
  }

  /** Embed `bytes` as an attachment named `name`, upserting it into the
   *  /Names /EmbeddedFiles name tree (overwriting a same-named entry). */
  AddAttachment(name: string, bytes: Uint8Array, opts: AttachmentOptions = {}): Attachment {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('attachment bytes must be a Uint8Array');
    const fs = buildFilespec(bytes, name, opts, (o) => this.allocObject(o));
    upsertEmbeddedFile(this, name, this.allocObject(fs));
    return new Attachment(this, fs);
  }

  /** Remove the named attachment from the name tree (and /AF). Returns false
   *  when no such attachment exists. */
  RemoveAttachment(name: string): boolean {
    return removeEmbeddedFile(this, name);
  }

  /** The /Root /Collection portfolio presentation settings, or undefined. */
  GetCollection(): CollectionSettings | undefined {
    return readCollection(this);
  }

  /** Write (or replace) the /Root /Collection portfolio settings. Throws on an
   *  invalid schema before mutating the document. */
  SetCollection(settings: CollectionSettings): void {
    const col = buildCollection(settings); // validates first
    this.catalog().set('Collection', this.allocObject(col));
    this.markModified();
  }

  /** Remove /Root /Collection. Returns false when none was present. */
  RemoveCollection(): boolean {
    const catalog = this.catalog();
    if (catalog.get('Collection') === undefined) return false;
    catalog.delete('Collection');
    this.markModified();
    return true;
  }

  /** Resolve or lazily create the live /Info dict, ensuring it has an object number
   *  and a trailer reference. */
  /** @internal The /Info dictionary, created and linked from the trailer when
   *  absent. Used by the metadata setters and the PDF/X converter. */
  ensureInfo(): PdfDict {
    this.markModified();
    const existing = this.currentInfo();
    if (existing) return existing;
    const num = this.maxObjNum() + 1;
    const info: PdfDict = new Map<string, PdfObject>();
    this.objects.set(num, info);
    this.trailer.set('Info', ref(num));
    return info;
  }

  SetMetadata(update: MetadataUpdate): void {
    applyUpdate(this.ensureInfo(), update);
    const xmpUpdate = mirrorMetaToXmp(update);
    if (Object.keys(xmpUpdate).length === 0) return; // no shared fields → leave XMP alone
    const merged = mergeXmp(this.GetXmp(), xmpUpdate);
    const hadXmp = isStream(this.resolve(this.catalog().get('Metadata')));
    // Avoid materializing an empty packet from a pure-delete on a doc with no XMP.
    if (hadXmp || hasXmpField(merged)) this.installXmp(merged);
  }

  /** Set/replace the document XMP packet from `update` (merged over the current
   *  packet; `null` deletes a field), mirroring shared fields back into /Info. */
  SetXmp(update: XmpUpdate): void {
    this.installXmp(mergeXmp(this.GetXmp(), update));
    applyUpdate(this.ensureInfo(), mirrorXmpToMeta(update));
  }

  /** Remove all document metadata: drop the /Info dictionary and the catalog's
   *  /Root /Metadata XMP packet, so /Info and XMP stay consistent (the mirror
   *  counterpart of SetMetadata <-> SetXmp). */
  ClearMetadata(): void {
    this.markModified();
    const infoRef = this.trailer.get('Info');
    if (isRef(infoRef)) this.objects.delete(infoRef.num);
    this.trailer.delete('Info');

    const catalog = this.catalog();
    const mdRef = catalog.get('Metadata');
    if (isRef(mdRef)) this.objects.delete(mdRef.num);
    catalog.delete('Metadata');
  }

  /** Losslessly shrink the document in place: subset already-embedded fonts to
   *  the glyphs actually shown, merge byte-identical streams, and recompress
   *  stream payloads. Content and visual output are preserved exactly; the next
   *  {@link Save} emits the smaller document. Every concern is opt-out via
   *  `opts` and all default on. Throws {@link UnsupportedFeatureError} for a
   *  signed document, which optimizing would invalidate. */
  Optimize(opts: OptimizeOptions = {}): OptimizeReport {
    return optimizeDocument(this, opts);
  }

  /** Convert the document's colour to DeviceGray in place: page content, form
   *  XObjects, tiling patterns, Type 3 glyph procedures, image XObjects,
   *  shadings and annotations. Colour is discarded, so this is not reversible;
   *  the returned report lists what converted and what could not. Throws
   *  {@link UnsupportedFeatureError} for a signed document, which converting
   *  would invalidate. */
  ConvertToGrayscale(opts: GrayscaleOptions = {}): GrayscaleReport {
    return convertToGrayscale(this, opts);
  }

  /** Serialize the live document to PDF bytes (mark-sweep from /Root, renumbered).
   *  Pass `{ compressed: true }` for cross-reference-stream + ObjStm output. */
  Save(options: SaveOptions = {}): Uint8Array {
    // Incremental goes first so it can REFUSE a document signed in this
    // session, which the verbatim return below would otherwise hide.
    if (options.incremental) return this.saveIncremental(options);
    // A completed signature fixes the exact bytes; return them verbatim so the
    // signed byte image is never re-serialized (which would break the digest).
    if (this.pendingSignedBytes) return this.pendingSignedBytes;
    this.finalizeEmbeddedFonts();
    // A retained key for R<=4 hashes /ID[0], so it is valid only against the
    // SAME /ID -- and resolveIds invents a fresh random one when the trailer
    // names none, which would yield a file nothing can decrypt, us included.
    if (this.preservedEncryptor && options.encrypt === undefined && !isArray(this.trailer.get('ID')))
      throw new UnsupportedFeatureError(
        'cannot preserve encryption: the trailer names no /ID, which the file key '
        + 'is derived from. Pass `encrypt` to re-encrypt with stated credentials, '
        + 'or `encrypt: false` to write plaintext.');
    return serializeDocument(this.objects, this.trailer, options, this.preservedEncryptor);
  }

  /** Append an incremental update carrying only what changed since `Open`.
   *
   *  The delta is REACHABILITY-BLIND, which is the exact inversion of `Save`'s
   *  mark-sweep: an appended revision must write a changed object whether or
   *  not it is still reachable from `/Root`, because earlier revisions still
   *  point at the object it supersedes. Garbage-collecting here corrupts the
   *  revision history this feature exists to provide. */
  private saveIncremental(options: SaveOptions): Uint8Array {
    // The live model is BEHIND the signed bytes for the signature object:
    // `fillSignature` patches bytes and never the model, so the live `/Sig`
    // carries a `/Contents` of length 0 while the signed bytes carry the real
    // CMS. Diffing them would append the EMPTY one, destroying the signature —
    // so this refuses rather than appending, and it refuses even with no edit
    // at all, because the divergence is already there the moment Sign returns.
    // Save() the signed bytes, reopen them, then edit: that is the path the
    // whole feature exists for, and it is exercised in
    // test/sign-incremental-survival.test.ts.
    if (this.signedInSession)
      throw new UnsupportedFeatureError(
        'cannot save incrementally after signing in this session: the signature\'s '
        + '/Contents exists only in the signed bytes, not in the live model, so an '
        + 'appended revision would overwrite it with an empty one. Save() first, '
        + 'reopen the result, then edit.');
    if (!this.originalBytes)
      throw new UnsupportedFeatureError(
        'cannot save incrementally: this document was authored in memory, '
        + 'so there is no base byte image to append to');
    if (this.recovery)
      throw new UnsupportedFeatureError(
        'cannot save incrementally: this document was opened by recovery, so the '
        + 'cross-reference an update would chain /Prev onto could not be read');
    for (const k of ['encrypt', 'compressed', 'linearized', 'streamFilter'] as const)
      if (options[k])
        throw new UnsupportedFeatureError(`cannot save incrementally with \`${k}\``);

    // After the refusals, so a rejected call leaves the document untouched —
    // and before the diff, because font embedding allocates objects: taken
    // first, every font added since Open is missing from the revision.
    this.finalizeEmbeddedFonts();

    const delta = diffObjects(this.baselineObjects(), this.objects);
    const objects = new Map<number, PdfObject>();
    for (const n of delta.replaced) objects.set(n, this.objects.get(n)!);
    for (const n of delta.added) objects.set(n, this.objects.get(n)!);

    const rootRef = this.trailer.get('Root');
    const infoRef = this.trailer.get('Info');
    return appendIncrementalUpdate(this.originalBytes, {
      objects,
      freed: delta.freed,
      encryptor: this.preservedEncryptor,
      rootNum: isRef(rootRef) ? rootRef.num : undefined,
      infoNum: isRef(infoRef) ? infoRef.num : undefined,
    });
  }

  /** Parse and register a font program (TrueType/OpenType sfnt bytes), returning
   *  a handle to pass as the `font` option to {@link Page.AddText} /
   *  {@link Page.AddTextBlock}. The font is subset (glyf) or whole-embedded (CFF)
   *  once per document at Save, covering the glyphs used across every draw.
   *  Throws {@link UnsupportedFeatureError}/{@link PdfParseError} for an
   *  unsupported container or malformed font. */
  AddFont(bytes: Uint8Array, opts: AddFontOptions = {}): EmbeddedFont {
    const font = new EmbeddedFont(parseSfnt(bytes, opts.faceIndex ?? 0));
    font.shape = opts.shape ?? false;
    this.embeddedFonts.push(font);
    return font;
  }

  /** Read a font program from disk (synchronous) and register it; the file path
   *  counterpart of {@link AddFont}, mirroring {@link WriteTo}. */
  AddFontFile(fileName: string, opts: AddFontOptions = {}): EmbeddedFont {
    return this.AddFont(new Uint8Array(readFileSync(fileName)), opts);
  }

  /**
   * Search `dir`, recursively, when resolving a font by name.
   *
   * No I/O happens here: the folder is scanned on the first
   * {@link LoadFontByName} that needs it, so registering folders a document
   * never draws from costs nothing. Registering a path this document already
   * holds does not grow the search list or perturb the order lookups depend on,
   * so a helper that registers on every call stays harmless.
   *
   * The scan opens files with a known font extension (`.ttf`, `.otf`, `.ttc`,
   * `.otc`) and files with **no extension at all** — a font checked into a repo
   * or unpacked from an archive routinely loses one, and the magic is checked
   * either way. `{ sniff: true }` widens it to every file in the folder, for a
   * font stored under some other extension entirely; it is opt-in because
   * pointing this at a general asset folder then opens every image and blob in
   * it, which is exactly the cost the partial-read index exists to avoid.
   *
   * `sniff` is STICKY-ON and does not move the folder: re-registering an
   * already-held path with `{ sniff: true }` upgrades it in place. Monotone and
   * order-stable, and it avoids asking for the wider scan and silently not
   * getting it.
   */
  RegisterFontFolder(dir: string, opts: { sniff?: boolean } = {}): void {
    const sniff = opts.sniff ?? false;
    const already = this.fontFolders.find((f) => f.dir === dir);
    if (already) { already.sniff ||= sniff; return; }
    this.fontFolders.push({ dir, sniff });
  }

  /**
   * Also search the platform's own font directories.
   *
   * Opt-in, and deliberately so: searching them by default would let
   * `LoadFontByName('Arial')` succeed on a developer machine and fail in a
   * container, so the same code would build different documents on different
   * machines — surfacing at Save as a missing face rather than at the call.
   */
  RegisterSystemFonts(): void {
    for (const dir of systemFontFolders()) this.RegisterFontFolder(dir);
  }

  /**
   * What `family` resolves to, without loading or embedding anything.
   *
   * `family` may be one name or a preference chain. The chain selects a
   * FAMILY — the first name any indexed face belongs to wins outright, and
   * style matching then runs inside it — so a style detail never overrides the
   * order the caller stated. Matching is trimmed and case-insensitive, against
   * the typographic family (name ID 16) where the font states one and ID 1
   * otherwise.
   *
   * Within that family the rule is CSS Fonts 4 §5.2: slant first, then the
   * desired-weight walk. Slant outranking weight is the surprising half —
   * `{ weight: 700, italic: true }` over a family holding Regular, Bold and
   * Italic yields the Italic face, not the Bold one.
   *
   * `undefined` only when no family in the chain is present. Once one is, a
   * face always comes back, possibly a substituted one — which is what
   * {@link FontMatch.exact} reports, and the only way to learn it.
   */
  ResolveFontByName(
    family: string | string[], opts: LoadFontOptions = {},
  ): FontMatch | undefined {
    const chain = typeof family === 'string' ? [family] : family;
    const req = { weight: clampWeight(opts.weight), italic: opts.italic ?? false };

    const faces: FaceRecord[] = [];
    for (const f of this.fontFolders) faces.push(...indexFolder(f.dir, f.sniff));

    const hit = matchChain(faces, chain, req);
    if (!hit) return undefined;

    const style = deriveStyle(hit.names);
    return {
      family: hit.names.typographicFamily ?? hit.names.family,
      subfamily: hit.names.typographicSubfamily ?? hit.names.subfamily,
      weight: style.weight,
      italic: style.italic,
      exact: style.weight === req.weight && style.italic === req.italic,
      path: hit.path,
      faceIndex: hit.faceIndex,
    };
  }

  /**
   * The face matching `family`, registered and ready to draw with.
   *
   * Selection is {@link ResolveFontByName}'s, so the two cannot disagree about
   * what a name means: a family chain, then CSS Fonts 4 §5.2 slant-then-weight
   * matching inside the winning family.
   *
   * Returns `undefined` when no registered folder holds any family in the
   * chain: a machine without a given face is an ordinary outcome, not an
   * unsupported feature, and substituting a Standard-14 face silently would
   * render the document in something the caller never chose. Never throws — an
   * unreadable file, a malformed font and a folder that does not exist are all
   * skipped.
   *
   * Degradation WITHIN a family is silent by design: ask for bold where only
   * upright exists and an upright face comes back. Call
   * {@link ResolveFontByName} to see which face that was.
   *
   * Requesting one face twice returns the SAME handle, so the font is embedded
   * once however many times it is drawn with.
   */
  LoadFontByName(
    family: string | string[], opts: LoadFontOptions = {},
  ): EmbeddedFont | undefined {
    const hit = this.ResolveFontByName(family, opts);
    if (!hit) return undefined;

    // Keyed by path AND face: the faces of a collection share one path, so a
    // path-only key hands back face 0's font for every face of the file and
    // every glyph is then drawn from the wrong one, silently.
    const key = `${hit.path}#${hit.faceIndex}`;
    const already = this.fontsByPath.get(key);
    if (already) return already;
    let font: EmbeddedFont;
    try {
      // AddFontOptions is passed field by field rather than spread: `opts` also
      // carries weight and italic, which are selection inputs and mean nothing
      // to AddFont.
      font = this.AddFont(new Uint8Array(readFileSync(hit.path)),
        { shape: opts.shape, faceIndex: hit.faceIndex });
    } catch {
      return undefined;   // readable enough to index, not enough to parse
    }
    this.fontsByPath.set(key, font);
    return font;
  }

  /**
   * The four faces of `family`, ready to hand to
   * `AddMarkdown({ style: { font } })`.
   *
   * `regular` is the weight-400 upright resolution and always exists once any
   * family in the chain does. The other three are filled ONLY when the chosen
   * face actually plays that role — weight ≥ 600 for the two bold slots, slant
   * matching for the two italic ones — and left `undefined` otherwise.
   *
   * That is the point of the method. Filling `bold` with whatever the matcher
   * returned would put the regular face in all four slots for a family shipping
   * one weight: four faces that are one face, dressed as a family. An absent
   * slot routes through the documented "an unstated face falls back to
   * `regular`" rule instead, producing the identical rendering by a route a
   * reader can follow.
   *
   * The bold test is a BUCKET, not the equality {@link FontMatch.exact} uses,
   * and the difference is deliberate: a family shipping Semibold and no 700 has
   * a bold face — it is the only heavier face there is — while resolving it at
   * 700 still reports `exact: false`. One question is "which face plays this
   * role", the other is "did I get what I asked for".
   *
   * Handles come through the same memo {@link LoadFontByName} uses, so two
   * slots resolving to one file share one handle and nothing is embedded twice.
   */
  LoadFontFamily(
    family: string | string[], opts: AddFontOptions = {},
  ): FontFamily | undefined {
    const regular = this.LoadFontByName(family, { ...opts, weight: 400, italic: false });
    if (!regular) return undefined;

    /** The face for a slot, or undefined when nothing plays that role. */
    const slot = (weight: number, italic: boolean): EmbeddedFont | undefined => {
      const hit = this.ResolveFontByName(family, { weight, italic });
      if (!hit) return undefined;
      if (hit.italic !== italic || (hit.weight >= 600) !== (weight >= 600)) return undefined;
      return this.LoadFontByName(family, { ...opts, weight, italic });
    };

    const out: FontFamily = { regular };
    const bold = slot(700, false);
    if (bold) out.bold = bold;
    const italic = slot(400, true);
    if (italic) out.italic = italic;
    const boldItalic = slot(700, true);
    if (boldItalic) out.boldItalic = boldItalic;
    return out;
  }

  /** Build and install the Type0 font object graph for every embedded font that
   *  was actually drawn, into the object slot reserved at draw time. Idempotent:
   *  re-running on a later Save rebuilds cleanly (old graphs become unreachable
   *  and are swept by the renumbering serializer). */
  private finalizeEmbeddedFonts(): void {
    for (const font of this.embeddedFonts) {
      if (font.objNum === undefined || font.usedGids.size === 0) continue;
      const type0 = buildEmbeddedFont(font.sfnt, font.usedGids, (obj) => this.allocObject(obj), font.toUnicode);
      this.objects.set(font.objNum, type0);
    }
  }

  // --- Digital signatures (sign side) ------------------------------------

  /** Add an (invisible) digital signature. Builds a `/Sig` AcroForm field with a
   *  zero-rect widget and a signature value dictionary, chooses the write path
   *  from document state (incremental append for an opened/already-signed file,
   *  full rewrite for a new/authored/mutated one), serializes with a `/Contents`
   *  placeholder, digests the `/ByteRange`, builds the detached CMS, and fills the
   *  placeholder. The finished bytes are returned by the next {@link Save}/
   *  {@link WriteTo}. Async because credential/timestamp callbacks may be (K1/T1).
   *
   *  `subFilter` selects `adbe.pkcs7.detached` (CMS, default) or
   *  `ETSI.CAdES.detached` (PAdES — adds the ESS signing-certificate-v2 attr). */
  async Sign(signer: Signer, opts: SignOptions = {}): Promise<void> {
    await this.signCore(signer, opts);
  }

  /** Add a *certification* (author) signature with a DocMDP transform: the
   *  signature carries a `/Reference` DocMDP entry and the catalog gains
   *  `/Perms /DocMDP` pointing at it, declaring which later changes are
   *  permitted (`opts.permissions`, default `no-changes`). A document may be
   *  certified only once and only before any approval signature; otherwise
   *  throws {@link UnsupportedFeatureError}. Otherwise identical to
   *  {@link Sign} (same credentials, write paths, optional visible appearance). */
  async Certify(signer: Signer, opts: CertifyOptions = {}): Promise<void> {
    // Probe the authoritative byte image (a pending in-session signature fills
    // /Contents only there, not the live model), else the live/opened state.
    const probe = this.pendingSignedBytes ? Document.Open(this.pendingSignedBytes) : this;
    if (probe.Signatures.some((s) => s.isSigned))
      throw new UnsupportedFeatureError('cannot certify: the document is already signed (certification must be the first signature)');
    if (Document.permsHasDocMdp(probe))
      throw new UnsupportedFeatureError('cannot certify: the document is already certified (DocMDP allows one certification)');
    await this.signCore(signer, opts, opts.permissions ?? 'no-changes');
  }

  /** Shared signing pipeline for {@link Sign} and {@link Certify}: validate,
   *  build the `/Sig` field, optionally attach a DocMDP transform + catalog
   *  `/Perms`, serialize with a `/Contents` placeholder, then digest and embed
   *  the detached CMS. */
  /** Refuse every incremental-append entry point on a recovered document.
   *  Appending exists to preserve the earlier signed bytes byte-for-byte; on a
   *  recovered document those bytes are by definition damaged, so the append
   *  would carry the damage forward and cover it with a signature. */
  private assertNotRecovered(what: string): void {
    if (!this.recovery) return;
    throw new PdfParseError(
      `cannot ${what} a recovered document: incremental signing appends to the `
      + 'original bytes, which are damaged. Save() first, then sign the result.',
    );
  }


  private async signCore(signer: Signer, opts: SignOptions, docMdp?: DocMdpPermission): Promise<void> {
    this.assertNotRecovered('sign');
    if (this.Pages.length === 0)
      throw new UnsupportedFeatureError('cannot sign a document with no pages');
    subFilterName(opts); // validate subfilter early
    if (opts.cades) {
      const c = opts.cades;
      const emitsLocation = !!c.signerLocation && (
        c.signerLocation.country !== undefined || c.signerLocation.locality !== undefined
        || (c.signerLocation.postalAddress !== undefined && c.signerLocation.postalAddress.length > 0));
      const emits = c.commitmentType !== undefined || emitsLocation;
      if (emits && opts.subFilter !== 'PAdES')
        throw new UnsupportedFeatureError('CAdES signed attributes require subFilter: "PAdES"');
      if (c.commitmentType !== undefined) commitmentTypeOid(c.commitmentType); // validate early (throws)
    }

    // Resolve credentials up front so a bad key/passphrase fails before the
    // document object map is mutated below.
    const resolved = await resolveSigner(signer);

    // Validate any visible-appearance request before mutating the object map.
    if (opts.appearance) {
      const { page, rect } = opts.appearance;
      if (!Number.isInteger(page) || page < 0 || page >= this.Pages.length)
        throw new UnsupportedFeatureError(`signature appearance: page ${page} is out of range`);
      const w = Math.abs(rect[2] - rect[0]), h = Math.abs(rect[3] - rect[1]);
      if (!(w > 1e-3) || !(h > 1e-3))
        throw new TypeError('signature appearance: rect must have a positive area');
    }

    // Materialize any pending fonts before the byte image is frozen.
    this.finalizeEmbeddedFonts();

    const useIncremental = this.choosePath();
    const placeholderBytes = opts.placeholderBytes ?? DEFAULT_PLACEHOLDER_BYTES;
    const signingTime = opts.signingTime ?? new Date();

    // Build the signature object graph: value dict + invisible widget/field,
    // wired into the AcroForm and the first page's /Annots.
    const sigValueDict = buildSigValueDict(opts, signingTime);
    const sigRef = this.allocObject(sigValueDict);
    const touched = this.installSignatureField(sigRef, opts, resolved.certificate, signingTime);

    // Certification: attach the DocMDP transform to the value dict and point the
    // catalog's /Perms /DocMDP at this signature (the catalog joins the delta).
    if (docMdp) {
      sigValueDict.set('Reference', [buildDocMdpReference(docMdp)]);
      const catalog = this.catalog();
      catalog.set('Perms', new Map<string, PdfObject>([['DocMDP', sigRef]]));
      const catRef = this.trailer.get('Root');
      if (isRef(catRef)) touched.add(catRef.num);
    }

    // Produce the placeholder byte image via the chosen writer.
    const layout = useIncremental
      ? appendSignatureUpdate(this.signBase(), {
        sigObjNum: sigRef.num,
        sigDict: sigValueDict,
        objects: this.collectObjects(touched),
        placeholderBytes,
        encryptor: this.preservedEncryptor,
      })
      : serializeSignedDocument(this.objects, this.trailer, { signatureObj: sigRef.num, placeholderBytes });

    // Digest the /ByteRange, build the detached CMS, drop it into /Contents.
    const cmsSigner: CmsSigner = {
      ...resolved,
      signingTime: resolved.signingTime ?? signingTime,
      timestamp: opts.timestamp,
      timestampDigest: opts.timestampDigest,
    };
    const digest = digestByteRange(layout.bytes, layout.byteRange, digestName(cmsSigner));
    // PAdES (ETSI.CAdES.detached) requires the ESS signing-certificate-v2 attr.
    const cms = await buildSignedData(digest, cmsSigner, {
      signingCertificateV2: opts.subFilter === 'PAdES',
      cades: opts.cades,
    });
    fillSignature(layout.bytes, layout, cms);

    this.pendingSignedBytes = layout.bytes;
    this.signedInSession = true;
  }

  /** Embed long-term-validation (LTV) data in a `/DSS` (PAdES-B-LT): for each
   *  existing signature, store its certificate chain plus the OCSP/CRL bytes
   *  returned by the `opts.getOCSP`/`opts.getCRL` callbacks, indexed by a `/VRI`
   *  entry, and append the store as an incremental update (existing signatures
   *  preserved verbatim). The result is returned by the next {@link Save}.
   *
   *  The document must already be signed. Async because the fetch callbacks may
   *  be. Read the data back with {@link VerifySignatures} (it consults `/DSS`
   *  automatically) or `dss.readDssMaterial`. */
  async AddValidationData(opts: ValidationDataOptions = {}): Promise<void> {
    this.assertNotRecovered('add validation data to');
    const base = this.pendingSignedBytes ?? this.originalBytes;
    if (!base)
      throw new UnsupportedFeatureError('AddValidationData requires a signed document');
    const src = Document.Open(base);
    const sigs = src.Signatures.filter((s) => s.isSigned);
    if (sigs.length === 0)
      throw new UnsupportedFeatureError('AddValidationData: the document has no signatures');

    // Gather per-signature validation data (chain + fetched OCSP/CRL).
    const entries: DssEntry[] = [];
    for (const sig of sigs) {
      if (!sig.contents) continue;
      const cms = sig.cmsLength !== undefined ? sig.contents.subarray(0, sig.cmsLength) : sig.contents;
      const parsed = parseSignedData(cms);
      const signer = parsed.signerCertificate;
      const issuer = findIssuer(signer, parsed.certificates);
      const certs = dedupBlobs([signer, ...parsed.certificates, ...(opts.extraCerts ?? [])]);
      const ocsps: Uint8Array[] = [];
      const crls: Uint8Array[] = [];
      if (opts.getOCSP) { const o = await opts.getOCSP(signer, issuer); if (o) ocsps.push(o); }
      if (opts.getCRL) { const c = await opts.getCRL(signer, issuer); if (c) crls.push(c); }
      entries.push({ vriKey: vriKey(sig.contents), certs, ocsps, crls });
    }

    // Build the /DSS object graph, point the catalog at it, and append.
    const before = new Set(this.objects.keys());
    const dssRef = buildDss(this, entries);
    this.catalog().set('DSS', dssRef);
    const collected = new Map<number, PdfObject>();
    for (const k of this.objects.keys()) if (!before.has(k)) collected.set(k, this.objects.get(k) ?? null);
    const catRef = this.trailer.get('Root');
    if (isRef(catRef)) collected.set(catRef.num, this.objects.get(catRef.num) ?? null);

    this.pendingSignedBytes = appendIncrementalUpdate(base, { objects: collected });
    this.signedInSession = true;
  }

  /** Append a document timestamp (`/DocTimeStamp`, ETSI.RFC3161) as an
   *  incremental update, enabling PAdES-B-LTA archival on top of B-LT. Builds an
   *  invisible signature field whose value dict is `/DocTimeStamp` and whose
   *  `/Contents` is the RFC 3161 token returned by `tsa` over the `/ByteRange`
   *  digest. Requires an existing byte image to append to; the result is returned
   *  by the next {@link Save}/{@link WriteTo}. Async because the TSA callback is. */
  async AddDocumentTimestamp(tsa: TimestampProvider, opts: DocumentTimestampOptions = {}): Promise<void> {
    this.assertNotRecovered('timestamp');
    const base = this.pendingSignedBytes ?? this.originalBytes;
    if (!base)
      throw new UnsupportedFeatureError('AddDocumentTimestamp requires an existing document to append to');
    if (this.Pages.length === 0)
      throw new UnsupportedFeatureError('cannot timestamp a document with no pages');
    this.finalizeEmbeddedFonts();

    const hashAlg: DigestAlgorithm = opts.digest ?? 'sha256';
    const placeholderBytes = opts.placeholderBytes ?? 16384;
    const fieldName = opts.fieldName ?? `Timestamp${this.nextDocTimestampIndex()}`;

    // Build the /DocTimeStamp value dict + an invisible widget wired into the
    // AcroForm and the first page's /Annots.
    const dtsDict = buildDocTimeStampDict();
    const dtsRef = this.allocObject(dtsDict);
    const touched = new Set<number>();
    const pageNum = this.pageObjNums[0];
    const widget: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Annot')],
      ['Subtype', name('Widget')],
      ['FT', name('Sig')],
      ['T', pdfString(fieldName)],
      ['Rect', [0, 0, 0, 0]],
      ['F', 132],
      ['V', dtsRef],
      ['P', ref(pageNum)],
    ]);
    this.attachSigWidget(widget, 0, touched);

    // Serialize with a /Contents placeholder + /ByteRange, then digest the range,
    // request a token, and drop the token in.
    const layout = appendSignatureUpdate(base, {
      sigObjNum: dtsRef.num,
      sigDict: dtsDict,
      objects: this.collectObjects(touched),
      placeholderBytes,
      encryptor: this.preservedEncryptor,
    });
    const imprint = digestByteRange(layout.bytes, layout.byteRange, hashAlg);
    const request = buildTimeStampRequest(imprint, hashAlg);
    const token = extractTimeStampToken(await tsa(request));
    fillSignature(layout.bytes, layout, token);
    this.pendingSignedBytes = layout.bytes;
    this.signedInSession = true;
  }

  /** Whether `doc`'s catalog carries a DocMDP certification (`/Perms /DocMDP`). */
  private static permsHasDocMdp(doc: Document): boolean {
    const perms = doc.resolve(doc.catalog().get('Perms'));
    return isDict(perms) && (perms as PdfDict).has('DocMDP');
  }

  /** Verify every signature in the document: recompute each `/ByteRange` digest,
   *  verify the detached CMS, and diff what changed after each signature. Returns
   *  one {@link SignatureReport} per signed field. Async for parity with the
   *  forthcoming chain/revocation/timestamp checks (no I/O in V1). */
  async VerifySignatures(opts: VerifyOptions = {}): Promise<SignatureReport[]> {
    const bytes = this.pendingSignedBytes ?? this.originalBytes;
    if (!bytes) return [];
    // Re-parse from the actual bytes so /ByteRange and /Contents are read as
    // written (the live model never holds the filled placeholder).
    const src = Document.Open(bytes);
    const signed = src.Signatures.filter((s) => s.isSigned);
    // Chain validation (V2) is synchronous; feed it any /DSS-embedded certs as
    // extra intermediates and validate against the caller's trust anchors.
    const chain = { trustAnchors: opts.trustAnchors, at: opts.at, extraCerts: readDssCerts(src) };
    const reports = signed.map((s) => verifySignature(bytes, s, chain));
    // Revocation: use explicit offline material or callbacks, else fall back to
    // any LTV validation data embedded in the document's /DSS (PAdES-B-LT).
    const offline = opts.offline ?? readDssMaterial(src);
    if (opts.getOCSP || opts.getCRL || offline.size > 0) {
      const revOpts: VerifyOptions = { ...opts, offline };
      await Promise.all(reports.map(async (report, i) => {
        report.revocation = await checkSignatureRevocation(signed[i], revOpts);
      }));
    }
    // PAdES baseline level (structural presence): B-B → B-T → B-LT → B-LTA.
    const docTsValid = src.DocumentTimestamps
      .filter((t) => t.isSigned)
      .some((t) => verifyDocumentTimestamp(bytes, t).timestamp.valid);
    const dssMaterial = readDssMaterial(src);
    const dssCerts = readDssCerts(src);
    reports.forEach((report) => {
      const hasT = report.timestamp?.valid === true || docTsValid;
      const hasLT = dssMaterial.has(report.name) || dssCerts.length > 0;
      const hasA = docTsValid;
      report.padesLevel = hasLT && hasA ? 'B-LTA' : hasLT ? 'B-LT' : hasT ? 'B-T' : 'B-B';
    });
    // DocMDP enforcement (V4): when the document is certified, evaluate the
    // changes appended after the certification signature against its level.
    Document.applyDocMdp(src, bytes, signed, reports);
    return reports;
  }

  /** Verify every document timestamp (`/DocTimeStamp`) in the document: check
   *  each token's message-imprint binding to the `/ByteRange` and the TSA's CMS
   *  signature, returning one {@link DocumentTimestampReport} per field. */
  async VerifyDocumentTimestamps(): Promise<DocumentTimestampReport[]> {
    const bytes = this.pendingSignedBytes ?? this.originalBytes;
    if (!bytes) return [];
    const src = Document.Open(bytes);
    return src.DocumentTimestamps.filter((t) => t.isSigned).map((t) => verifyDocumentTimestamp(bytes, t));
  }

  /** Set the certification signature's `docMDP` verdict (V4). Finds the field
   *  pointed at by catalog `/Perms /DocMDP`, reads its permitted level, and
   *  classifies the objects changed after the certified revision; non-cert
   *  signatures keep `n/a`. */
  private static applyDocMdp(
    src: Document, bytes: Uint8Array, signed: SignatureField[], reports: SignatureReport[],
  ): void {
    const perms = src.resolve(src.catalog().get('Perms'));
    if (!isDict(perms)) return;
    const certDict = src.resolve(perms.get('DocMDP'));
    if (!isDict(certDict)) return;
    const idx = signed.findIndex((s) => s.valueDict === certDict);
    if (idx < 0) return;
    const level = readDocMdpLevel(certDict, (o) => src.resolve(o));
    if (level === undefined) return;

    const sig = signed[idx];
    // Nothing appended after the certified revision → trivially within the level.
    if (sig.coversWholeFile || !sig.byteRange) { reports[idx].docMDP = 'ok'; return; }
    const signedEnd = sig.byteRange[2] + sig.byteRange[3];
    if (signedEnd >= bytes.length) { reports[idx].docMDP = 'ok'; return; }

    const prevDoc = Document.Open(bytes.subarray(0, signedEnd));
    const view = (d: Document): DocMdpDoc => ({ getObject: (n) => d.getObject(n), resolve: (o) => d.resolve(o ?? null) });
    const rootRef = src.trailer.get('Root');
    const acroRef = src.catalog().get('AcroForm');
    const env: DocMdpEnv = {
      prev: view(prevDoc), cur: view(src),
      catalogNum: isRef(rootRef) ? rootRef.num : -1,
      acroFormNum: isRef(acroRef) ? acroRef.num : undefined,
    };
    reports[idx].docMDP = docMdpVerdict(level, reports[idx].modifications, env);
  }

  /** Choose the write path: incremental append when an opened, unmodified (or
   *  already-signed) base byte image exists; full rewrite otherwise. */
  private choosePath(): boolean {
    if (this.hasExistingSignature()) {
      if (!this.signBaseAvailable())
        throw new UnsupportedFeatureError('cannot add a signature: no base byte image to append to');
      return true;
    }
    return this.signBaseAvailable() && !this.modified;
  }

  private signBaseAvailable(): boolean {
    return this.pendingSignedBytes !== undefined || this.originalBytes !== undefined;
  }

  /** The byte image an incremental update appends to (a prior signature's output,
   *  else the opened bytes). */
  private signBase(): Uint8Array {
    const base = this.pendingSignedBytes ?? this.originalBytes;
    if (!base) throw new UnsupportedFeatureError('cannot append: no base byte image');
    return base;
  }

  /** Snapshot the live values of `nums` for an incremental update's delta. */
  private collectObjects(nums: Set<number>): Map<number, PdfObject> {
    const out = new Map<number, PdfObject>();
    for (const n of nums) out.set(n, this.objects.get(n) ?? null);
    return out;
  }

  /** Allocate `widget`, attach it to page `pageIndex`'s `/Annots`, and ensure an
   *  `/AcroForm` carrying it as a field with the signature flags. Records every
   *  touched object number in `touched`; returns the widget's ref. Shared by
   *  {@link installSignatureField} and {@link AddDocumentTimestamp}.
   *
   *  The bootstrap itself is the same one field creation uses. What is signing-
   *  specific is only the delta bookkeeping — which the shared helpers take as
   *  an optional `touched` set — and `/SigFlags`. */
  private attachSigWidget(widget: PdfDict, pageIndex: number, touched: Set<number>): PdfRef {
    const page = this.Pages[pageIndex];
    if (!page) throw new UnsupportedFeatureError(`cannot attach signature widget: no page ${pageIndex}`);

    const widgetRef = this.allocObject(widget);
    touched.add(widgetRef.num);
    attachWidget(this, page, widgetRef, touched);

    const acro = ensureAcroForm(this, touched);
    appendField(this, acro, widgetRef, touched);
    // Signature fields exist (bit 1) and are append-only (bit 2).
    const flags = acro.get('SigFlags');
    acro.set('SigFlags', (typeof flags === 'number' ? flags : 0) | 3);

    return widgetRef;
  }

  private installSignatureField(
    sigRef: PdfRef, opts: SignOptions, certificate: Uint8Array, signingTime: Date,
  ): Set<number> {
    const touched = new Set<number>();
    const pageIndex = opts.appearance ? opts.appearance.page : 0;
    const pageNum = this.pageObjNums[pageIndex];

    const fieldName = opts.fieldName ?? `Signature${this.nextSignatureIndex()}`;
    const widget: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Annot')],
      ['Subtype', name('Widget')],
      ['FT', name('Sig')],
      ['T', pdfString(fieldName)],
      ['Rect', opts.appearance ? [...opts.appearance.rect] : [0, 0, 0, 0]],
      ['F', 132], // Print + LockedContents
      ['V', sigRef],
      ['P', ref(pageNum)],
    ]);

    // Generate the visible appearance (/AP /N), tracking every object it allocates
    // (form stream, font, image) so the incremental-update delta includes them.
    if (opts.appearance) {
      const displayName = signerDisplayName(opts, certificate);
      const text = opts.appearance.text ?? defaultAppearanceText(opts, signingTime, displayName);
      const before = new Set(this.objects.keys());
      const stream = buildSignatureAppearance(this, opts.appearance, text);
      const apRef = this.allocObject(stream);
      widget.set('AP', new Map<string, PdfObject>([['N', apRef]]));
      for (const k of this.objects.keys()) if (!before.has(k)) touched.add(k);
    }

    this.attachSigWidget(widget, pageIndex, touched);
    return touched;
  }

  /** 1-based index for the next auto-named signature field. */
  private nextSignatureIndex(): number {
    return this.Signatures.length + 1;
  }

  /** Whether the document already carries a signed signature field. */
  private hasExistingSignature(): boolean {
    return this.Signatures.some((s) => s.isSigned);
  }

  /** Every approval/certification signature field (read-side; always available).
   *  Document timestamps are excluded — see {@link DocumentTimestamps}. */
  get Signatures(): SignatureField[] {
    const out: SignatureField[] = [];
    const acro = this.resolve(this.catalog().get('AcroForm'));
    if (!isDict(acro)) return out;
    const fields = this.resolve(acro.get('Fields'));
    if (!isArray(fields)) return out;
    for (const f of fields) {
      const field = this.resolve(f);
      if (!isDict(field)) continue;
      const ft = field.get('FT');
      if (!isName(ft) || ft.name !== 'Sig') continue;
      const sig = this.readSignatureField(field);
      if (!sig.isDocTimeStamp) out.push(sig);
    }
    return out;
  }

  /** Every document-timestamp field (`/DocTimeStamp`), read-side. */
  get DocumentTimestamps(): SignatureField[] {
    const out: SignatureField[] = [];
    const acro = this.resolve(this.catalog().get('AcroForm'));
    if (!isDict(acro)) return out;
    const fields = this.resolve(acro.get('Fields'));
    if (!isArray(fields)) return out;
    for (const f of fields) {
      const field = this.resolve(f);
      if (!isDict(field)) continue;
      const ft = field.get('FT');
      if (!isName(ft) || ft.name !== 'Sig') continue;
      const sig = this.readSignatureField(field);
      if (sig.isDocTimeStamp) out.push(sig);
    }
    return out;
  }

  /** 1-based index for the next auto-named document-timestamp field. */
  private nextDocTimestampIndex(): number {
    return this.DocumentTimestamps.length + 1;
  }

  private readSignatureField(field: PdfDict): SignatureField {
    const nameObj = field.get('T');
    const fieldName = isString(nameObj) ? new TextDecoder().decode(nameObj.bytes) : '';
    const value = this.resolve(field.get('V'));
    if (!isDict(value)) {
      return { name: fieldName, subFilter: '', isSigned: false, valueDict: new Map(), coversWholeFile: false, isDocTimeStamp: false };
    }
    const sf = value.get('SubFilter');
    const subFilter = isName(sf) ? sf.name : '';
    const typeObj = value.get('Type');
    const isDocTimeStamp = (isName(typeObj) && typeObj.name === 'DocTimeStamp') || subFilter === 'ETSI.RFC3161';
    const br = this.resolve(value.get('ByteRange'));
    const byteRange = isArray(br) && br.length === 4 && br.every((x) => typeof x === 'number')
      ? (br as number[] as [number, number, number, number]) : undefined;
    const contentsObj = value.get('Contents');
    const contents = isString(contentsObj) ? contentsObj.bytes : undefined;
    const cmsLength = contents ? derTotalLength(contents) : undefined;
    const coversWholeFile = byteRange !== undefined && byteRange[0] === 0 &&
      this.originalBytes !== undefined && byteRange[2] + byteRange[3] === this.originalBytes.length;
    return {
      name: fieldName, subFilter, isSigned: contents !== undefined, valueDict: value,
      byteRange, contents, cmsLength, coversWholeFile, isDocTimeStamp,
    };
  }

  /** Serialize and write to a file path (synchronous), mirroring OpenFile. */
  WriteTo(fileName: string, options: SaveOptions = {}): void {
    writeFileSync(fileName, this.Save(options));
  }

  getObject(num: number): PdfObject {
    return this.objects.get(num) ?? null;
  }

  /** The root /Pages object number, or throw when /Pages is inline (not indirect). */
  private requireIndirectPagesRoot(): number {
    if (this.rootPagesNum === undefined)
      throw new UnsupportedFeatureError('cannot modify pages: /Pages is not an indirect reference');
    return this.rootPagesNum;
  }

  /** Refs for the current pages in order; throws if any page is an inline leaf. */
  private currentKids(): PdfObject[] {
    return this.pageObjNums.map((num) => {
      if (num === 0)
        throw new UnsupportedFeatureError('cannot modify pages: a page is not an indirect object');
      return ref(num);
    });
  }

  /** Write Kids/Count into the root /Pages node and rebuild Pages + pageObjNums. */
  private syncPages(kids: PdfObject[]): void {
    this.markModified();
    const rootNum = this.requireIndirectPagesRoot();
    const rootNode = this.objects.get(rootNum);
    const pagesNode: PdfDict = isDict(rootNode) ? rootNode : new Map<string, PdfObject>();
    pagesNode.set('Type', name('Pages'));
    pagesNode.set('Kids', kids);
    pagesNode.set('Count', kids.length);
    this.objects.set(rootNum, pagesNode);
    const tree = buildPages(this);
    this.Pages.length = 0;
    this.Pages.push(...tree.pages);
    this.pageObjNums = tree.pageObjNums;
  }

  /** Create a blank page object of `format` (default {@link PageFormat.A4})
   *  parented to rootNum; return its object number. */
  private createBlankPage(rootNum: number, format: PageFormat = PageFormat.A4): number {
    const num = this.maxObjNum() + 1;
    const page: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Page')],
      ['Parent', ref(rootNum)],
      ['MediaBox', format.mediaBox()],
      ['Resources', new Map<string, PdfObject>()],
    ]);
    this.objects.set(num, page);
    return num;
  }

  /** Deep-copy `srcPage` (from `srcDoc`) into this document with fresh object
   *  numbers; return the new page object's number, parented to `rootNum`. */
  private importPage(srcDoc: Document, srcPage: PdfDict, rootNum: number): number {
    if (!isDict(srcPage)) throw new Error('AddPage/InsertPage: source is not a page dict');
    // extractPage yields a self-contained graph numbered 1..k with /Parent
    // dropped and annotations sanitized; offset those numbers past our max.
    const { objects: sub, pageNum } = extractPage(srcDoc, srcPage, defaultPrunePolicy());
    const offset = this.maxObjNum();
    for (const [num, obj] of sub) {
      offsetRefs(obj, offset);
      this.objects.set(num + offset, obj);
    }
    const newNum = pageNum + offset;
    const page = this.objects.get(newNum);
    if (isDict(page)) {
      page.set('Parent', ref(rootNum));
      if (!page.has('Type')) page.set('Type', name('Page'));
    }
    return newNum;
  }

  /** Insert a page so it becomes 1-based page `at` (1..Pages.length+1): a blank
   *  page (of `source` when it is a {@link PageFormat}, else {@link PageFormat.A4}),
   *  or a deep copy of `source` when it is a {@link Page} (from this or another
   *  Document, keeping that page's own size). Returns the new live Page and its
   *  number. Throws RangeError when `at` is out of range. */
  InsertPage(at: number, source?: Page | PageFormat): { page: Page; number: number } {
    const rootNum = this.requireIndirectPagesRoot();
    const n = this.Pages.length;
    if (!Number.isInteger(at) || at < 1 || at > n + 1)
      throw new RangeError(`InsertPage: position ${at} out of range 1..${n + 1}`);
    const copyFrom = source instanceof Page ? source : undefined;
    const format = source instanceof PageFormat ? source : undefined;
    const kids = this.currentKids();
    const newNum = copyFrom === undefined
      ? this.createBlankPage(rootNum, format)
      : this.importPage(copyFrom.Document, copyFrom.Dict, rootNum);
    kids.splice(at - 1, 0, ref(newNum));
    this.syncPages(kids);
    if (copyFrom !== undefined) {
      const srcDoc = copyFrom.Document;
      preserveStructure(this, [{ srcDoc, srcPageNum: srcDoc.pageObjNums[copyFrom.Number - 1], newPageNum: newNum }]);
    }
    return { page: this.Pages[at - 1], number: at };
  }

  /** Append a page: a blank page (of `source` when it is a {@link PageFormat},
   *  else {@link PageFormat.A4}), or a deep copy of `source` when it is a
   *  {@link Page}. Returns the new Page and its 1-based number. */
  AddPage(source?: Page | PageFormat): { page: Page; number: number } {
    return this.InsertPage(this.Pages.length + 1, source);
  }

  /** Create a {@link Flow} layout container bound to this document. Queue content
   *  with `AddParagraph`/`AddColumnBreak`, then call `Render()` to append the
   *  laid-out pages to the end of this document. */
  NewFlow(options?: FlowOptions): Flow {
    return new Flow(this, options);
  }

  /** Render a whole Markdown document, appending freshly sized pages to the end
   *  of this document. The one-call form of `NewFlow` + `AddMarkdown` +
   *  `Render`; `options` carries both the Markdown options (`gfm`, `style`,
   *  `resolveImage`) and the flow's page geometry (`format`, `columns`,
   *  `margin*`, `tagged`, `lang`).
   *
   *  `title` is accepted here and on neither of the other two entry points:
   *  this is the one that authors a whole document, while `Flow.AddMarkdown`
   *  and `Page.AddMarkdown` append to a document whose title is someone else's
   *  business. It writes `/Info /Title`, XMP `dc:title` and
   *  `/ViewerPreferences /DisplayDocTitle` together — a title without the flag
   *  satisfies neither PDF/UA nor the caller's intent. */
  AddMarkdown(
    src: string | MdDocument,
    options: MarkdownFlowOptions & FlowOptions & {
      /** Document title. Non-empty. Default: the document's title is untouched. */
      title?: string;
    } = {},
  ): { pages: Page[]; skipped: string[] } {
    // Validated before anything is allocated, so a rejected call leaves the
    // document byte-identical — the rule every authoring entry point follows.
    const title = options.title;
    if (title !== undefined && (typeof title !== 'string' || title === ''))
      throw new TypeError('title must be a non-empty string');
    const flow = new Flow(this, options);
    const { skipped } = flow.AddMarkdown(src, options);
    const pages = flow.Render();
    if (title !== undefined) {
      this.SetMetadata({ title });   // mirrors to XMP dc:title on its own
      this.DisplayDocTitle = true;
    }
    return { pages, skipped };
  }

  /** Render a whole HTML document, appending freshly sized pages to the end of
   *  this document. The one-call form of `NewFlow` + `AddHtml` + `Render`;
   *  `options` carries both the HTML options (`resolveFamily`) and the flow's
   *  page geometry (`format`, `columns`, `margin*`, `tagged`, `lang`).
   *
   *  The document's own `<title>` becomes the PDF title when no explicit
   *  `title` is given — an explicit one always wins. Unlike Markdown, which
   *  has no title construct, an HTML document STATES its title, so carrying it
   *  into `/Info /Title`, XMP `dc:title` and
   *  `/ViewerPreferences /DisplayDocTitle` reads the document rather than
   *  inventing a fact. All three are written together: a title without the
   *  flag satisfies neither PDF/UA nor the caller's intent.
   *
   *  That applies here and on neither of the other two entry points, which
   *  append to a document whose title is someone else's business. */
  AddHtml(
    src: string | HtmlDocument,
    options: HtmlFlowOptions & FlowOptions & {
      /** Document title. Non-empty. Default: the source's `<title>`, else the
       *  document's title is untouched. */
      title?: string;
    } = {},
  ): { pages: Page[]; skipped: NotRendered[]; unsupported: UnsupportedDeclaration[] } {
    // Validated before anything is allocated, so a rejected call leaves the
    // document byte-identical — the rule every authoring entry point follows.
    const explicit = options.title;
    if (explicit !== undefined && (typeof explicit !== 'string' || explicit === ''))
      throw new TypeError('title must be a non-empty string');
    // Parsed ONCE: the title is read from the tree the flow then lowers.
    const root = typeof src === 'string' ? parseHtml(src) : src;
    const flow = new Flow(this, options);
    // Placement-time reports (zch2.16). Collected into a LOCAL array and
    // concatenated on the way out, never appended to the array flow.AddHtml
    // already handed back — nothing may mutate under a caller. A caller's own
    // sink still fires.
    const late: NotRendered[] = [];
    const sink = (r: NotRendered): void => {
      late.push(r);
      options.onNotRendered?.(r);
    };
    const { skipped, unsupported } =
      flow.AddHtml(root, { ...options, onNotRendered: sink });
    const pages = flow.Render();
    const title = explicit ?? documentTitle(root);
    if (title !== undefined) {
      this.SetMetadata({ title });   // mirrors to XMP dc:title on its own
      this.DisplayDocTitle = true;
    }
    return { pages, skipped: [...skipped, ...late], unsupported };
  }

  /** Create a {@link FloatingBox} bound to this document. Add content with
   *  `AddParagraph`/`AddImage`, then float it into a flow with
   *  `flow.AddFloatBox(box, side)`. */
  NewFloatingBox(options: FloatBoxOptions): FloatingBox {
    return new FloatingBox(this, options);
  }

  /** Create a reusable tiling pattern (PDF PatternType 1): `draw` paints one
   *  tile into a builder scoped to tile space, and the pattern repeats on an
   *  `xStep` x `yStep` lattice wherever it is used.
   *
   *  The pattern is page-independent and allocated once — use it on as many
   *  pages as you like via `setFillPattern` / `setStrokePattern`, and each page
   *  registers the same object.
   *
   *  The lattice is pinned to the page's DEFAULT user space and ignores the
   *  CTM (32000-1 §8.7.3.1), exactly as a gradient is, so a `transform()`
   *  before the fill moves the shape and not the tiling; `x`, `y` and
   *  `rotation` (degrees counter-clockwise) are how you place it instead.
   *
   *  With `{ uncolored: true }` the tile carries shape only and the colour is
   *  given where the pattern is used, so one hatch serves every colour. Colour
   *  operators inside such a tile throw, since a viewer ignores them. */
  NewTilingPattern(
    width: number, height: number, draw: (g: VectorGraphics) => void,
    opts?: TilingPatternOptions & { uncolored?: false },
  ): ColoredTilingPattern;
  NewTilingPattern(
    width: number, height: number, draw: (g: VectorGraphics) => void,
    opts: TilingPatternOptions & { uncolored: true },
  ): UncoloredTilingPattern;
  NewTilingPattern(
    width: number, height: number, draw: (g: VectorGraphics) => void,
    opts: TilingPatternOptions = {},
  ): TilingPattern {
    return buildTilingPattern(this, width, height, draw, opts);
  }

  /** Create a reusable template: a Form XObject you draw once and place on any
   *  number of pages, allocated as a single object however often it is used.
   *
   *  `tpl.page` is an ordinary {@link Page} in template space
   *  (`[0, 0, width, height]`) that simply is not in this document's page tree,
   *  so `AddText`, `AddImage`, `AddTable`, `Graphics()` and `AddSVGObject` all
   *  work on it unchanged. The first `PlaceOn` builds the form and freezes the
   *  template; drawing into it afterwards throws.
   *
   *  Logical structure inside a template is not supported — tag the placement
   *  instead. */
  NewTemplate(width: number, height: number): Template {
    return new Template(this, width, height);
  }

  /** Whole-document import: deep-copy the given `pages` of `other` (default: all
   *  of them) into this.objects with fresh offset object numbers. Shared objects
   *  are copied once (one old->new map), inherited MediaBox/CropBox/Resources/Rotate
   *  are flattened onto each leaf, and /Annots are sanitized via defaultPrunePolicy.
   *  Each new leaf is re-parented to `rootNum`. Returns the new leaf object numbers
   *  in `pages` order. Does not mutate `other`. */
  private importPages(other: Document, rootNum: number, pages: Page[] = other.Pages): number[] {
    const policy = defaultPrunePolicy();
    const inheritable = ['MediaBox', 'CropBox', 'Resources', 'Rotate'];
    let next = this.maxObjNum();
    const map = new Map<number, number>(); // other old-num -> this new-num (dedup)
    const queue: PdfObject[] = [];

    // Clone an other-object on first sight, renumber, install, enqueue for rewrite.
    const remap = (r: PdfRef): PdfRef => {
      let nn = map.get(r.num);
      if (nn === undefined) {
        nn = ++next;
        map.set(r.num, nn);
        const cloned = cloneShallow(other.getObject(r.num));
        this.objects.set(nn, cloned);
        queue.push(cloned);
      }
      return ref(nn);
    };

    // Prepare each leaf: flatten inheritance (from the live source chain), drop
    // page keys, sanitize annots. Install with a fresh number; defer /Parent until
    // after the rewrite so rootNum (a THIS-document ref) is never remapped.
    const leafNums: number[] = [];
    for (const page of pages) {
      const src = page.Dict;
      const leaf: PdfDict = new Map(src);
      for (const key of inheritable) {
        if (!leaf.has(key)) {
          const v = inheritedValue(other, src, key);
          if (v !== null) leaf.set(key, v);
        }
      }
      for (const k of policy.dropPageKeys) leaf.delete(k);
      if (leaf.has('Annots')) {
        const annots = other.resolve(leaf.get('Annots'));
        leaf.set('Annots', isArray(annots) ? policy.sanitizeAnnots(other, annots) : []);
      }
      const leafNum = ++next;
      this.objects.set(leafNum, leaf);
      queue.push(leaf);
      leafNums.push(leafNum);
    }

    while (queue.length) rewriteRefs(queue.shift()!, remap);

    for (const num of leafNums) {
      const leaf = this.objects.get(num);
      if (isDict(leaf)) {
        leaf.set('Parent', ref(rootNum));
        if (!leaf.has('Type')) leaf.set('Type', name('Page'));
      }
    }
    return leafNums;
  }

  /** Insert every page of `other` so the first becomes 1-based page `at`
   *  (1..Pages.length+1), shifting existing pages down. Returns the new pages'
   *  1-based numbers in `other`'s order. Throws RangeError when `at` is out of
   *  range. `other` is not modified. */
  InsertPages(at: number, other: Document, options: InsertPagesOptions = {}): number[] {
    const rootNum = this.requireIndirectPagesRoot();
    const n = this.Pages.length;
    if (!Number.isInteger(at) || at < 1 || at > n + 1)
      throw new RangeError(`InsertPages: position ${at} out of range 1..${n + 1}`);
    const newNums = this.importPages(other, rootNum);
    if (newNums.length === 0) return [];
    const kids = this.currentKids();
    kids.splice(at - 1, 0, ...newNums.map((num) => ref(num)));
    this.syncPages(kids);
    if (options.preserveStructure ?? true) {
      const origins: PageOrigin[] = newNums.map((newNum, i) => ({
        srcDoc: other, srcPageNum: other.pageObjNums[other.Pages[i].Number - 1], newPageNum: newNum,
      }));
      preserveStructure(this, origins);
    }
    return newNums.map((_, i) => at + i);
  }

  /** Append every page of `other` to the end of this document. Returns the new
   *  pages' 1-based numbers. `other` is not modified; a 0-page `other` is a no-op
   *  returning []. */
  Append(other: Document, options: InsertPagesOptions = {}): number[] {
    return this.InsertPages(this.Pages.length + 1, other, options);
  }

  /** Build a new document from copies of all `docs`, in order. Every input is left
   *  unmodified. Equivalent to an empty doc with each input Append-ed. */
  static Merge(...docs: Document[]): Document {
    const out = Document.createEmptyDocument();
    for (const d of docs) out.Append(d);
    return out;
  }

  /** Remove a page by 1-based number or by Page handle. Throws RangeError when
   *  the number is out of range or the page does not belong to this document. */
  /** Redact regions on a single page (1-based `page` number); see `Page.Redact`. */
  Redact(page: number, rects: Rect[], opts?: RedactOptions): void {
    const n = this.Pages.length;
    if (!Number.isInteger(page) || page < 1 || page > n)
      throw new RangeError(`Redact: page number ${page} out of range 1..${n}`);
    this.Pages[page - 1].Redact(rects, opts);
  }

  /** Redact every occurrence of `find` across all pages; see `Page.RedactText`.
   *  Returns the total number of occurrences redacted. */
  RedactText(find: string | RegExp, opts?: RedactOptions): number {
    let total = 0;
    for (const page of this.Pages) total += page.RedactText(find, opts);
    return total;
  }

  /** Mark every occurrence of `find` across all pages; see `Page.MarkRedactText`.
   *  Returns the total number of occurrences marked. */
  MarkRedactText(find: string | RegExp, opts?: MarkRedactTextOptions): number {
    let total = 0;
    for (const page of this.Pages) total += page.MarkRedactText(find, opts);
    return total;
  }

  /** Apply every /Redact mark across all pages; see `Page.ApplyRedactions`.
   *  Returns the total number applied. */
  ApplyRedactions(opts?: ApplyRedactionsOptions): number {
    let total = 0;
    for (const page of this.Pages) total += page.ApplyRedactions(opts);
    return total;
  }

  /** Replace every occurrence of `find` with `replacement` across all pages; see
   *  `Page.ReplaceText`. Returns the total number of occurrences replaced. */
  ReplaceText(find: string | RegExp, replacement: string): number {
    let total = 0;
    for (const page of this.Pages) total += page.ReplaceText(find, replacement);
    return total;
  }

  /** Stamp a single source page onto many pages of this document as one shared
   *  Form XObject — letterheads, watermarks, backgrounds. `src` may be a `Page`
   *  or a `Document` (its first page is used); a cross-document source is left
   *  untouched. By default every page is stamped on top, fitted to its CropBox;
   *  use `pages` to select targets, `underlay` to draw behind, and `rect` /
   *  `opacity` / `rotate` to control placement. See `Page.StampWith`. */
  Overlay(src: Page | Document, opts?: OverlayOptions): void {
    overlay(this, src, opts ?? {});
  }

  /** Stamp a repeating text or image watermark across a page range. Provide
   *  exactly one of `text` or `image`. Text may carry `{page}`/`{total}`/
   *  `{label}`/`{date}`/`{time}` tokens, resolved per page. Positioning presets
   *  anchor to the page as displayed, so a stamp lands correctly (and upright)
   *  regardless of /Rotate. Defaults to a 30%-opacity diagonal underlay. */
  AddWatermark(opts: WatermarkOptions): void {
    addWatermark(this, opts);
  }

  /** Stamp header and/or footer text across a page range. Each band has up to
   *  three cells (`left`/`center`/`right`), and each cell may carry
   *  `{page}`/`{total}`/`{label}`/`{date}`/`{time}` tokens, resolved per page —
   *  e.g. `{ footer: { center: 'Page {page} of {total}' } }`. Cells anchor to the
   *  page as displayed, so they stay upright regardless of /Rotate. */
  AddHeaderFooter(opts: HeaderFooterOptions): void {
    addHeaderFooter(this, opts);
  }

  /** Stamp a Bates sequence across a page range (bottom-right, `{bates}`, 10pt
   *  by default). The counter follows the selection, not the page number, so a
   *  subset numbers contiguously from `start`. `digits` is a minimum width: a
   *  number that outgrows it simply widens. Returns the next unused number, so a
   *  sequence chains across a document set:
   *  `let n = 1; for (const d of docs) n = d.AddBatesNumbering({ start: n });` */
  AddBatesNumbering(opts: BatesOptions = {}): number {
    return addBatesNumbering(this, opts);
  }

  /** Impose this document's pages `cols`×`rows` per sheet into a **new**
   *  Document (this one is unmodified, like Split/ExtractPages). Each source page
   *  is imported as a shared Form XObject and placed scaled-to-fit, centered, in
   *  its grid cell; cells fill row-major by default (`order:'column'` fills down
   *  columns). The last sheet may be partly empty. The default sheet size is the
   *  first page's size times the grid (plus margins/gutters); pass `pageSize` to
   *  override. Throws RangeError for a grid dimension < 1. */
  NUp(cols: number, rows: number, opts: NUpOptions = {}): Document {
    if (!Number.isInteger(cols) || cols < 1) throw new RangeError(`NUp: cols ${cols} must be an integer >= 1`);
    if (!Number.isInteger(rows) || rows < 1) throw new RangeError(`NUp: rows ${rows} must be an integer >= 1`);
    const margin = opts.margin ?? 0, gutter = opts.gutter ?? 0;
    if (!Number.isFinite(margin) || margin < 0) throw new TypeError('NUp: margin must be a finite number >= 0');
    if (!Number.isFinite(gutter) || gutter < 0) throw new TypeError('NUp: gutter must be a finite number >= 0');
    const order = opts.order ?? 'row';
    if (order !== 'row' && order !== 'column') throw new TypeError("NUp: order must be 'row' or 'column'");
    if (opts.pageSize !== undefined &&
        (!Array.isArray(opts.pageSize) || opts.pageSize.length !== 2 ||
         !opts.pageSize.every((n) => Number.isFinite(n) && n > 0)))
      throw new TypeError('NUp: pageSize must be [w, h] (two positive numbers)');
    const border = resolveNUpBorder(opts.drawBorder); // validated before any allocation

    const src = this.Pages;
    if (src.length === 0) throw new RangeError('NUp: document has no pages');

    // Cell base size from the first page's CropBox (falls back to MediaBox).
    const [bx0, by0, bx1, by1] = src[0].CropBox;
    const baseW = Math.abs(bx1 - bx0), baseH = Math.abs(by1 - by0);
    const [sheetW, sheetH] = opts.pageSize ?? [
      cols * baseW + 2 * margin + (cols - 1) * gutter,
      rows * baseH + 2 * margin + (rows - 1) * gutter,
    ];
    const cellW = (sheetW - 2 * margin - (cols - 1) * gutter) / cols;
    const cellH = (sheetH - 2 * margin - (rows - 1) * gutter) / rows;

    // Cell rect for the k-th cell of a sheet (row 0 = top), honoring fill order.
    const cellRect = (k: number): [number, number, number, number] => {
      const col = order === 'row' ? k % cols : Math.floor(k / rows);
      const row = order === 'row' ? Math.floor(k / cols) : k % rows;
      const x0 = margin + col * (cellW + gutter);
      const y1 = sheetH - margin - row * (cellH + gutter); // cell top
      return [x0, y1 - cellH, x0 + cellW, y1];
    };

    const perSheet = cols * rows;
    const out = Document.createEmptyDocument();
    const rootNum = out.requireIndirectPagesRoot();
    const numSheets = Math.ceil(src.length / perSheet);
    const sheetNums: number[] = [];
    for (let s = 0; s < numSheets; s++) {
      const sheet: PdfDict = new Map<string, PdfObject>([
        ['Type', name('Page')],
        ['Parent', ref(rootNum)],
        ['MediaBox', [0, 0, sheetW, sheetH]],
        ['CropBox', [0, 0, sheetW, sheetH]],
        ['Resources', new Map<string, PdfObject>()],
      ]);
      sheetNums.push(out.allocObject(sheet).num);
    }
    out.syncPages(sheetNums.map((n) => ref(n)));

    for (let s = 0; s < numSheets; s++) {
      const sheet = out.Pages[s];
      // Frames are collected per sheet and stroked in one pass after the pages
      // are placed, so a frame sits on top of its cell's content rather than
      // under it, and one PageGraphics carries the whole grid.
      const framed: Array<[number, number, number, number]> = [];
      for (let k = 0; k < perSheet; k++) {
        const srcIdx = s * perSheet + k;
        if (srcIdx >= src.length) break;
        const cell = cellRect(k);
        placeFitted(out, sheet, src[srcIdx], cell);
        if (border) framed.push(cell);
      }
      if (border && framed.length > 0) {
        // One stroke per cell rather than one path of four subpaths: the frames
        // are independent rectangles, and this is how tablerender.ts draws cell
        // borders. The stroke state is set once for the whole grid.
        const g = new PageGraphics(out, sheet);
        g.setLineWidth(border.width).setStrokeColor(border.color);
        for (const [x0, y0, x1, y1] of framed) g.drawRect(x0, y0, x1 - x0, y1 - y0).stroke();
        g.apply();
      }
    }
    return out;
  }

  /** Impose this document's pages as a saddle-stitch booklet into a **new**
   *  Document (this one is unmodified, like NUp/Split/ExtractPages). Pages are
   *  padded to a multiple of 4 and reordered so that printing the result duplex
   *  and folding the stack down the middle reads in sequence: two source pages
   *  per printed side, each imported as a shared Form XObject and placed
   *  scaled-to-fit in its cell. `binding: 'right'` mirrors every side for an RTL
   *  book. `creep` compensates for the fore-edge push-out of nested sheets by
   *  shifting inner sheets' content toward the spine. Throws RangeError when the
   *  document has no pages. */
  Booklet(opts: BookletOptions = {}): Document {
    const binding = opts.binding ?? 'left';
    if (binding !== 'left' && binding !== 'right')
      throw new TypeError("Booklet: binding must be 'left' or 'right'");
    const margin = opts.margin ?? 0, gutter = opts.gutter ?? 0, creep = opts.creep ?? 0;
    if (!Number.isFinite(margin) || margin < 0)
      throw new TypeError('Booklet: margin must be a finite number >= 0');
    if (!Number.isFinite(gutter) || gutter < 0)
      throw new TypeError('Booklet: gutter must be a finite number >= 0');
    if (!Number.isFinite(creep) || creep < 0)
      throw new TypeError('Booklet: creep must be a finite number >= 0');
    if (opts.pageSize !== undefined &&
        (!Array.isArray(opts.pageSize) || opts.pageSize.length !== 2 ||
         !opts.pageSize.every((n) => Number.isFinite(n) && n > 0)))
      throw new TypeError('Booklet: pageSize must be [w, h] (two positive numbers)');
    const sheetsPerSignature = opts.sheetsPerSignature;
    if (sheetsPerSignature !== undefined &&
        (!Number.isInteger(sheetsPerSignature) || sheetsPerSignature < 1))
      throw new TypeError('Booklet: sheetsPerSignature must be an integer >= 1');
    if (opts.padSignatures !== undefined && typeof opts.padSignatures !== 'boolean')
      throw new TypeError('Booklet: padSignatures must be a boolean');
    // An option that cannot do anything is rejected, not ignored: padding to
    // full signatures is meaningless without a signature size.
    if (opts.padSignatures !== undefined && sheetsPerSignature === undefined)
      throw new TypeError('Booklet: padSignatures requires sheetsPerSignature');
    const padSignatures = opts.padSignatures ?? false;

    const src = this.Pages;
    if (src.length === 0) throw new RangeError('Booklet: document has no pages');

    // Cell base size from the first page's CropBox (falls back to MediaBox),
    // through NUp(2, 1)'s formula so the two features stay dimensionally
    // consistent: a booklet cell is exactly an N-up cell.
    const [bx0, by0, bx1, by1] = src[0].CropBox;
    const baseW = Math.abs(bx1 - bx0), baseH = Math.abs(by1 - by0);
    const [sheetW, sheetH] = opts.pageSize ?? [
      2 * baseW + 2 * margin + gutter,
      baseH + 2 * margin,
    ];
    const metrics: BookletMetrics = {
      sheetW, sheetH,
      cellW: (sheetW - 2 * margin - gutter) / 2,
      cellH: sheetH - 2 * margin,
      margin, gutter, creep,
    };

    const sides = bookletSides(src.length, { binding, sheetsPerSignature, padSignatures });
    const out = Document.createEmptyDocument();
    const rootNum = out.requireIndirectPagesRoot();
    const sheetNums: number[] = [];
    for (let i = 0; i < sides.length; i++) {
      const page: PdfDict = new Map<string, PdfObject>([
        ['Type', name('Page')],
        ['Parent', ref(rootNum)],
        ['MediaBox', [0, 0, sheetW, sheetH]],
        ['CropBox', [0, 0, sheetW, sheetH]],
        ['Resources', new Map<string, PdfObject>()],
      ]);
      sheetNums.push(out.allocObject(page).num);
    }
    out.syncPages(sheetNums.map((n) => ref(n)));

    for (let i = 0; i < sides.length; i++) {
      const side = sides[i];
      const sheet = out.Pages[i];
      const cells = bookletCells(metrics, side.sheet);
      // A null cell is a pad blank: place nothing, as NUp does for the unused
      // cells of a partial last sheet.
      if (side.left !== null) placeFitted(out, sheet, src[side.left - 1], cells.left);
      if (side.right !== null) placeFitted(out, sheet, src[side.right - 1], cells.right);
    }
    return out;
  }

  /** Flatten annotations on every page into static page content; see
   *  `Page.FlattenAnnotations`. Returns the total number flattened. */
  FlattenAnnotations(): number {
    let total = 0;
    for (const page of this.Pages) total += page.FlattenAnnotations();
    return total;
  }

  /** Flatten the interactive form into static page content: generate every
   *  field's appearance, bake each widget into its page at its /Rect, then drop
   *  the document /AcroForm. After this the form fields are no longer editable.
   *  Returns the number of widgets baked. */
  FlattenForm(): number {
    return flattenForm(this);
  }

  RemovePage(target: number | Page): void {
    this.requireIndirectPagesRoot();
    const n = this.Pages.length;
    let index: number;
    if (typeof target === 'number') {
      if (!Number.isInteger(target) || target < 1 || target > n)
        throw new RangeError(`RemovePage: page number ${target} out of range 1..${n}`);
      index = target - 1;
    } else {
      index = this.Pages.findIndex((p) => p.Dict === target.Dict);
      if (index === -1) throw new RangeError('RemovePage: page does not belong to this document');
    }
    const kids = this.currentKids();
    kids.splice(index, 1);
    this.syncPages(kids);
  }
}
