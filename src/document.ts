import { Lexer } from './lexer.js';
import type { FieldAppearanceOptions } from './formfield.js';
import { ObjectParser } from './object-parser.js';
import { readXref, XrefEntry, PdfRevision } from './xref.js';
import { sweepObjects, ObjCandidate, SweepResult } from './recover.js';
import {
  expandObjectStreams, findEncryptDict, rebuildTrailer, TrailerChoice,
} from './rebuild.js';
import { decodeObjStm, ObjStmDamage } from './objstm.js';
import { PdfObject, PdfDict, PdfRef, PdfStream, isRef, isDict, isStream, isName, isArray, isString, ref, name } from './types.js';
import { PdfParseError, UnsupportedFeatureError, InvalidPasswordError, ResourceLimitError, rethrowLimit } from './errors.js';
import { makeSearchable, type MakeSearchableOptions, type MakeSearchableReport } from './makesearchable.js';
import { summarize, type SummarizeOptions, type SummarizeResult } from './aisummarize.js';
import { ask, type AskOptions, type AskResult } from './aiask.js';
import { generateAltText, type AltTextOptions, type AltTextReport } from './aialttext.js';
import type { AiModel } from './aimodel.js';
import type { OcrEngine } from './ocr.js';
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
import { validatePdfUa, ValidationReport, type PdfUaPart } from './structvalidate.js';
import { validatePdfA, type PdfALevel } from './pdfavalidate.js';
import { convertToPdfA, type ConvertOptions, type ConversionReport } from './pdfaconvert.js';
import { convertToPdfUa, type PdfUaConvertOptions } from './pdfuaconvert.js';
import { validatePdfX, type PdfXLevel } from './pdfxvalidate.js';
import { convertToPdfX, type PdfXConvertOptions } from './pdfxconvert.js';
import { ensureStructTree } from './structwrite.js';
import { autoTag, type AutoTagOptions, type AutoTagReport } from './autotag.js';
import { inflateStream } from './flate.js';
import { readXmp, editXmpPacket, editXmpPacketWith, claimPrefix, mirrorMetaToXmp, mirrorXmpToMeta, XmpMetadata, XmpUpdate } from './xmp.js';
import { checkXmpWrite, toRdfValue, type XmpValueInput, type XmpWriteOptions } from './xmpwrite.js';
import { parseRdfPacket } from './xmprdf.js';
import { XmpValue, findXmpValue } from './xmpvalue.js';
import { planSync, infoSide, xmpSide, mirroredField, type MetadataSyncReport, type SyncDirection } from './metasync.js';
import { Page } from './page.js';
import { planReplace } from './textedit.js';
import { checkReplaceOptions, type ReplaceTextOptions } from './replacefont.js';
import { restyleDocument, type TextRestyle, type RestyleTextOptions } from './textrestyle.js';
import { stitchTables, type TableStitchOptions } from './tablestitch.js';
import type { Table, TableExtractOptions } from './tablemodel.js';
import type { Rect } from './text.js';
import type { RedactOptions } from './redact.js';
import { compareText, type CompareTextOptions, type TextComparison } from './compare.js';
import { planSideBySide, renderSideBySide, type SideBySideOptions, type SideBySideResult } from './comparesidebyside.js';
import { compareRendering, type RenderingCompareOptions, type RenderingComparison } from './comparerendering.js';
import type { ApplyRedactionsOptions, MarkRedactTextOptions } from './redactapply.js';
import { flattenForm } from './flatten.js';
import { optimizeDocument, OptimizeOptions, OptimizeReport } from './optimize.js';
import {
  convertColors, convertToGrayscale,
  ColorConvertOptions, ColorConvertReport, ConvertColorsOptions,
} from './colorconvert.js';
import { flattenLayers, type FlattenLayersReport } from './ocflatten.js';
import { sanitizeDocument, type SanitizeOptions, type SanitizeReport } from './sanitize.js';
import {
  convertXfaToAcroForm,
  type XfaConvertOptions, type XfaConvertReport,
} from './xfaconvert.js';
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
import { checkPageTree } from './pagecheck.js';
import type { ValidationIssue } from './validation.js';
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
  ViewerPreferences, ViewerPreferencesUpdate, readDisplayDocTitle,
  readViewerPreferences, setViewerPreferences,
} from './viewerprefs.js';
import {
  PageMode, PageLayout, readPageMode, setPageMode, readPageLayout, setPageLayout,
} from './pagemode.js';
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
import { readSeedValue, planSeedValue, type SeedValue } from './sigseed.js';
import { httpTimestampProvider } from './tsahttp.js';
import {
  readFieldLock, readFieldMdpLock, fieldMdpReference, isLocked, lockLevelP, encodeFieldLock, readLockLevel,
  type FieldLock,
} from './siglock.js';
import { DEFAULT_PLACEHOLDER_BYTES, fillSignature } from './sigplaceholder.js';
import { buildTimeStampRequest, extractTimeStampToken, type TimestampProvider } from './rfc3161.js';
import { Flow, normalizeFlowOptions, type FlowOptions } from './flow.js';
import { checkOnSkipped, type MarkdownFlowOptions } from './mdflow.js';
import { documentTitle, type HtmlFlowOptions } from './htmlflow.js';
import { openDocxSource, checkDocxOptions, type DocxFlowOptions, type DocxSkipped } from './wmlimport.js';
import { SkipLog, mergeSkipped } from './wmlflow.js';
import { parseHtml } from './htmltree.js';
import type { HtmlDocument } from './htmldom.js';
import type { UnsupportedDeclaration } from './cssprop.js';
import type { NotRendered } from './htmlreport.js';
import type { MdDocument } from './mdast.js';
import { FloatingBox, type FloatBoxOptions } from './floatbox.js';
import { PageFormat } from './pageformat.js';
import { LoadLimits } from './loadlimits.js';
import { DecodeBudget, registerStream } from './decodebudget.js';
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
import { parseSfnt, type SfntFont } from './sfnt.js';
import { EmbeddedFont } from './embeddedfont.js';
import { buildEmbeddedFont } from './fontembed.js';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { systemFontFolders, indexFolder, peekCmap, type FaceRecord } from './fontsource.js';
import { readFontNames } from './fontnames.js';
import {
  matchChain, deriveStyle, clampWeight,
  type LoadFontOptions, type FontMatch, type FontFamily,
} from './fontmatch.js';

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
  /** Bounds on what this document may cost to open (`ibzo`). Defaults to
   *  {@link LoadLimits.defaults}; pass `LoadLimits.unlimited()` for input you
   *  trust. Reads back as {@link Document.loadLimits}.
   *
   *  A `LoadLimits` and never a bare patch: one shape at the boundary, so every
   *  value reaching a document has been through that class's own validation.
   *  `LoadLimits.defaults.with({ ... })` is how a caller tweaks one field. */
  limits?: LoadLimits;
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

/** The page attributes 7.7.3.4 makes inheritable. */
const INHERITABLE_PAGE_KEYS = ['MediaBox', 'CropBox', 'Resources', 'Rotate'] as const;

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

/** A prepared signature field Sign fills instead of creating a new one. */
interface SignTarget {
  /** The terminal field dict (/FT /Sig), which receives /V. */
  field: PdfDict;
  /** Its one widget — the field itself when the two are merged. */
  widget: PdfDict;
  /** 0-based page carrying the widget. */
  pageIndex: number;
  /** The field's seed value (`/SV`), when it states one. */
  seed?: SeedValue;
  /** The field's lock (`/Lock`), when it states one. */
  lock?: FieldLock;
}

/** Whether `Flow` would accept this geometry: the probe `doc.AddDocx` asks before
 *  letting a document's own page margins reach the constructor. */
function flowGeometryFits(options: FlowOptions): boolean {
  try {
    normalizeFlowOptions(options);
    return true;
  } catch (caught) { rethrowLimit(caught);
    if (caught instanceof TypeError) return false;
    throw caught;
  }
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
  /** Folders to search when RENDERING a non-embedded font, in registration
   *  order. Separate from {@link fontFolders} on purpose: reusing that list
   *  would change what an existing caller's pages look like merely because
   *  they registered a folder for `AddText`. */
  private readonly renderFontFolders: { dir: string; sniff: boolean }[] = [];
  /** Parsed render substitute faces, keyed `path#faceIndex`. `null` marks one
   *  that would not parse, so it is not retried. */
  private readonly renderFaces = new Map<string, SfntFont | null>();
  /** Faces supplied as BYTES, in registration order. Their records are stored
   *  rather than rebuilt, so {@link renderFontFaces} hands back the SAME
   *  objects every call and {@link byteFaces} can key on their identity. */
  private readonly renderByteFaces: FaceRecord[] = [];
  /** The parsed face behind each byte-supplied record, keyed by the record
   *  ITSELF. Identity rather than `path`, because a byte face's `path` is a
   *  cosmetic label and a real file could in principle bear the same name. */
  private readonly byteFaces = new Map<FaceRecord, SfntFont>();
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
  /** @internal `Form.EnforceRules` (jzn8). Lives on the Document because
   *  `doc.Form` is rebuilt per access. */
  formEnforceRules = false;
  /** The finished signed byte image cached by {@link Sign}; returned verbatim by
   *  {@link Save}/{@link WriteTo} so the signed bytes are never re-serialized. */
  private pendingSignedBytes?: Uint8Array;
  /** Set once this session produced signed bytes, and NEVER cleared -- unlike
   *  `pendingSignedBytes`, which `markModified` clears. From that moment the
   *  live model is permanently behind the bytes for the signature object, so an
   *  incremental save is unsafe whether or not anything was edited after. */
  private signedInSession = false;
  /** Set once {@link Sanitize} has run, and never cleared. An incremental save
   *  APPENDS to the bytes this document was opened from, and those bytes still
   *  hold everything Sanitize removed — so it is refused from then on, even
   *  when this run found nothing, rather than trusting a count (`74mf.4`). */
  private sanitizedInSession = false;
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

  /** The resource policy this document was opened under (`ibzo`) — what the
   *  caller passed as {@link OpenOptions.limits}, else {@link
   *  LoadLimits.defaults}. Always a complete policy, never the patch a caller
   *  wrote, so reading a field here always answers.
   *
   *  **Invariant (`ibzo.2`):** it is set in the CONSTRUCTOR, before the page
   *  tree is walked, because that walk is bounded by it. Assigned after
   *  construction, as it was until `ibzo.2`, the page tree ran under the
   *  defaults whatever the caller asked for — a lower limit silently had no
   *  effect on the one graph `Open` itself walks.
   *
   *  The parse boundary (`ibzo.2`) is enforced; the filter and codec boundary
   *  (`ibzo.3`) and the content and render boundary (`ibzo.4`) are not yet. */
  loadLimits: LoadLimits;

  /** @internal What this document's streams have cost to decode (`ibzo.3`),
   *  shared by every stream registered to it. See `decodebudget.ts`. */
  readonly decodeBudget: DecodeBudget;

  private constructor(
    /** Every indirect object, eagerly parsed and live-mutable. */
    private readonly objects: Map<number, PdfObject>,
    readonly trailer: PdfDict,
    limits: LoadLimits = LoadLimits.defaults,
    budget?: DecodeBudget,
  ) {
    this.loadLimits = limits;
    this.decodeBudget = budget ?? new DecodeBudget(limits);
    // Every stream the document holds decodes under its policy, whether it was
    // parsed, merged in or built by `New` — the constructor is the one place
    // all three pass through. Re-registering a parsed stream is a no-op.
    for (const obj of objects.values()) if (isStream(obj)) registerStream(obj, this.decodeBudget);
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

    this.flattenToRoot();
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
        this.install(num, clone);
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
    const limits = opts.limits ?? LoadLimits.defaults;
    // Before anything is read. The bound is on what a caller handed us, so it is
    // checked once against the whole input rather than per structure.
    limits.enforce('maxFileBytes', buf.length, 'input');
    // One decode budget for the whole Open, shared by every build pass and then
    // by the document, so object streams decoded while parsing count against
    // the same running total as everything decoded afterwards.
    const budget = new DecodeBudget(limits);
    let entries = new Map<number, XrefEntry>();
    let trailer: PdfDict | undefined;
    let xrefFailure: RecoveryReport | undefined;
    let revisions: PdfRevision[] = [];
    try {
      const r = readXref(buf, limits);
      entries = r.entries;
      trailer = r.trailer;
      revisions = r.revisions;
    } catch (e) { rethrowLimit(e);
      // A bound reached is not damage: sweeping here is exactly the brute-force
      // scan over a hostile file the bound just refused.
      if (e instanceof ResourceLimitError) throw e;
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
      const sweep = sweepObjects(buf, limits);
      // dxfk.1's first message, preserved: "nothing in the file" and "objects
      // but no catalog" mean very different things to a caller.
      if (sweep.candidates.size === 0) throw new PdfParseError('no indirect objects found');
      const merged = new Map<number, XrefEntry>();
      for (const [num, list] of sweep.candidates) {
        const c = list[list.length - 1];
        merged.set(num, { type: 'offset', offset: c.offset, gen: c.gen });
      }
      // A surviving trailer always wins; synthesis runs only when there is none.
      const existing = Document.recoverTrailer(buf, sweep, merged, limits);
      // With no trailer there is no /Encrypt reference and no /ID. The dict is
      // findable by shape; /ID is not findable at all, and whether that is fatal
      // depends on the handler: R>=5 (AES-256) and PubSec derive their key
      // without it, R<=4 hashes it into the key and cannot.
      let encrypt: { num: number; dict: PdfDict } | undefined;
      if (!existing) {
        encrypt = findEncryptDict(merged, (n) => {
          const e = merged.get(n);
          if (!e || e.type !== 'offset') return null;
          return new ObjectParser(new Lexer(buf, e.offset), undefined, limits).parseIndirectObject().value;
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
      const pass = Document.build(buf, merged, provisional, opts, sweep.candidates, budget);
      let recovered = existing;
      if (!recovered) {
        const rebuilt = rebuildTrailer(pass.objects, merged, encrypt);
        recovered = rebuilt.trailer;
        xrefFailure.trailer = rebuilt.chosen;
      }
      xrefFailure.repaired = [...merged.keys()];
      xrefFailure.lost = [...pass.failed, ...pass.lostInObjStm];
      if (pass.objStmDamage.length > 0) xrefFailure.objectStreams = pass.objStmDamage;
      const doc = new Document(pass.objects, recovered, limits, budget);
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

    let pass = Document.build(buf, entries, trailer, opts, undefined, budget);

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
      const sweep = sweepObjects(buf, limits);
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
      pass = Document.build(buf, merged, trailer, opts, sweep.candidates, budget);
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

    const doc = new Document(pass.objects, trailer, limits, budget);
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
    buf: Uint8Array, sweep: SweepResult, entries: Map<number, XrefEntry>, limits: LoadLimits,
  ): PdfDict | undefined {
    for (const at of sweep.trailerOffsets) {
      try {
        const d = new ObjectParser(new Lexer(buf, at), undefined, limits).parseObject();
        if (isDict(d) && d.get('Root') !== undefined) return d;
      } catch (e) { rethrowLimit(e); /* try the next one */ }
    }
    for (const e of entries.values()) {
      if (e.type !== 'offset') continue;
      try {
        const v = new ObjectParser(new Lexer(buf, e.offset), undefined, limits).parseIndirectObject().value;
        if (!isStream(v)) continue;
        const t = v.dict.get('Type');
        if (isName(t) && t.name === 'XRef' && v.dict.get('Root') !== undefined) return v.dict;
      } catch (err) { rethrowLimit(err); /* try the next one */ }
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
    budget: DecodeBudget,
  ): BuildResult {
    const limits = opts.limits ?? LoadLimits.defaults;
    // Raw (un-decrypted) resolver for the /Encrypt dict and /ID — these are never
    // encrypted, and must be read before a Decryptor exists.
    const rawObject = (num: number): PdfObject => {
      const e = entries.get(num);
      if (!e || e.type !== 'offset') return null;
      const p = new ObjectParser(new Lexer(buf, e.offset), (lenObj) => {
        const r = isRef(lenObj) ? rawObject(lenObj.num) : lenObj;
        return typeof r === 'number' ? r : undefined;
      }, limits);
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
          }, limits);
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
            const r = decodeObjStm(s, entry.streamObj, limits);
            if (r.damage) damagedStreams.set(entry.streamObj, r.damage);
            map = r.objects;
            objStmCache.set(entry.streamObj, map);
          }
          // A number the container declared but did not produce resolves to
          // null, per the spec rule for a reference to a non-existent object.
          value = map.get(num) ?? null;
          // Objects from an object stream are already plaintext — do not decrypt.
        }
        if (isStream(value)) registerStream(value, budget);
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
      const ex = expandObjectStreams(entries, parseEntry, limits);
      // What the containers DECLARED joins what the sweep found; together they
      // are the objects this recovery will try to build.
      limits.enforce('maxObjects', entries.size, 'recovered objects');
      repaired.push(...ex.added);
      for (const d of ex.damaged) damagedStreams.set(d.container, d);
    }

    for (const num of entries.keys()) {
      try {
        parseEntry(num);
      } catch (e) {
        rethrowLimit(e);
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
          } catch (e) {
            rethrowLimit(e);
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
        } catch (e) {
          rethrowLimit(e);
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
    // From the SIZE, before reading: reading first is the exhaustion the bound
    // exists to prevent, and past 2 GiB readFileSync throws its own error, which
    // a caller could not tell from any other I/O failure. Open re-checks the
    // buffer, which costs nothing and covers a file that grew in between.
    (opts.limits ?? LoadLimits.defaults).enforce('maxFileBytes', statSync(fileName).size, fileName);
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
  /** The ONE place an object enters the live map (`ibzo.7`): a stream is tied
   *  to this document's decode budget on the way in, so it decodes under the
   *  caller's policy and is charged to the running total however it arrived —
   *  allocated, replaced, imported from another document or merged. Every other
   *  insertion site called `objects.set` directly, and a page brought in with
   *  `AddPage` decoded under the defaults. `test/limits-acquired.test.ts`
   *  fails the build naming any direct `this.objects.set` outside this method. */
  private install(num: number, obj: PdfObject): void {
    if (isStream(obj)) registerStream(obj, this.decodeBudget);
    this.objects.set(num, obj);
  }

  allocObject(obj: PdfObject): PdfRef {
    const n = this.maxObjNum() + 1;
    this.install(n, obj);
    this.markModified();
    return ref(n);
  }

  /** @internal Replace the object stored at `num` in place, so every existing
   *  indirect reference to it sees the new value (used to rewrite a shared
   *  stream — whose `raw` is immutable — without repointing each referrer). */
  replaceObject(num: number, obj: PdfObject): void {
    this.install(num, obj);
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

  /** One XMP property as a typed value (`o6uu.4`), found by namespace URI and
   *  local name among the packet's top-level properties; `undefined` when
   *  there is no packet, the property is absent, or the packet will not parse.
   *  Parsed under this document's `loadLimits`. */
  GetXmpValue(namespaceUri: string, propName: string): XmpValue | undefined {
    const md = this.resolve(this.catalog().get('Metadata'));
    if (!isStream(md)) return undefined;
    try {
      return findXmpValue(parseRdfPacket(inflateStream(md), this.loadLimits), namespaceUri, propName);
    } catch (e) {
      rethrowLimit(e);
      return undefined;
    }
  }

  /** Write one top-level XMP property from a typed value (`o6uu.8`); `null`
   *  deletes it. Everything the write does not name survives. The eight
   *  properties /Info shares are mirrored through `SyncMetadata`'s own rules,
   *  and a value /Info cannot represent deletes the /Info key rather than
   *  leaving it describing the old one. Validated before anything is touched
   *  (`TypeError`, `RangeError`), and the packet text is computed before /Info
   *  is edited, so a refusal changes nothing. */
  SetXmpValue(namespaceUri: string, propName: string, value: XmpValueInput | null, opts: XmpWriteOptions = {}): void {
    checkXmpWrite(namespaceUri, propName, value, opts);
    const md = this.resolve(this.catalog().get('Metadata'));
    const existing = isStream(md) ? inflateStream(md) : undefined;
    const text = editXmpPacketWith(existing, (p) => {
      const i = p.properties.findIndex((q) => q.ns === namespaceUri && q.name === propName);
      if (value === null) {
        if (i < 0) return false;
        p.properties.splice(i, 1);
        return true;
      }
      const prop = { ns: namespaceUri, name: propName, value: toRdfValue(value) };
      if (i < 0) p.properties.push(prop); else p.properties[i] = prop;
      if (opts.prefix !== undefined) claimPrefix(p, namespaceUri, opts.prefix);
      return true;
    }, this.loadLimits);
    // The mirror runs even when the packet did not change (`o6uu.12`): deleting
    // a property XMP never held must still delete the /Info key describing it,
    // and an /Info that disagrees with an unchanged packet is brought in line.
    // `planSync` writes only what differs, so agreement touches nothing.
    const field = mirroredField(namespaceUri, propName);
    if (field !== undefined) {
      const plan = planSync(infoSide(this.currentInfo(), (o) => this.resolve(o)),
        xmpSide(text !== undefined ? new TextEncoder().encode(text) : existing, this.loadLimits), 'xmpToInfo');
      const info: MetadataUpdate = {};
      // Unreadable for /Info (a struct title, a date that will not convert):
      // delete rather than keep /Info describing the value just replaced.
      if (plan.skipped.includes(field)) (info as Record<string, unknown>)[field] = null;
      else if (plan.changed.includes(field)) (info as Record<string, unknown>)[field] = plan.info[field];
      if (Object.keys(info).length > 0) applyUpdate(this.ensureInfo(), info);
    }
    if (text !== undefined) this.installXmpText(text);
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

  /** Add an invisible, exactly placed text layer to image-only pages so text
   *  extraction, search and copy-paste find their words (`3ywf.3`). Each
   *  selected page is rendered at `dpi` and handed to `engine`; the spans it
   *  returns are written in render mode 3 over a built-in glyphless font, so
   *  the page looks unchanged. Pages that already have text are skipped unless
   *  `force`. A failing page is reported and the run continues; an abort
   *  stops it. Refuses a document with signature fields. */
  MakeSearchable(engine: OcrEngine, opts?: MakeSearchableOptions): Promise<MakeSearchableReport> {
    return makeSearchable(this, engine, opts);
  }

  /** A summary of the selected pages from `model`. A document larger than one
   *  request is summarized in parts and the parts combined. Throws on a
   *  selection with no extractable text. */
  Summarize(model: AiModel, opts?: SummarizeOptions): Promise<SummarizeResult> {
    return summarize(this, model, opts);
  }

  /** An answer to `question` from `model`, drawn from the passages of the
   *  selected pages that best match it (ranked locally), with the pages it
   *  cites. `found` is false when those passages do not contain the answer,
   *  and then no pages are cited. A question too long to leave room for one
   *  passage within `maxInputChars` is a RangeError before any request. */
  Ask(model: AiModel, question: string, opts?: AskOptions): Promise<AskResult> {
    return ask(this, model, question, opts);
  }

  /** `/Alt` from `model` for every `/Figure` that lacks one. An untagged
   *  document has its pictures described and is then auto-tagged with those
   *  descriptions (`autoTag: false` refuses instead); one with no picture to
   *  describe is left untagged. A failing figure is reported and the run
   *  continues. Refuses a document with signature fields. */
  GenerateAltText(model: AiModel, opts?: AltTextOptions): Promise<AltTextReport> {
    return generateAltText(this, model, opts);
  }

  /** Validate the document against a curated, machine-checkable subset of
   *  PDF/UA (ISO 14289). `part` selects the standard: 1 (the default, ISO
   *  14289-1) or 2 (ISO 14289-2, the PDF 2.0 sibling). Read-only; never
   *  mutates. */
  ValidatePdfUa(part: PdfUaPart = 1): ValidationReport {
    return validatePdfUa(this, this.catalog(), part);
  }

  /** Validate the document against a curated, machine-decidable subset of
   *  PDF/A (ISO 19005, parts 1-3, levels b/u/a). Read-only; never mutates. */
  ValidatePdfA(level: PdfALevel): ValidationReport {
    return validatePdfA(this, this.catalog(), level);
  }

  /** Check the document's structural integrity (`dmin.4`): the catalog
   *  resolves to a `/Type /Catalog` whose `/Pages` is a `/Type /Pages` node,
   *  every page-tree node is reached once, every intermediate node's `/Count`
   *  agrees with the pages under it, every kid's `/Parent` is the node listing
   *  it, and every page has a `/MediaBox` on itself or above it.
   *
   *  Reads the raw object graph, so damage made through a live `Dict` after
   *  Open is visible. Two things are deliberately NOT failures: a
   *  back-reference (`/Parent`, `/P`, `/Prev` — the format requires them),
   *  and a reference to an object the file does not have, which 7.3.10 makes
   *  null. Never throws on a broken structure; see {@link Repair}. */
  Validate(): ValidationReport {
    return new ValidationReport(checkPageTree(this, false));
  }

  /** Fix, in place, what {@link Validate} reports about the page tree
   *  (`dmin.4`), keeping the file's tree shape: a shared node is copied, a
   *  `/Kids` cycle loses its back edge, a wrong `/Count` is recounted (and only
   *  there are `/Kids` entries naming nothing dropped), a stale `/Parent` is
   *  repointed, and a page with no `/MediaBox` anywhere gets US Letter — the
   *  size `Page.MediaBox` already reported for it. Returns the issues it
   *  fixed; afterwards `Validate().Passed` is true unless the catalog itself is
   *  invalid, which is not repairable.
   *
   *  On a sound document it returns `[]` and touches NOTHING, including the
   *  modified flag — a no-op that marked the document modified would turn a
   *  following sign into a full rewrite of bytes an earlier signature covered. */
  Repair(): ValidationIssue[] {
    const fixed = checkPageTree(this, true).filter((i) => i.rule !== 'CatalogInvalid');
    if (fixed.length === 0) return fixed;
    this.markModified();
    const tree = buildPages(this);
    this.Pages.length = 0;
    this.Pages.push(...tree.pages);
    this.pageObjNums = tree.pageObjNums;
    return fixed;
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
   *  together wherever this library sets either.
   *
   *  A named shorthand over {@link GetViewerPreferences}/{@link
   *  SetViewerPreferences}, which own the dictionary. It predates them and is
   *  kept because PDF/UA reaches for exactly this flag; note it reports `false`
   *  for a document that states nothing, where the accessor distinguishes that
   *  from a stated false. */
  get DisplayDocTitle(): boolean {
    return readDisplayDocTitle(this);
  }

  set DisplayDocTitle(v: boolean) {
    setViewerPreferences(this, { displayDocTitle: v });
  }

  /** Catalog /PageMode (32000-1 Table 28): which of a viewer's panels is open
   *  when the document opens — 'UseNone', 'UseOutlines', 'UseThumbs',
   *  'FullScreen', 'UseOC' or 'UseAttachments'.
   *
   *  'FullScreen' is what makes a viewer PRESENT the document rather than show
   *  it as a page in a window, which is what {@link Page.Transition} and
   *  {@link Page.Duration} need to describe a slide deck rather than a document
   *  that happens to carry transitions.
   *
   *  Reports only what the document STATES: `undefined` when it carries no
   *  /PageMode, never the 'UseNone' default. Read leniently — a name outside
   *  the enumeration reads as `undefined` rather than throwing. Assign `null`
   *  to remove the entry. */
  get PageMode(): PageMode | undefined {
    return readPageMode(this);
  }

  set PageMode(v: PageMode | null) {
    setPageMode(this, v);
  }

  /** Catalog /PageLayout (32000-1 Table 28): how a viewer arranges pages when
   *  the document opens — 'SinglePage', 'OneColumn', 'TwoColumnLeft',
   *  'TwoColumnRight', 'TwoPageLeft' or 'TwoPageRight'.
   *
   *  The `...Left`/`...Right` pairs differ in which side the FIRST page falls
   *  on, which is what puts a cover opposite the right-hand first page of a
   *  book. Absent, lenient and `null`-deletable exactly as {@link PageMode} is;
   *  the default it does not state is 'SinglePage'. */
  get PageLayout(): PageLayout | undefined {
    return readPageLayout(this);
  }

  set PageLayout(v: PageLayout | null) {
    setPageLayout(this, v);
  }

  /** What the catalog /ViewerPreferences states about how this document should
   *  be opened and printed — 32000-1 Table 150 in full.
   *
   *  Only what the document STATES: an entry it does not carry is `undefined`
   *  rather than the spec default, so a stated `false` stays distinguishable
   *  from silence. Read leniently — a value of the wrong type or a name outside
   *  its enumeration reads as `undefined` rather than throwing. */
  GetViewerPreferences(): ViewerPreferences {
    return readViewerPreferences(this);
  }

  /** Merge `update` into the catalog /ViewerPreferences: `undefined` leaves an
   *  entry alone, `null` deletes it, a value sets it.
   *
   *  Only the keys `update` states are touched, so an entry this library does
   *  not model survives a read-modify-write. The dictionary is created on the
   *  first write and removed when its last entry goes. Throws `TypeError` for a
   *  value of the wrong kind and `RangeError` for one outside the permitted
   *  set, in both cases before anything is written. */
  SetViewerPreferences(update: ViewerPreferencesUpdate): void {
    setViewerPreferences(this, update);
  }

  /** @internal Map a page object ref to its Page handle, or undefined. */
  pageForRef(r: PdfRef): Page | undefined {
    const i = this.pageObjNums.indexOf(r.num);
    return i >= 0 ? this.Pages[i] : undefined;
  }

  /** Apply `update` to the document's XMP packet and install the result as
   *  the catalog's /Metadata stream (uncompressed). The packet is EDITED, not
   *  rebuilt (`o6uu.3`), so everything the update does not name survives.
   *  Writes nothing when there was no packet and the update adds nothing. The
   *  old object is dropped by the next Save() mark-sweep. */
  private installXmp(update: XmpUpdate): void {
    const text = this.xmpTextFor(update);
    if (text !== undefined) this.installXmpText(text);
  }

  /** The catalog packet with `update` applied, WITHOUT installing it — the
   *  one step of a metadata write that can throw, so a setter that also edits
   *  /Info computes it first (`o6uu.7`). Parsed under this document's
   *  limits. `undefined` means write nothing. */
  private xmpTextFor(update: XmpUpdate): string | undefined {
    const md = this.resolve(this.catalog().get('Metadata'));
    return editXmpPacket(isStream(md) ? inflateStream(md) : undefined, update, this.loadLimits);
  }

  /** @internal Install `text` as the catalog's /Metadata stream, uncompressed.
   *  The one place a packet becomes a stream — `installXmp` and the PDF/A
   *  extension-schema pass (`o6uu.6`) both end here. */
  installXmpText(text: string): void {
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Metadata')], ['Subtype', name('XML')],
    ]);
    const stream: PdfStream = { kind: 'stream', dict, raw: new TextEncoder().encode(text) };
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
    const walk = (r: PdfObject, depth: number): void => {
      let cur = r;
      if (isRef(cur)) this.loadLimits.enforce('maxNestingDepth', depth, 'outline');
      while (isRef(cur) && !seen.has(cur.num)) {
        seen.add(cur.num);
        const d = this.objects.get(cur.num);
        const next = isDict(d) ? d.get('Next') ?? null : null;
        if (isDict(d)) walk(d.get('First') ?? null, depth + 1);
        this.objects.delete(cur.num);
        cur = next;
      }
    };
    const root = this.objects.get(rootRef.num);
    if (isDict(root)) walk(root.get('First') ?? null, 1);
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
      alloc: (obj) => { const n = this.maxObjNum() + 1; this.install(n, obj); return n; },
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
    this.install(num, info);
    this.trailer.set('Info', ref(num));
    return info;
  }

  SetMetadata(update: MetadataUpdate): void {
    // XMP FIRST: it is the only half that can throw (a packet past the
    // document's limits), and computing it before /Info is touched keeps a
    // refused write from leaving /Info half-updated (`o6uu.7`).
    const xmpUpdate = mirrorMetaToXmp(update);
    const text = Object.keys(xmpUpdate).length === 0 ? undefined : this.xmpTextFor(xmpUpdate);
    applyUpdate(this.ensureInfo(), update);
    if (text !== undefined) this.installXmpText(text);
  }

  /** Set/replace the document XMP packet from `update` (merged over the current
   *  packet; `null` deletes a field), mirroring shared fields back into /Info. */
  SetXmp(update: XmpUpdate): void {
    this.installXmp(update);
    applyUpdate(this.ensureInfo(), mirrorXmpToMeta(update));
  }

  /** Make /Info and the XMP packet agree on the eight fields they share
   *  (`o6uu.4`): `'infoToXmp'` rewrites XMP from /Info, `'xmpToInfo'` the
   *  reverse. An exact mirror — a field the source lacks is deleted on the
   *  target — with dates converted between `D:` and ISO 8601 text, offset
   *  intact. Only differing fields are written; when the sides already agree
   *  nothing is touched and the document is NOT marked modified, so a later
   *  `Sign()` keeps its incremental path. `'infoToXmp'` never creates /Info
   *  and edits the packet in place, so foreign schemas survive. A source date
   *  that does not read leaves its target alone and is named in `skipped`.
   *
   *  `'xmpToInfo'` CREATES /Info when the document has none. ISO 19005-4
   *  permits /Info only beside a catalog `/PieceInfo`, and then holding
   *  `/ModDate` alone, so on a PDF/A-4 document it produces an
   *  `InfoRestriction` failure — sync `'infoToXmp'` there, or run
   *  `ConvertToPdfA('4')` afterwards to reduce /Info again. */
  SyncMetadata(direction: SyncDirection): MetadataSyncReport {
    if (direction !== 'infoToXmp' && direction !== 'xmpToInfo') {
      throw new RangeError(`SyncMetadata: direction must be 'infoToXmp' or 'xmpToInfo', got ${String(direction)}`);
    }
    const md = this.resolve(this.catalog().get('Metadata'));
    const plan = planSync(
      infoSide(this.currentInfo(), (o) => this.resolve(o)),
      xmpSide(isStream(md) ? inflateStream(md) : undefined, this.loadLimits),
      direction,
    );
    if (plan.changed.length > 0) {
      if (direction === 'infoToXmp') this.installXmp(plan.xmp);
      else applyUpdate(this.ensureInfo(), plan.info);
    }
    return { changed: plan.changed, skipped: plan.skipped };
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

  /** Convert the document's colour to `opts.to` in place — `'gray'`, `'rgb'`
   *  or `'cmyk'` — across page content, form XObjects, tiling patterns, Type 3
   *  glyph procedures, image XObjects, inline images, shadings and
   *  annotations. Every colour ends up in the target space, DeviceGray content
   *  included: a grey becomes pure K under `'cmyk'`, which renders identically.
   *
   *  Conversion is lossy in general and not reversible; the returned report
   *  lists what converted, by which route, and what could not. RGB→CMYK is a
   *  naive transform with no colour management, so the result is **not**
   *  colorimetrically correct — without the destination profile there is no way
   *  to know what ink these values produce.
   *
   *  Throws {@link RangeError} for an unknown target, before anything is
   *  converted, and {@link UnsupportedFeatureError} for a signed document,
   *  which converting would invalidate. */
  ConvertColors(opts: ConvertColorsOptions): ColorConvertReport {
    const { to, ...rest } = opts ?? ({} as ConvertColorsOptions);
    return convertColors(this, to, rest);
  }

  /** Convert the document's colour to DeviceGray in place: page content, form
   *  XObjects, tiling patterns, Type 3 glyph procedures, image XObjects,
   *  shadings and annotations. The named shorthand for
   *  {@link ConvertColors}`({ to: 'gray' })`, and byte-identical to it. Colour
   *  is discarded, so this is not reversible; the returned report lists what
   *  converted and what could not. Throws {@link UnsupportedFeatureError} for a
   *  signed document, which converting would invalidate. */
  ConvertToGrayscale(opts: ColorConvertOptions = {}): ColorConvertReport {
    return convertToGrayscale(this, opts);
  }

  /** Flatten optional content in place: keep only what the default
   *  configuration SHOWS, then take the vocabulary away.
   *
   *  Every marked-content span the configuration hides is DELETED from the
   *  content stream it sits in — page content, form XObjects, tiling patterns,
   *  Type 3 glyph procedures, soft-mask groups and annotation appearances alike
   *  — hidden XObject draws and hidden annotations go with them, every
   *  surviving `/OC` wrapper and `/OC` key is removed, and `/OCProperties` is
   *  deleted. The result renders exactly as the configuration rendered and is
   *  an ordinary PDF with no layers left to toggle.
   *
   *  One-way, and that is the point: the hidden content is gone rather than
   *  merely unreferenced, so a reader cannot get it back. Call
   *  {@link OptionalContent.ApplyConfiguration} first to choose which
   *  configuration is flattened.
   *
   *  An `/OC` operand that is an inline dictionary — or a name no
   *  `/Properties` entry claims — is left exactly as written rather than
   *  guessed at, so its content survives; the returned report counts those as
   *  `unresolved`.
   *
   *  Throws {@link UnsupportedFeatureError} for a signed document, which
   *  deleting content would invalidate. */
  FlattenLayers(): FlattenLayersReport {
    return flattenLayers(this);
  }

  /** Remove what this document carries beyond what it shows, in place, and
   *  report what was removed: metadata (/Info and every XMP packet), every
   *  action and script, attachments, annotations, the interactive form
   *  (flattened), optional content (flattened) and private application data.
   *  Every category is on by default; pass `false` for one to keep it. The
   *  exception is `pagesToImages`, which replaces every page with its
   *  rendering: it is lossy and must be asked for. A section of the report is
   *  `undefined` when its toggle was off.
   *
   *  One-way: what is removed is gone from the next {@link Save}. Removing XMP
   *  also removes any PDF/A or PDF/UA identification, so a conforming document
   *  stops claiming conformance.
   *
   *  Throws TypeError for an unknown option or a non-boolean value, and
   *  {@link UnsupportedFeatureError} for a signed document, both before
   *  anything changes. */
  Sanitize(opts: SanitizeOptions = {}): SanitizeReport {
    const report = sanitizeDocument(this, opts);
    this.sanitizedInSession = true;
    return report;
  }

  /** Convert this document's XFA form to a real `/AcroForm` field tree.
   *
   *  Fields whose template layout chain is positioned throughout get widgets
   *  with rects and appearance streams; every other field gets a geometry-less
   *  field dict, which {@link Form} still finds, fills and exports. `/XFA` and
   *  the catalog's `/NeedsRendering` are removed by default once something has
   *  converted — pass `{ removeXfa: false }` to keep them.
   *
   *  The returned {@link XfaConvertReport} names what did not convert, and is
   *  the first place to look when a converted document is missing a field or
   *  renders nothing. `report.dataOnly` says the document converted to data and
   *  renders nothing at all, which is what a dynamic XFA form does: this makes
   *  its fields addressable, it does not build the pages the layout engine
   *  would have.
   *
   *  Conversion is one-way — nothing is written back into the XFA packets — and
   *  the dynamic layout engine is not implemented, so a field under any flow
   *  layout gets no geometry, ever, and is reported rather than guessed at.
   *
   *  Throws {@link UnsupportedFeatureError} for a signed document, which adding
   *  fields would invalidate. */
  ConvertXfaToAcroForm(opts: XfaConvertOptions = {}): XfaConvertReport {
    return convertXfaToAcroForm(this, opts);
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
    if (this.sanitizedInSession)
      throw new UnsupportedFeatureError(
        'cannot save incrementally after Sanitize: an incremental update appends to '
        + 'the bytes this document was opened from, which still contain everything '
        + 'Sanitize removed. Save() without `incremental` writes a fresh file.');
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
    const font = new EmbeddedFont(parseSfnt(bytes, opts.faceIndex ?? 0, this.loadLimits));
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
   * Search `dir`, recursively, when RENDERING a font the document did not
   * embed.
   *
   * Opt-in, and that is the whole design: with no folder registered the
   * renderer uses only the bundled substitute faces and a page looks the same
   * on every machine, which is what keeps the render goldens meaningful. A
   * document that registers one renders a non-embedded CJK font in a real face
   * instead of placeholder boxes.
   *
   * A SEPARATE list from {@link RegisterFontFolder}, which goes on feeding
   * {@link LoadFontByName} alone — sharing them would change what an existing
   * caller's pages look like merely because they registered a folder for
   * authoring.
   *
   * The scanning rules are {@link RegisterFontFolder}'s exactly: no I/O here,
   * the folder is scanned on the first render that needs it; re-registering a
   * held path neither moves it nor grows the list; `sniff` is sticky-on and
   * upgrades a held path in place.
   *
   * Rendering only. Extraction, editing and PDF/A font embedding are unchanged,
   * and no substituted program is ever written into the document.
   */
  RegisterRenderFontFolder(dir: string, opts: { sniff?: boolean } = {}): void {
    const sniff = opts.sniff ?? false;
    const already = this.renderFontFolders.find((f) => f.dir === dir);
    if (already) { already.sniff ||= sniff; return; }
    this.renderFontFolders.push({ dir, sniff });
  }

  /**
   * Also search the platform's own font directories when rendering.
   *
   * Opt-in for {@link RegisterSystemFonts}'s reason, and one more: a render
   * that silently depends on what is installed makes the same code produce
   * different pixels on different machines.
   */
  RegisterRenderSystemFonts(): void {
    for (const dir of systemFontFolders()) this.RegisterRenderFontFolder(dir);
  }

  /**
   * Every face the registered render folders hold.
   *
   * @internal — `raster.ts` reaches this through the `Document` it is handed.
   * Empty with nothing registered, which is the line that makes opt-in
   * structural rather than tested for.
   */
  renderFontFaces(): FaceRecord[] {
    // Byte faces FIRST: a caller who handed the bytes over stated a preference
    // more specific than "search this folder", and ties in `resolveSubstitute`
    // fall to index order.
    const out: FaceRecord[] = [...this.renderByteFaces];
    for (const f of this.renderFontFolders) out.push(...indexFolder(f.dir, f.sniff));
    return out;
  }

  /**
   * Supply one font program as BYTES for use when RENDERING a font the document
   * did not embed — for a face that ships as a bundled asset, or comes out of an
   * archive, with no path to point {@link RegisterRenderFontFolder} at.
   *
   * WOFF, WOFF2, `.ttc`/`.otc`, `.dfont` and Type 1 are all accepted, since
   * `parseSfnt` already unwraps them; `faceIndex` picks a face of a collection.
   *
   * THROWS on bytes it cannot read, and the asymmetry with
   * {@link LoadFontByName} — which answers `undefined` — is deliberate: that one
   * is a SEARCH, where a machine lacking a face is an ordinary outcome, while a
   * caller handing explicit bytes named this font and wants to be told.
   *
   * Rendering only, exactly as {@link RegisterRenderFontFolder} is: this face is
   * never reachable from `LoadFontByName`, is never embedded in the document,
   * and changes nothing about extraction or editing.
   */
  AddRenderFont(bytes: Uint8Array, opts: { faceIndex?: number } = {}): void {
    const faceIndex = opts.faceIndex ?? 0;
    // Parsed HERE rather than on first use, which is what makes the throw
    // land at the call that supplied the bytes — and it populates the load
    // memo, so the face is parsed exactly once however often it is drawn.
    const sfnt = parseSfnt(bytes, faceIndex, this.loadLimits);
    // Names come off the EXTRACTED face (`sfnt.raw`), not the buffer handed
    // in: a collection's own bytes carry a `ttcf` header that states no names
    // at all, so reading them from the input would answer nothing for every
    // `.ttc`. Unlike `indexFolder`, a face stating no family is KEPT — the
    // caller supplied it deliberately, and it stays reachable by coverage even
    // when it can never be reached by name.
    const names = readFontNames(sfnt.raw) ?? {
      family: '', subfamily: 'Regular', bold: false, italic: false, weight: 400,
    };
    const record: FaceRecord = {
      // A cosmetic LABEL, never opened: nothing resolves a byte face through
      // the filesystem, which is why the maps below key on the record itself.
      path: `<bytes:${this.renderByteFaces.length}>`,
      faceIndex,
      names,
    };
    this.renderByteFaces.push(record);
    this.byteFaces.set(record, sfnt);
  }

  /**
   * One render substitute face, parsed and memoized.
   *
   * Keyed by path AND face index: the faces of a collection share one path, so
   * a path-only key hands back face 0's font for every face of the file and
   * every glyph is drawn from the wrong one, silently — the bug
   * {@link LoadFontByName}'s own key records.
   *
   * This is where the cost is: indexing is partial reads, but a chosen face is
   * read whole, and a CJK font runs to tens of megabytes. Two font dicts
   * resolving to one file share one parse. Never throws.
   *
   * @internal
   */
  loadRenderFace(face: FaceRecord): SfntFont | undefined {
    // A byte face is already parsed, and is keyed by the RECORD rather than by
    // its `path`, which is a label.
    const bytes = this.byteFaces.get(face);
    if (bytes) return bytes;

    const key = `${face.path}#${face.faceIndex}`;
    const hit = this.renderFaces.get(key);
    if (hit !== undefined) return hit ?? undefined;
    let font: SfntFont | null = null;
    try {
      font = parseSfnt(new Uint8Array(readFileSync(face.path)), face.faceIndex, this.loadLimits);
    } catch (caught) { rethrowLimit(caught);
      font = null;   // indexable, not parseable
    }
    this.renderFaces.set(key, font);
    return font ?? undefined;
  }

  /**
   * The code points one render face covers, for `fontsubst.ts`'s coverage rung.
   *
   * Three sources in cost order: a byte face's already-parsed `cmap`; a file
   * face this document has already loaded whole, whose `cmap` is then free; and
   * otherwise `peekCmap`'s second PARTIAL read, which is what keeps confirming
   * a candidate as cheap as indexing it was.
   *
   * A byte face must never reach `peekCmap` — its `path` names no file, so the
   * open fails, the face scores nothing and it is silently skipped.
   *
   * @internal
   */
  renderFaceCoverage(face: FaceRecord): ReadonlySet<number> | undefined {
    const known = this.byteFaces.get(face) ?? this.renderFaces.get(`${face.path}#${face.faceIndex}`);
    if (known) return new Set(known.cmap.keys());
    return peekCmap(face.path, face.faceIndex);
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
    return this.loadFaceFile(hit.path, hit.faceIndex, opts.shape);
  }

  /** @internal The registered face whose PostScript name (`name` ID 6) is
   *  EXACTLY `postScriptName`, through `LoadFontByName`'s memo, or `undefined`.
   *  `ReplaceText({ matchRegisteredFonts })` uses it to find the face a subset
   *  font was cut from (u3l5.2); a family match is a different face. */
  fontByPostScriptName(postScriptName: string): EmbeddedFont | undefined {
    for (const f of this.fontFolders) {
      for (const face of indexFolder(f.dir, f.sniff)) {
        if (face.names.postScriptName === postScriptName) return this.loadFaceFile(face.path, face.faceIndex, undefined);
      }
    }
    return undefined;
  }

  /** Load one face of a font file once per document. Keyed by path AND face:
   *  the faces of a collection share one path, so a path-only key hands back
   *  face 0's font for every face of the file and every glyph is then drawn
   *  from the wrong one, silently. */
  private loadFaceFile(path: string, faceIndex: number, shape: boolean | undefined): EmbeddedFont | undefined {
    const key = `${path}#${faceIndex}`;
    const already = this.fontsByPath.get(key);
    if (already) return already;
    let font: EmbeddedFont;
    try {
      font = this.AddFont(new Uint8Array(readFileSync(path)), { shape, faceIndex });
    } catch (caught) { rethrowLimit(caught);
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
      this.install(font.objNum, type0);
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
    await this.signCore(signer, opts, undefined);
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
    // The level is passed as STATED, not defaulted: a prepared field's seed
    // value may supply it, and only an unstated level can take one.
    await this.signCore(signer, opts, { permissions: opts.permissions });
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


  /** `certify` is undefined for an approval signature ({@link Sign}); for
   *  {@link Certify} it carries the DocMDP level the caller STATED, if any. */
  private async signCore(
    signer: Signer, stated: SignOptions, certify: { permissions?: DocMdpPermission } | undefined,
  ): Promise<void> {
    this.assertNotRecovered('sign');
    if (this.Pages.length === 0)
      throw new UnsupportedFeatureError('cannot sign a document with no pages');
    subFilterName(stated); // validate subfilter early

    // Resolve credentials up front so a bad key/passphrase fails before the
    // document object map is mutated below.
    const resolved = await resolveSigner(signer);

    // Validate any visible-appearance request before mutating the object map.
    if (stated.appearance) {
      const { page, rect } = stated.appearance;
      if (!Number.isInteger(page) || page < 0 || page >= this.Pages.length)
        throw new UnsupportedFeatureError(`signature appearance: page ${page} is out of range`);
      const w = Math.abs(rect[2] - rect[0]), h = Math.abs(rect[3] - rect[1]);
      if (!(w > 1e-3) || !(h > 1e-3))
        throw new TypeError('signature appearance: rect must have a positive area');
    }

    // A fieldName naming an existing, unsigned signature field is FILLED rather
    // than duplicated. Decided here, before anything is allocated, so each
    // refusal leaves the document byte-identical.
    const target = this.signTarget(stated);

    // A prepared field's seed value is honoured here — every refusal is a
    // SeedValueError thrown before anything is allocated. The plan supplies
    // only what the caller left open; `opts` is what signing actually uses.
    const plan = target?.seed === undefined ? {} : planSeedValue(target.seed, {
      certify: certify !== undefined,
      permissions: certify?.permissions,
      subFilter: stated.subFilter,
      digest: resolved.digestAlgorithm,
      reason: stated.reason,
      hasTimestamp: stated.timestamp !== undefined,
      lockPermissions: target.lock?.permissions,
    });
    const opts: SignOptions = {
      ...stated,
      ...(plan.subFilter !== undefined ? { subFilter: plan.subFilter } : {}),
      ...(plan.timestampUrl !== undefined ? { timestamp: httpTimestampProvider(plan.timestampUrl) } : {}),
    };
    // A field whose /Lock sets a level binds a certification to the STRICTER
    // of that level and its own (pyHanko: "choose the stricter option").
    const lockLevel = target?.lock?.permissions;
    const wanted = plan.permissions ?? certify?.permissions ?? 'no-changes';
    const docMdp = certify === undefined ? undefined
      : lockLevel !== undefined && lockLevelP(lockLevel) < lockLevelP(wanted) ? lockLevel : wanted;
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

    // Materialize any pending fonts before the byte image is frozen.
    this.finalizeEmbeddedFonts();

    const useIncremental = this.choosePath();
    const placeholderBytes = opts.placeholderBytes ?? DEFAULT_PLACEHOLDER_BYTES;
    const signingTime = opts.signingTime ?? new Date();

    // Build the signature object graph: value dict + invisible widget/field,
    // wired into the AcroForm and the first page's /Annots.
    const sigValueDict = buildSigValueDict(opts, signingTime);
    const sigRef = this.allocObject(sigValueDict);
    const touched = target
      ? this.fillSignatureField(target, sigRef, opts, resolved.certificate, signingTime)
      : this.installSignatureField(sigRef, opts, resolved.certificate, signingTime);

    // Certification: attach the DocMDP transform to the value dict and point the
    // catalog's /Perms /DocMDP at this signature (the catalog joins the delta).
    const references: PdfObject[] = [];
    if (docMdp) {
      references.push(buildDocMdpReference(docMdp));
      const catalog = this.catalog();
      catalog.set('Perms', new Map<string, PdfObject>([['DocMDP', sigRef]]));
      const catRef = this.trailer.get('Root');
      if (isRef(catRef)) touched.add(catRef.num);
    }
    // A prepared field's /Lock is carried INTO the signature as a FieldMDP
    // transform (puep.4): the signature is what the signer's digest covers, so
    // that is where the lock binds. /Data names the catalog, as pyHanko writes.
    // An APPROVAL signature locks the document through the field's /Lock /P
    // (puep.7). When a required /LockDocument asks for a level the field does
    // not set, it is written into the field now — onto its /Lock when it has
    // one, else a new one listing no fields, pyHanko's shape — so the level is
    // part of the revision this signature covers.
    let lock = target?.lock;
    if (target !== undefined && certify === undefined && plan.lockPermissions !== undefined) {
      const raw = target.field.get('Lock');
      const existing = this.resolve(raw ?? null);
      const p = lockLevelP(plan.lockPermissions);
      if (isDict(existing)) {
        existing.set('P', p);
        if (isRef(raw)) touched.add(raw.num);
        lock = { ...(lock ?? { action: 'include', fields: [] }), permissions: plan.lockPermissions };
      } else {
        lock = { action: 'include', fields: [], permissions: plan.lockPermissions };
        const lockRef = this.allocObject(encodeFieldLock(lock));
        target.field.set('Lock', lockRef);
        touched.add(lockRef.num);
      }
    }
    const root = this.trailer.get('Root');
    // A certification's FieldMDP carries its FINAL level, as pyHanko writes it.
    if (lock !== undefined && isRef(root))
      references.push(fieldMdpReference(docMdp !== undefined ? { ...lock, permissions: docMdp } : lock, root));
    if (references.length > 0) sigValueDict.set('Reference', references);

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
      digestAlgorithm: plan.digest ?? resolved.digestAlgorithm,
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

    // A fieldName naming a prepared, unsigned signature field is FILLED rather
    // than duplicated (puep.5) — the same lookup and refusals Sign applies,
    // decided before anything is allocated. A field prepared with a seed value
    // or a lock was prepared for a SIGNATURE: a document timestamp has no
    // signer, no /Reference and always the ETSI.RFC3161 subfilter, so it can
    // honour neither, and filling it anyway would ignore constraints the
    // document states.
    const target = this.signTarget({ fieldName: opts.fieldName });
    if (target !== undefined && (target.field.has('SV') || target.field.has('Lock')))
      throw new UnsupportedFeatureError(
        `signature field '${opts.fieldName}' is prepared for a signature with constraints `
        + '(/SV or /Lock); a document timestamp cannot honour them');

    // Build the /DocTimeStamp value dict, then fill the prepared field or wire
    // a new invisible widget into the AcroForm and the first page's /Annots.
    const dtsDict = buildDocTimeStampDict();
    const dtsRef = this.allocObject(dtsDict);
    let touched: Set<number>;
    if (target !== undefined) {
      touched = this.fillFieldValue(target, dtsRef);
    } else {
      touched = new Set<number>();
      const fieldName = opts.fieldName ?? `Timestamp${this.nextDocTimestampIndex()}`;
      const widget: PdfDict = new Map<string, PdfObject>([
        ['Type', name('Annot')],
        ['Subtype', name('Widget')],
        ['FT', name('Sig')],
        ['T', pdfString(fieldName)],
        ['Rect', [0, 0, 0, 0]],
        ['F', 132],
        ['V', dtsRef],
        ['P', ref(this.pageObjNums[0])],
      ]);
      this.attachSigWidget(widget, 0, touched);
    }

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
    // An APPROVAL signature whose lock sets a level (/Lock /P, PDF 2.0) is
    // judged against that level exactly as a certification is (puep.7).
    Document.applyApprovalLockLevel(src, bytes, signed, reports);
    // Field locks (puep.4): a signature carrying a FieldMDP transform freezes
    // the fields its lock names; report a later change to any of them.
    Document.applyFieldMdp(src, bytes, signed, reports);
    return reports;
  }

  /** Set the `docMDP` verdict of each APPROVAL signature whose lock sets a
   *  level (`/Lock /P`, `puep.7`), through the same classifier a certification
   *  uses. The level comes from what the SIGNER signed — the FieldMDP
   *  `/TransformParams /P` — else from the field's `/Lock /P` AS IT WAS in the
   *  signed revision, never the current field: a lock rewritten afterwards must
   *  not loosen anything, the rule `applyFieldMdp` already follows. pyHanko reads
   *  the current field here; this is the one place the two differ. */
  private static applyApprovalLockLevel(
    src: Document, bytes: Uint8Array, signed: SignatureField[], reports: SignatureReport[],
  ): void {
    for (let i = 0; i < signed.length; i++) {
      const sig = signed[i];
      const report = reports[i];
      if (report.docMDP !== 'n/a' || !sig.byteRange) continue;   // a certification: applyDocMdp's
      const signedEnd = sig.byteRange[2] + sig.byteRange[3];
      const prevDoc = signedEnd < bytes.length ? Document.Open(bytes.subarray(0, signedEnd)) : src;
      const carried = readFieldMdpLock(sig.valueDict, (o) => src.resolve(o ?? null))?.permissions;
      const fieldThen = prevDoc.Form.Get(sig.name);
      const level = carried
        ?? (fieldThen === undefined ? undefined
          : readLockLevel((o) => prevDoc.resolve(o ?? null), fieldThen.Dict.get('Lock')));
      if (level === undefined) continue;
      if (sig.coversWholeFile || signedEnd >= bytes.length) { report.docMDP = 'ok'; continue; }
      const view = (d: Document): DocMdpDoc => ({ getObject: (n) => d.getObject(n), resolve: (o) => d.resolve(o ?? null) });
      const rootRef = src.trailer.get('Root');
      const acroRef = src.catalog().get('AcroForm');
      const env: DocMdpEnv = {
        prev: view(prevDoc), cur: view(src),
        catalogNum: isRef(rootRef) ? rootRef.num : -1,
        acroFormNum: isRef(acroRef) ? acroRef.num : undefined,
      };
      report.docMDP = docMdpVerdict(lockLevelP(level), report.modifications, env);
    }
  }

  /** Set each FieldMDP-carrying signature's `fieldMDP` verdict. A locked field
   *  counts as changed when, after that signature's revision, its field dict or
   *  one of its widgets was modified, it was newly added, or it disappeared from
   *  the field tree. Filling an UNSIGNED signature field — or adding a new one —
   *  is exempt: a lock must not forbid the signatures that follow it.
   *
   *  Field identity comes from {@link Form}, the one owner of the tree walk; an
   *  identity map from dict to object number joins it to the change list. */
  private static applyFieldMdp(
    src: Document, bytes: Uint8Array, signed: SignatureField[], reports: SignatureReport[],
  ): void {
    let numOf: Map<PdfObject, number> | undefined;
    for (let i = 0; i < signed.length; i++) {
      const sig = signed[i];
      const lock = readFieldMdpLock(sig.valueDict, (o) => src.resolve(o ?? null));
      if (lock === undefined) continue;
      const report = reports[i];
      if (sig.coversWholeFile || !sig.byteRange) {
        report.fieldMDP = 'ok'; report.lockedFieldsChanged = []; continue;
      }
      const signedEnd = sig.byteRange[2] + sig.byteRange[3];
      if (signedEnd >= bytes.length) { report.fieldMDP = 'ok'; report.lockedFieldsChanged = []; continue; }

      numOf ??= new Map([...src.objects].map(([n, o]) => [o, n] as [PdfObject, number]));
      const prev = Document.Open(bytes.subarray(0, signedEnd)).Form;
      const touched = new Set(report.modifications.map((m) => m.object));
      const changed = new Set<string>();
      const curNames = new Set<string>();
      for (const f of src.Form.Fields) {
        curNames.add(f.FullName);
        const before = prev.Get(f.FullName);
        // Signing an unsigned (or brand-new) signature field is the next
        // signature, not an edit to a frozen one.
        if (f.Type === 'signature' && (before === undefined || !before.Dict.has('V'))) continue;
        const nums = [f.Dict, ...f.Widgets].map((d) => numOf!.get(d));
        if (before === undefined || nums.some((n) => n !== undefined && touched.has(n))) changed.add(f.FullName);
      }
      for (const f of prev.Fields) if (!curNames.has(f.FullName)) changed.add(f.FullName);
      const locked = [...changed].filter((n) => isLocked(lock, n)).sort();
      report.fieldMDP = locked.length > 0 ? 'violated' : 'ok';
      report.lockedFieldsChanged = locked;
    }
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

  /** The prepared signature field `opts.fieldName` names, when there is one.
   *
   *  Undefined means "create a new field" — no fieldName, or one no field in the
   *  document carries. A name that IS taken must be an unsigned signature field
   *  with exactly one widget on a page of this document; anything else throws,
   *  since creating a second field under a taken name is the defect this path
   *  exists to prevent. A visible appearance must sit where the prepared widget
   *  already is — moving it silently would redraw a box the preparer placed. */
  private signTarget(opts: SignOptions): SignTarget | undefined {
    if (opts.fieldName === undefined) return undefined;
    const field = this.Form.Get(opts.fieldName);
    if (field === undefined) return undefined;
    if (field.Type !== 'signature')
      throw new TypeError(`field '${opts.fieldName}' is not a signature field (it is ${field.Type})`);
    if (field.Dict.has('V'))
      throw new UnsupportedFeatureError(`signature field '${opts.fieldName}' is already signed`);
    const widgets = field.Widgets;
    if (widgets.length !== 1)
      throw new UnsupportedFeatureError(
        `signature field '${opts.fieldName}' has ${widgets.length} widgets; exactly one is supported`);
    const widget = widgets[0];
    const pageIndex = this.widgetPageIndex(widget);
    if (pageIndex === undefined)
      throw new UnsupportedFeatureError(`signature field '${opts.fieldName}' has no widget on any page`);
    const r = this.resolve(widget.get('Rect'));
    const rect = isArray(r) && r.length === 4 && r.every((x) => typeof x === 'number')
      ? r as number[] : undefined;
    if (opts.appearance) {
      const a = opts.appearance;
      // Compare normalized boxes: a /Rect may name its corners in either order.
      const norm = (q: readonly number[]) => [
        Math.min(q[0], q[2]), Math.min(q[1], q[3]), Math.max(q[0], q[2]), Math.max(q[1], q[3]),
      ];
      const want = rect && norm(rect), got = norm(a.rect);
      const same = want !== undefined && a.page === pageIndex
        && got.every((v, i) => Math.abs(v - want[i]) < 1e-3);
      if (!same)
        throw new RangeError(
          `signature appearance: field '${opts.fieldName}' is prepared at page ${pageIndex} `
          + `[${rect?.join(' ') ?? ''}]; the appearance must match it`);
    }
    const seed = field.Dict.has('SV')
      ? readSeedValue((o) => this.resolve(o), field.Dict.get('SV')!) : undefined;
    const lock = readFieldLock((o) => this.resolve(o ?? null), field.Dict.get('Lock'));
    return {
      field: field.Dict, widget, pageIndex,
      ...(seed === undefined ? {} : { seed }), ...(lock === undefined ? {} : { lock }),
    };
  }

  /** 0-based index of the page carrying `widget`: its /P when that names a
   *  page, else the page whose /Annots holds it. */
  private widgetPageIndex(widget: PdfDict): number | undefined {
    const p = widget.get('P');
    if (isRef(p)) {
      const i = this.pageObjNums.indexOf(p.num);
      if (i >= 0) return i;
    }
    for (let i = 0; i < this.Pages.length; i++) {
      const annots = this.resolve(this.Pages[i].Dict.get('Annots'));
      if (isArray(annots) && annots.some((a) => this.resolve(a) === widget)) return i;
    }
    return undefined;
  }

  /** The object number holding `dict` as a top-level object, by identity. */
  private objNumOf(dict: PdfDict): number | undefined {
    for (const [n, o] of this.objects) if (o === dict) return n;
    return undefined;
  }

  /** Fill a prepared signature field: point its /V at the value dict, draw a
   *  visible appearance into its widget when asked, and raise /SigFlags to
   *  SignaturesExist | AppendOnly. Records every changed object for the
   *  incremental delta — the field, its widget (when separate), /AcroForm and
   *  whatever the appearance allocated. */
  private fillSignatureField(
    target: SignTarget, sigRef: PdfRef, opts: SignOptions, certificate: Uint8Array, signingTime: Date,
  ): Set<number> {
    const touched = this.fillFieldValue(target, sigRef);
    const { widget } = target;
    if (opts.appearance) {
      const displayName = signerDisplayName(opts, certificate);
      const text = opts.appearance.text ?? defaultAppearanceText(opts, signingTime, displayName);
      const before = new Set(this.objects.keys());
      const stream = buildSignatureAppearance(this, opts.appearance, text);
      const apRef = this.allocObject(stream);
      widget.set('AP', new Map<string, PdfObject>([['N', apRef]]));
      for (const k of this.objects.keys()) if (!before.has(k)) touched.add(k);
    }
    return touched;
  }

  /** The half of filling a prepared field that a signature and a document
   *  timestamp share (`puep.5`): point `/V` at the value dict and raise
   *  `/SigFlags` to SignaturesExist | AppendOnly, recording the field, its
   *  widget (when separate) and `/AcroForm` for the incremental delta. One
   *  helper, so the two fill paths cannot come to disagree about either. */
  private fillFieldValue(target: SignTarget, valueRef: PdfRef): Set<number> {
    const touched = new Set<number>();
    target.field.set('V', valueRef);
    for (const d of [target.field, target.widget]) {
      const n = this.objNumOf(d);
      if (n !== undefined) touched.add(n);
    }
    const acro = ensureAcroForm(this, touched);
    const flags = acro.get('SigFlags');
    acro.set('SigFlags', (typeof flags === 'number' ? flags : 0) | 3);
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
    return this.signatureFields().filter((s) => !s.isDocTimeStamp);
  }

  /** Every document-timestamp field (`/DocTimeStamp`), read-side. */
  get DocumentTimestamps(): SignatureField[] {
    return this.signatureFields().filter((s) => s.isDocTimeStamp);
  }

  /** 1-based index for the next auto-named document-timestamp field. */
  private nextDocTimestampIndex(): number {
    return this.DocumentTimestamps.length + 1;
  }

  /** Every signature field in the /AcroForm tree, nested ones included, named
   *  by FULL name. Walks through {@link Form}, the one owner of the tree walk —
   *  a top-level-only loop here missed every field under a dotted name. */
  private signatureFields(): SignatureField[] {
    return this.Form.Fields
      .filter((f) => f.Type === 'signature')
      .map((f) => this.readSignatureField(f.Dict, f.FullName));
  }

  private readSignatureField(field: PdfDict, fieldName: string): SignatureField {
    const seedValue = field.has('SV') ? readSeedValue((o) => this.resolve(o), field.get('SV')!) : undefined;
    const lock = readFieldLock((o) => this.resolve(o ?? null), field.get('Lock'));
    const seed = { ...(seedValue === undefined ? {} : { seedValue }), ...(lock === undefined ? {} : { lock }) };
    const value = this.resolve(field.get('V'));
    if (!isDict(value)) {
      return { name: fieldName, subFilter: '', isSigned: false, valueDict: new Map(), coversWholeFile: false, isDocTimeStamp: false, ...seed };
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
      byteRange, contents, cmsLength, coversWholeFile, isDocTimeStamp, ...seed,
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
    const kids = this.pageObjNums.map((num) => {
      if (num === 0)
        throw new UnsupportedFeatureError('cannot modify pages: a page is not an indirect object');
      return ref(num);
    });
    this.flattenToRoot();
    return kids;
  }

  /** Before an edit re-lists this document's existing pages directly under the
   *  root, copy each page's inherited attributes from the intermediate nodes
   *  between it and the root onto its own dict, and point its `/Parent` at the
   *  root (`dmin.4`). Without it the pages kept `/Parent` naming an
   *  intermediate node that still listed them with its old `/Count` — a tree
   *  `Validate()` fails — and `Reorder`, which repoints `/Parent` itself, lost
   *  the intermediate node's `/MediaBox` outright. The ROOT's own values are
   *  not copied: the page still inherits them from the root. A value the page
   *  states itself is never overwritten. */
  private flattenToRoot(): void {
    const rootNum = this.requireIndirectPagesRoot();
    const root = this.objects.get(rootNum);
    for (const page of this.Pages) {
      const dict = page.Dict;
      let node = this.resolve(dict.get('Parent'));
      const seen = new Set<PdfDict>();
      while (isDict(node) && node !== root && !seen.has(node)) {
        seen.add(node);
        for (const key of INHERITABLE_PAGE_KEYS)
          if (!dict.has(key) && node.has(key)) dict.set(key, node.get(key)!);
        node = this.resolve(node.get('Parent'));
      }
      dict.set('Parent', ref(rootNum));
    }
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
    this.install(rootNum, pagesNode);
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
    this.install(num, page);
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
      this.install(num + offset, obj);
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
    checkOnSkipped(options);
    const flow = new Flow(this, options);
    // Placement-time reports (kk3q), collected and concatenated on the way out
    // as Document.AddHtml does — never appended to the array flow.AddMarkdown
    // handed back. A caller's own sink still fires.
    const late: string[] = [];
    const onSkipped = (s: string): void => { late.push(s); options.onSkipped?.(s); };
    const { skipped } = flow.AddMarkdown(src, { ...options, onSkipped });
    const pages = flow.Render();
    if (title !== undefined) {
      this.SetMetadata({ title });   // mirrors to XMP dc:title on its own
      this.DisplayDocTitle = true;
    }
    return { pages, skipped: [...skipped, ...late] };
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

  /** Render a whole Word document (.docx), appending freshly sized pages
   *  (`m2fp.5`). The one-call form of `NewFlow` + `AddDocx` + `Render`. Page size
   *  and margins come from the document's last section unless `options` states
   *  them; the document's own core-properties title becomes the PDF title unless
   *  an explicit `title` is given (`AddHtml`'s rule for `<title>`). */
  AddDocx(
    bytes: Uint8Array,
    options: DocxFlowOptions & FlowOptions & { title?: string } = {},
  ): { pages: Page[]; skipped: DocxSkipped[] } {
    const explicit = options.title;
    if (explicit !== undefined && (typeof explicit !== 'string' || explicit === ''))
      throw new TypeError('title must be a non-empty string');
    checkDocxOptions(options);
    const src = openDocxSource(this, bytes);
    const pg = src.opened.doc.page;
    // Placement-time reports: a LOCAL log merged on the way out, never an
    // append to the array flow.AddDocx handed back (AddHtml's rule).
    const late = new SkipLog();
    // The geometry is the FILE's, so it must never become a caller's TypeError.
    // Word writes w:pgMar top/bottom SIGNED (ST_SignedTwipsMeasure) and places
    // the text by the magnitude; margins that leave no column — on the
    // document's own page or on a format the caller stated — are dropped and
    // reported, falling back to the flow's defaults. Margins the CALLER states
    // are theirs to get wrong and still throw.
    const format = pg === undefined ? undefined : PageFormat.custom(pg.widthPt, pg.heightPt);
    const margins: FlowOptions = pg === undefined ? {} : {
      marginLeft: Math.abs(pg.margins.left), marginRight: Math.abs(pg.margins.right),
      marginTop: Math.abs(pg.margins.top), marginBottom: Math.abs(pg.margins.bottom),
    };
    let flowOptions: FlowOptions = { ...(format ? { format } : {}), ...margins, ...options, paragraphSpacing: 0 };
    if (pg !== undefined && !flowGeometryFits(flowOptions)) {
      flowOptions = { ...(format ? { format } : {}), ...options, paragraphSpacing: 0 };
      if (flowGeometryFits(flowOptions)) late.add('w:pgMar', 'degraded');
    }
    const flow = new Flow(this, flowOptions);
    const onSkipped = (s: DocxSkipped): void => { late.add(s.name, s.kind, s.count); options.onSkipped?.(s); };
    const { skipped } = flow.AddDocx(src, { ...options, onSkipped });
    const pages = flow.Render();
    const title = explicit ?? src.opened.title;
    if (title !== undefined) {
      this.SetMetadata({ title });
      this.DisplayDocTitle = true;
    }
    return { pages, skipped: mergeSkipped(skipped, late.list()) };
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
    const inheritable = INHERITABLE_PAGE_KEYS;
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
        this.install(nn, cloned);
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
      this.install(leafNum, leaf);
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
   *  `Page.ReplaceText`, whose options it takes. Every page is PLANNED before
   *  any is changed, so a refusal leaves the whole document untouched. Returns
   *  the total number of occurrences found. */
  ReplaceText(find: string | RegExp, replacement: string, options?: ReplaceTextOptions): number {
    const o = checkReplaceOptions(options);
    // A dry plan of every page refuses before anything changes. Each page is
    // then RE-planned just before it is applied: pages may reach one form
    // through a shared /Resources dict, and applying page 1 repoints that form
    // for page 2, so a plan made against the original would splice its stale
    // byte offsets into the edited copy (u3l5.2 review).
    this.Pages.forEach((p, i) => planReplace(this, p, i + 1, find, replacement, o));
    let total = 0;
    this.Pages.forEach((p, i) => {
      const plan = planReplace(this, p, i + 1, find, replacement, o);
      plan.apply();
      total += plan.count;
    });
    return total;
  }

  /** Restyle every match across all pages; see `Page.RestyleText`. Every page
   *  is PLANNED before any is changed, so a refusal leaves the whole document
   *  untouched. Returns the total number of matches. */
  RestyleText(find: string | RegExp, style: TextRestyle, options?: RestyleTextOptions): number {
    return restyleDocument(this, find, style, options);
  }

  /** Compare this document's text with `other`'s: what was deleted, what was
   *  inserted and what stayed, each placed on its pages the way `Search` places
   *  a match. See `CompareTextOptions` for page-by-page mode, character
   *  granularity, case, regions and exclusion areas. */
  CompareText(other: Document, options?: CompareTextOptions): TextComparison {
    return compareText(this, other, options);
  }

  /** Compare how this document and `other` RENDER, page by page: which
   *  pixels changed, where (in page space), and optionally a difference image.
   *  Sees what `CompareText` cannot — colour, images, lines — but not what
   *  changed. See `RenderingCompareOptions`. */
  CompareRendering(other: Document, options?: RenderingCompareOptions): RenderingComparison {
    return compareRendering(this, other, options);
  }

  /** Compare this document with `other` and set the two side by side in a
   *  **new** Document: one sheet per page pair, this document's page on the
   *  left and `other`'s on the right, deletions marked on the left and
   *  insertions on the right. Neither input is changed. See
   *  `SideBySideOptions` for the comparison options, the gap, colours, and
   *  annotation or drawn marks. */
  CompareSideBySide(other: Document, options: SideBySideOptions = {}): SideBySideResult {
    const plan = planSideBySide(this, other, options); // validates and compares; allocates nothing
    const out = Document.createEmptyDocument();
    const rootNum = out.requireIndirectPagesRoot();
    const nums = plan.sheets.map((s) => out.allocObject(new Map<string, PdfObject>([
      ['Type', name('Page')],
      ['Parent', ref(rootNum)],
      ['MediaBox', [0, 0, s.width, s.height]],
      ['Resources', new Map<string, PdfObject>()],
    ])).num);
    out.syncPages(nums.map((n) => ref(n)));
    renderSideBySide(out, plan);
    return { document: out, comparison: plan.comparison };
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
   *  Returns the number of widgets baked. `{ format: true }` bakes each
   *  field's `FormattedValue` where it has one. */
  FlattenForm(opts: FieldAppearanceOptions = {}): number {
    return flattenForm(this, opts);
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
