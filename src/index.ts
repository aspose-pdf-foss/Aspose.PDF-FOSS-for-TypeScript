export { defaultPrunePolicy } from './extractor.js';
export type { PrunePolicy } from './extractor.js';
export { PdfParseError, UnsupportedFeatureError, InvalidPasswordError } from './errors.js';
export {
  splitPdfFile, readMetadataFile, updateMetadataFile, clearMetadataFile, savePageImageFile,
  exportFdfFile, exportXfdfFile, importFdfFile, importXfdfFile,
} from './node.js';
export { Document } from './document.js';
export type {
  SplitOptions, ExtractPagesOptions, InsertPagesOptions, OpenOptions, SaveOptions,
  PubSecRecipient, RecoveryReport, TrailerChoice,
} from './document.js';
export type { LoadFontOptions, FontMatch, FontFamily } from './fontmatch.js';
export type { ObjStmDamage } from './objstm.js';
export type { PdfRevision } from './xref.js';
export { Page } from './page.js';
export { ImageInfo } from './image.js';
export { InlineImageInfo } from './inlineimage.js';
export { tiffPageCount } from './tiff.js';
export { Form } from './form.js';
export {
  Field, TextField, CheckboxField, RadioField, ChoiceField, ButtonField,
} from './formfield.js';
export type { FieldType } from './formfield.js';
export type {
  FieldInit, TextFieldInit, CheckboxInit, RadioOption, RadioGroupInit,
  ChoiceOption, ChoiceInit, ComboBoxInit, ListBoxInit, PushButtonInit,
} from './formcreate.js';
export type { FieldStyle, WidgetStyle, FieldBorderStyle } from './fieldstyle.js';
export type { ButtonIconPosition } from './buttonap.js';
export type {
  FormData, FormDataField, ExportFormDataOptions, ImportOptions, ImportReport,
  ImportedAnnot, SkippedAnnot,
} from './formdata.js';
export type {
  PdfAction, GoToAction, UriAction, SubmitAction, ResetAction, JavaScriptAction,
  FieldActions, FieldActionsUpdate,
} from './actions.js';
export type { AnnotData } from './annotdata.js';
export { OptionalContent, Layer, LayerConfig } from './ocg.js';
export type { AddLayerOptions } from './ocg.js';
export { Annotation, TextAnnotation, StampAnnotation, MarkupAnnotation, LinkAnnotation, FileAttachmentAnnotation, RedactAnnotation, CaretAnnotation } from './annotation.js';
export type {
  TextNoteOptions, StampAnnotationOptions, MarkupOptions, MarkupType,
  LinkOptions, LinkAction, FileAttachmentOptions, RedactAnnotationOptions, CaretOptions,
} from './annotation.js';
export { Attachment } from './embeddedfile.js';
export type { AttachmentOptions } from './embeddedfile.js';
export type { CollectionSettings, CollectionFieldDef, CollectionFieldType, CollectionView } from './collection.js';
export type {
  OutlineItem, OutlineDest, PageDest, NamedDest, OutlineView, NamedDestination,
} from './outline.js';
export type { PageLabel } from './pagelabels.js';
export { parseContentStream, serializeContentStream } from './content.js';
export type { ContentOp } from './content.js';
export { EditableContent } from './editcontent.js';
export type { ContentAddr } from './editcontent.js';
export { visitContent, mapRegions } from './text.js';
export type { GlyphEvent, ImageEvent, PathEvent, ContentVisitor, Rect, RegionHits, TextFragment, TextLine, TextBlock } from './text.js';
export { extractTables, Table } from './table.js';
export { extractTaggedTables } from './tablestruct.js';
export { stitchTables } from './tablestitch.js';
export type { TableCell, TableRow, TableExtractOptions } from './table.js';
export { extractPaths } from './paths.js';
export type { PagePath, PathSubpath, PathSegment, PathPaint } from './paths.js';
export type { TableStitchOptions } from './tablestitch.js';
export { StructTreeRoot, StructElement, STANDARD_STRUCTURE_TYPES } from './struct.js';
export type { ContentItem } from './struct.js';
export type { AutoTagOptions, AutoTagReport } from './autotag.js';
export { ValidationReport } from './structvalidate.js';
export type { ValidationIssue, Severity } from './structvalidate.js';
export type { PdfALevel } from './pdfavalidate.js';
export type { PdfXLevel } from './pdfxvalidate.js';
export type { PdfXConvertOptions } from './pdfxconvert.js';
export type { ConvertOptions, ConvertCategory } from './pdfaconvert.js';
export type { ConvertAction, ConversionReport } from './conversion.js';
export type { PdfUaConvertOptions } from './pdfuaconvert.js';
export type { ElemOpts } from './structwrite.js';
export type {
  RGB, Edged, TableAttributes, ListAttributes, LayoutAttributes, BorderStyle,
} from './structattr.js';
export { redactText } from './redact.js';
export type { RedactOptions } from './redact.js';
export type { ApplyRedactionsOptions, MarkRedactTextOptions } from './redactapply.js';
export { searchText, replaceText } from './textedit.js';
export type { TextMatch, SearchOptions } from './textedit.js';
export { searchAnnotations, searchAnnotationText } from './annotsearch.js';
export type { AnnotationMatch, AnnotationTextMatch, AnnotationTextKey } from './annotsearch.js';
export { richTextToPlain } from './richtext.js';
export type { TextFont } from './font.js';
export type { StampOptions, TextBlockOptions, AuthoringFont } from './stamp.js';
export type { TextRun } from './textdecor.js';
export type {
  Decoration, DecorationStyle, Background, BackgroundStyle, DecorationOptions,
} from './textdecor.js';
export { createTable, TableBuilder, RowBuilder, CellBuilder } from './tableauthor.js';
export type {
  TableDefaults, CellTextOptions, TableMetrics, ColumnWidth, CellOptions, RowOptions,
  CellHeader, BorderInfo, BorderSides, BorderEdges, Padding, ResolvedPadding,
} from './tableauthor.js';
export type { AddTableOptions, AddTableResult } from './tablerender.js';
export type { TOCEntry, TOCOptions } from './toc.js';
export type { AddTOCResult } from './tocrender.js';
export { PageFormat } from './pageformat.js';
export { Flow, paragraph, heading, list, image } from './flow.js';
export type {
  FlowOptions, FlowParagraphOptions, FlowHeadingOptions, FlowListOptions, FlowImageOptions,
  FlowListItem, FlowListNode, FlowElement, FlowClear, PlaceContext, PlaceResult,
} from './flow.js';

// --- Flow block vocabulary (gl6o.3.2) ---
export { rule, codeBlock, quote } from './flowblock.js';
export type {
  FlowRuleOptions, FlowCodeOptions, FlowQuoteOptions, FlowQuoteBar,
} from './flowblock.js';
export { placeElements } from './flowplace.js';
export type { PlaceElementsOptions, PlaceElementsResult } from './flowplace.js';

// --- Markdown tables and links (gl6o.3.3) ---
export { table } from './flowtable.js';
export type { FlowTableOptions } from './flowtable.js';

// --- Markdown rendering (gl6o.3.2) ---
export { markdownElements } from './mdflow.js';
export type {
  MarkdownFlowOptions, MarkdownElements, MarkdownResult, AddMarkdownResult,
} from './mdflow.js';
// --- HTML rendering (zch2.5) ---
export { htmlElements } from './htmlflow.js';
export type {
  HtmlFlowOptions, HtmlFlowResult, HtmlElements, AddHtmlResult,
} from './htmlflow.js';
// The unrenderable-construct report (zch2.7). `describe` is renamed on
// export because the bare name collides with vitest's and with any caller's
// own; describeNotRendered says what it describes.
export { describe as describeNotRendered, CONSTRUCTS } from './htmlreport.js';
export type { NotRendered, Construct, ElementPolicy } from './htmlreport.js';

export { resolveMarkdownStyle, resolveFamily, faceFor } from './mdstyle.js';
export type {
  MarkdownStyle, MarkdownFontFamily, MarkdownFontSpec, ResolvedFamily,
} from './mdstyle.js';
export { FloatingBox } from './floatbox.js';
export type { FloatBoxOptions, FloatBoxImageOptions } from './floatbox.js';
export { EmbeddedFont } from './embeddedfont.js';
export type { StdFont } from './metrics.js';
export { PageGraphics, VectorGraphics } from './graphics.js';
export { Template } from './template.js';
export type { PlaceOptions } from './template.js';
export type { OpenAction, DocumentJavaScript } from './docaction.js';
export type { GradientStop, LinearGradient, RadialGradient, Gradient } from './gradient.js';
export type {
  TilingPattern, ColoredTilingPattern, UncoloredTilingPattern, TilingPatternOptions,
} from './tiling.js';
export type { SvgOptions } from './svgrender.js';
export type { HtmlOptions } from './html.js';
export type { DocxOptions } from './docxexport.js';
export type { EpubOptions } from './epubexport.js';
export type { ImageOptions, ImageFormat } from './raster.js';
export type { TiffFrame, TiffEncodeOptions } from './tiffencode.js';
export { encodeTiff } from './tiffencode.js';
export { encodeG4 } from './ccittencode.js';
export type { G4EncodeOptions } from './ccittencode.js';
export type { TiffExportOptions } from './raster.js';
export { encodeBmp } from './bmpencode.js';
export { encodeGif } from './gifencode.js';
export { quantize } from './quantize.js';
export type { AddImagePagesOptions, AddImagePagesResult, SkippedFrame } from './imagepages.js';
export type { Quantized } from './quantize.js';
export { IMAGE_FORMATS } from './raster.js';
export type { AddImageOptions } from './imageembed.js';
export type { ReplaceImageOptions, RemoveImageOptions } from './imageedit.js';
export { makeCode128, makeEan13, makeUpcA, makeEan8, makeQr } from './barcode.js';
export type { LinearBarcode, MatrixBarcode, BarcodeModel } from './barcode.js';
export type { QrEcc, QrOptions } from './qr.js';
export type { BarcodeSpec, AddBarcodeOptions } from './barcodeplace.js';
export type { StampWithOptions, OverlayOptions, NUpOptions, ResizeOptions } from './compose.js';
export type { BookletOptions } from './booklet.js';
export type { AddSVGOptions, AddSVGResult } from './svgembed.js';
export type {
  StampPosition, WatermarkOptions, HeaderFooterOptions, HeaderFooterBand, BatesOptions,
} from './decorate.js';
export type { EncryptOptions, Permissions, PubSecEncryptOptions, PubSecRecipientCert } from './encrypt.js';
export { verifyLinearization } from './linearize.js';
export type { LinearizationCheck } from './linearize.js';
export type { Metadata, MetadataUpdate } from './metadata.js';
export type { XmpMetadata, XmpUpdate } from './xmp.js';
export type {
  SignOptions, SignatureAppearance, SignatureField, CertifyOptions, DocMdpPermission,
  DocumentTimestampOptions,
  CadesAttributes, CommitmentType, SignerLocation,
} from './signature.js';
export type { Signer, PemSigner, Pkcs12Signer, ExternalSigner, SignerOptions } from './signer.js';
export type { SigAlg, SignatureScheme, DigestAlgorithm } from './sigalg.js';
export type {
  SignatureReport, CertInfo, Change, VerifyOptions, RevocationFetcher,
  DocumentTimestampReport,
} from './sigverify.js';
export {
  parseOcspResponse, ocspStatus, verifyOcspSignature,
  parseCrl, crlStatus, verifyCrlSignature, checkRevocation, findIssuer,
} from './revocation.js';
export type {
  RevocationStatus, RevocationResult, RevocationMaterial,
  OcspResponse, OcspSingleResponse, Crl, CrlEntry,
} from './revocation.js';
export { vriKey, readDssMaterial, readDssCerts } from './dss.js';
export type { ValidationDataOptions, DssEntry } from './dss.js';
export { verifyCertChain } from './chain.js';
export type { ChainOptions, ChainResult } from './chain.js';
export {
  buildTimeStampRequest, buildTimeStampToken, extractTimeStampToken,
  parseTimeStampRequest, parseTstInfo, verifyTimestampToken,
} from './rfc3161.js';
export type {
  TimestampProvider, TimestampInfo, TstInfo, TimeStampRequestInfo,
  TimeStampRequestOptions, TimeStampTokenOptions,
} from './rfc3161.js';
export { encodeFilter, encodeStream } from './filters.js';
export type { StreamFilterName } from './streamfilter.js';
export type {
  OptimizeOptions, OptimizeReport, FontOptimization, SkippedFont,
  OptimizeImageOptions, ImageOptimization, SkippedImage, DrPruneResult,
} from './optimize.js';
export type {
  GrayscaleOptions, GrayscaleReport, GrayImageResult, GraySkipped,
} from './grayconvert.js';
export { ascii85Encode, asciiHexEncode, runLengthEncode } from './ascii.js';
export { lzwEncode } from './lzw.js';

// --- Markdown (CommonMark 0.31.2, optionally GFM) ---
export { parseMarkdown } from './markdown.js';
export type { MarkdownOptions } from './markdown.js';
export type { MarkdownExportOptions, MarkdownAsset, MarkdownExportResult } from './mdexport.js';
// The OOXML package vocabulary, but NOT writeZip/buildOoxmlPackage/writeDocx:
// the package writers stay internal now that `Document.ToDocx` is the way in,
// and an exported function is a promise we would have to keep.
export type { ZipEntry } from './zip.js';
export type { OoxmlPart, OoxmlRelationship } from './ooxml.js';
export type { DocxExtras } from './docxpackage.js';
export { filterDisallowedHtml } from './mdgfm.js';
export { isMdBlock, isMdInline, isMdContainer } from './mdast.js';
export type {
  MdNode, MdBlock, MdInline,
  MdDocument, MdBlockQuote, MdList, MdItem, MdParagraph, MdHeading,
  MdThematicBreak, MdCodeBlock, MdHtmlBlock,
  MdText, MdSoftBreak, MdHardBreak, MdEmph, MdStrong, MdCode, MdLink, MdImage, MdHtmlInline,
  MdAlign, MdTable, MdTableRow, MdTableCell, MdStrikethrough,
} from './mdast.js';

// ---- HTML parsing (zch2.1) ------------------------------------------------
//
// parseHtml alone. parseHtmlFragment is implemented and fully tested but not
// exported: nothing in this epic can call it, since zch2.5's entry points take
// a PDF target rather than an HTML element and so have no context to pass.
// The mutation helpers stay internal too — a caller reading a parse result
// does not need them, and exporting them would commit this library to a
// DOM-editing API before anyone has asked for one.
// zch2.8 adds parseHtmlBytes as a SIBLING rather than widening parseHtml's
// signature: parseHtml is what the 8,862 vendored cases anchor and it keeps
// taking a string. The sniffing helpers in htmlencoding.ts stay internal —
// they are how the entry point works, not a vocabulary a caller needs.
export { parseHtml, parseHtmlBytes } from './htmltree.js';
export type { ParseHtmlBytesOptions } from './htmltree.js';
export type {
  HtmlNode, HtmlDocument, HtmlElement, HtmlFragment,
  HtmlText, HtmlComment, HtmlProcessingInstruction, HtmlDoctype, HtmlNamespace,
} from './htmldom.js';
