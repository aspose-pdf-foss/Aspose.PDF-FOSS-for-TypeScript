import type { Document } from './document.js';
import type { Page } from './page.js';
import type { OperationControlOptions } from './checkpoint.js';
import { runOperation, runOperationAsync, type OperationContext, type OperationSteps } from './operation.js';
import { Flow, normalizeFlowOptions, type FlowOptions } from './flow.js';
import { codeBlock } from './flowblock.js';
import { preformat } from './preformat.js';
import { coverageOf } from './textcoverage.js';
import { measureTextBlock, type AuthoringFont } from './stamp.js';
import { PdfParseError, UnsupportedFeatureError, rethrowLimit } from './errors.js';

/** Plain-text layout. Lengths are points; text is literal, never markup. */
export interface PlainTextOptions extends Pick<FlowOptions,
  'format' | 'marginLeft' | 'marginRight' | 'marginTop' | 'marginBottom'>, OperationControlOptions {
  /** Default Courier. Use a document-owned embedded font for Unicode. */
  font?: AuthoringFont;
  /** Positive font size. Default 10. */
  fontSize?: number;
  /** Positive line advance. Default 1.2 times fontSize. */
  leading?: number;
  /** RGB components in 0..1. Default black. */
  color?: [number, number, number];
  /** Positive integer tab stop interval, in characters. Default 4. */
  tabWidth?: number;
  /** Non-empty document title, mirrored to Info, XMP and DisplayDocTitle. */
  title?: string;
}

export function addPlainText(doc: Document, text: string, options: PlainTextOptions): Page[] {
  return runOperation('AddPlainText', options, (context) => addPlainTextSteps(doc, text, options, context));
}

export function addPlainTextAsync(doc: Document, text: string, options: PlainTextOptions): Promise<Page[]> {
  return runOperationAsync('AddPlainText', options, (context) => addPlainTextSteps(doc, text, options, context));
}

/** Prepare ALL sections before allocating pages. A separate Flow per form-feed
 *  segment preserves empty leading, trailing and repeated page breaks. */
function* addPlainTextSteps(doc: Document, text: string, options: PlainTextOptions,
  context: OperationContext): OperationSteps<Page[]> {
  if (typeof text !== 'string') throw new TypeError('plain text must be a string');
  const { title, format, marginLeft, marginRight, marginTop, marginBottom, tabWidth = 4 } = options;
  if (title !== undefined && (typeof title !== 'string' || title === ''))
    throw new TypeError('title must be a non-empty string');
  const geometry = { format, marginLeft, marginRight, marginTop, marginBottom };
  const g = normalizeFlowOptions(geometry);
  const font = options.font ?? 'Courier', fontSize = options.fontSize ?? 10;
  const style = { font, fontSize, leading: options.leading ?? fontSize * 1.2, color: options.color };
  // Validate the same font and style the painter uses, even for an empty input.
  // Refuse a page too short for a line rather than let Flow overflow its body.
  measureTextBlock('', g.columnWidth, g.columnHeight, style);
  if (style.leading > g.columnHeight)
    throw new TypeError('plain-text page body must fit at least one line');
  if (!Number.isInteger(tabWidth) || tabWidth <= 0)
    throw new TypeError('tabWidth must be an integer > 0');
  const sections = text.replace(/\r\n?/g, '\n').split('\f');
  const flows: Flow[] = [];
  for (const section of sections) {
    // Strict import must detect partial loss even when shaping is enabled.
    // The ordinary code-block diagnostic suppresses such reports for shaped
    // text, where a joiner may legitimately be consumed; import is stricter.
    const missing = coverageOf(preformat(section, tabWidth), font, false);
    if (missing !== undefined)
      throw new UnsupportedFeatureError(`Plain-text font cannot draw ${JSON.stringify(missing.lost)}; supply an embedded font covering the input`);
    const elements = codeBlock(section, {
      ...style, tabWidth, padding: 0, background: false, breakAnywhere: true,
    });
    flows.push(new Flow(doc, geometry).AddElements(elements));
    yield context.progress('prepare', flows.length, sections.length);
  }
  const pages: Page[] = [];
  for (let i = 0; i < flows.length; i++) {
    const rendered = yield* flows[i].renderSteps(context.scope(`section${i + 1}`));
    for (const page of rendered) pages.push(page);
    yield context.progress('sections', i + 1, flows.length);
  }
  if (title !== undefined) {
    doc.SetMetadata({ title });
    doc.DisplayDocTitle = true;
  }
  yield context.progress('metadata', 1, 1);
  return pages;
}

/** Strict decoding, with a Unicode BOM taking precedence over a caller label. */
export function decodePlainText(bytes: Uint8Array, encoding?: string): string {
  let label = encoding ?? 'utf-8';
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = 'utf-8';
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(label, { fatal: true }); }
  catch (e) { rethrowLimit(e);
    throw new TypeError(`Unsupported plain-text encoding: ${String(label)}`);
  }
  try { return decoder.decode(bytes); }
  catch (e) { rethrowLimit(e);
    throw new PdfParseError(`Malformed plain-text input for encoding ${decoder.encoding}`);
  }
}
