/** `doc.GenerateAltText` (`3ywf.4`): `/Alt` for every figure that lacks one.
 *
 *  Tagged: each `/Figure` with no `/Alt` and no `/ActualText` (the predicate
 *  PDF/UA's `IllustrationAlt` applies) is described from the images it draws —
 *  or, drawing none, from a render of the page cropped to its extent.
 *  Untagged: every picture `AutoTag` would consider is described, then
 *  `AutoTag` runs with those descriptions, so each becomes a `/Figure` + `/Alt`.
 *
 *  **Invariant:** identical pictures, by `imageKey` on the ENCODED bytes, cost
 *  one request — never keyed by stream identity, since one logo imported twice
 *  is two objects with the same bytes.
 *
 *  **Invariant:** the untagged path describes EXACTLY the images `AutoTag`
 *  asks about — top-level draws, `addr.path.length === 0` — so no request is
 *  spent on an image inside a Form XObject that AutoTag never tags.
 *
 *  **Invariant:** a decorative verdict changes nothing in a TAGGED document —
 *  turning a `/Figure` into an artifact is the author's structural decision —
 *  while in the untagged path it is what AutoTag does with an undescribed
 *  image anyway.
 *
 *  **Invariant:** a failed figure is recorded and the run continues; an abort
 *  stops it, keeping what was written. In the untagged path an abort means
 *  AutoTag does not run at all.
 *
 *  **Invariant (`u0ec`):** a FAILED description is not memoized, so the next
 *  figure showing the same picture asks again — a transient error costs the
 *  figure it struck, not every figure sharing its picture. A success and a
 *  decorative verdict are memoized for the run.
 *
 *  **Invariant (`u0ec`):** an untagged document with no picture AutoTag would
 *  ask about is left UNTAGGED. Tagging rewrites every page; a call asking for
 *  alt text has no business doing that when there is nothing to describe.
 *
 *  **Note, a decision rather than a gap:** a tagged `/Figure` judged
 *  decorative, or whose request failed, is asked about again on the NEXT run.
 *  Nothing is written for it — re-tagging as an artifact is the author's call,
 *  and an empty `/Alt` would claim a description that does not exist — so no
 *  state survives the run to say it was already asked. */
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { PdfStream } from './types.js';
import type { AiContentPart, AiModel, AiUsage } from './aimodel.js';
import type { StructElement, StructTreeRoot } from './struct.js';
import { AiServiceError, UnsupportedFeatureError, rethrowLimit } from './errors.js';
import type { Rect } from './text.js';
import { addUsage, checkModel, cutAt } from './aichunk.js';
import { parseJsonReply } from './aijson.js';
import { FigureContent, figurePage } from './figurecontent.js';
import { encodeImage, imageKey, type EncodedImage } from './imagehref.js';
import { pageRegionRenderer } from './raster.js';
import { hasSignatureField } from './signature.js';
import { resolvePages } from './pagerange.js';
import { visitContent } from './text.js';

export interface AltTextOptions {
  /** Pages to describe: `[1, 3]` or `"1-5,8"`. Default all. Tagged documents only. */
  pages?: number[] | string;
  /** Replace an existing `/Alt`. Default false. */
  overwrite?: boolean;
  /** Output language. Default the element's `/Lang`, else the document's. */
  language?: string;
  /** Untagged document: run `AutoTag` with the descriptions. Default true; false refuses. */
  autoTag?: boolean;
  signal?: AbortSignal;
  /** Called after each figure with its record. */
  onFigure?: (r: AltTextFigure) => void;
}
export interface AltTextFigure {
  /** 1-based. */
  page: number;
  status: 'described' | 'decorative' | 'skipped' | 'failed';
  alt?: string;
  reason?: string;
}
export interface AltTextReport { figures: AltTextFigure[]; requests: number; usage?: AiUsage }

const CONTEXT_CHARS = 2000;
const CROP_SCALE = 2;
const BLACK: [number, number, number] = [0, 0, 0];
const SYSTEM =
  'You write alternative text (PDF /Alt) for images in documents, for readers who cannot see them. ' +
  'Describe what the image conveys in one or two concise sentences; do not begin with "Image of" or "Picture of". ' +
  'If the image is purely decorative (a rule, a background, an ornament) and conveys nothing, set decorative to true ' +
  'and leave alt empty. Reply with JSON only.';
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['alt', 'decorative'],
  properties: { alt: { type: 'string' }, decorative: { type: 'boolean' } },
};

type Outcome = { kind: 'described'; alt: string } | { kind: 'decorative' } | { kind: 'failed'; reason: string };

/** One request per distinct (pictures, context language) — memoized, so a
 *  picture shown by several figures is described once. */
class Describer {
  requests = 0;
  usage: AiUsage | undefined;
  private readonly memo = new Map<string, Promise<Outcome>>();
  constructor(private readonly model: AiModel, private readonly signal: AbortSignal | undefined) {}

  describe(images: EncodedImage[], context: string, language: string | undefined): Promise<Outcome> {
    const key = `${images.map((i) => imageKey(i.bytes)).join(',')}\0${language ?? ''}`;
    let p = this.memo.get(key);
    if (!p) {
      p = this.ask(images, context, language).then((o) => {
        if (o.kind === 'failed') this.memo.delete(key);
        return o;
      });
      this.memo.set(key, p);
    }
    return p;
  }

  private async ask(images: EncodedImage[], context: string, language: string | undefined): Promise<Outcome> {
    if (this.signal?.aborted) throw this.signal.reason;
    const text = [
      context ? `Text on the same page, for context:\n${context}` : 'The page has no text.',
      language ? `Write the description in ${language}.` : '',
    ].filter(Boolean).join('\n\n');
    const content: AiContentPart[] = [
      { type: 'text', text },
      ...images.map((i): AiContentPart => ({ type: 'image', bytes: i.bytes, mediaType: i.mediaType as 'image/png' | 'image/jpeg' })),
    ];
    try {
      this.requests++;
      const r = await this.model.complete({
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }],
        schema: { name: 'alt_text', schema: SCHEMA },
        signal: this.signal,
      });
      this.usage = addUsage(this.usage, r.usage);
      return parseReply(r.text);
    } catch (caught) {
      rethrowLimit(caught);
      if (this.signal?.aborted) throw this.signal.reason;
      return { kind: 'failed', reason: caught instanceof Error ? caught.message : String(caught) };
    }
  }
}

function parseReply(text: string): Outcome {
  const bad = (): AiServiceError => new AiServiceError('alt-text reply is not the requested shape');
  const json = parseJsonReply(text, bad);
  if (json === null || typeof json !== 'object') throw bad();
  const { alt, decorative } = json as { alt?: unknown; decorative?: unknown };
  if (typeof alt !== 'string' || typeof decorative !== 'boolean') throw bad();
  if (decorative) return { kind: 'decorative' };
  if (!alt.trim()) throw new AiServiceError('alt-text reply is empty');
  return { kind: 'described', alt: alt.trim() };
}

const trimmed = (s: string): string => (s.length > CONTEXT_CHARS ? s.slice(0, cutAt(s, CONTEXT_CHARS)) : s).trim();
const hasText = (s: string | undefined): boolean => s !== undefined && s.trim() !== '';

export async function generateAltText(doc: Document, model: AiModel, opts: AltTextOptions = {}): Promise<AltTextReport> {
  checkModel(model);
  if (opts === null || typeof opts !== 'object') throw new TypeError('options must be an object');
  for (const k of ['overwrite', 'autoTag'] as const)
    if (opts[k] !== undefined && typeof opts[k] !== 'boolean') throw new TypeError(`${k} must be a boolean`);
  if (opts.language !== undefined && typeof opts.language !== 'string') throw new TypeError('language must be a string');
  if (opts.onFigure !== undefined && typeof opts.onFigure !== 'function') throw new TypeError('onFigure must be a function');
  if (hasSignatureField(doc))
    throw new UnsupportedFeatureError('GenerateAltText: the document has signature fields; writing /Alt would invalidate them');

  const tree = doc.GetStructTree();
  if (tree) return tagged(doc, tree, model, opts);
  if (opts.autoTag === false)
    throw new UnsupportedFeatureError('GenerateAltText: the document is untagged; tag it first, or leave autoTag on');
  if (opts.pages !== undefined)
    throw new RangeError('GenerateAltText: pages cannot narrow an untagged run, because AutoTag tags every page');
  if (doc.IsTagged)
    throw new UnsupportedFeatureError('GenerateAltText: the document is marked tagged but has no structure tree');
  return untagged(doc, model, opts);
}

async function tagged(doc: Document, tree: StructTreeRoot, model: AiModel, opts: AltTextOptions): Promise<AltTextReport> {
  const selected = new Set(resolvePages(opts.pages, doc.Pages.length));
  const content = new FigureContent(doc);
  const describer = new Describer(model, opts.signal);
  const figures: AltTextFigure[] = [];
  const record = (r: AltTextFigure): void => { figures.push(r); opts.onFigure?.(r); };
  const pageText = new Map<Page, string>();
  const crops = new Map<Page, (region: Rect) => Uint8Array | undefined>();
  const cropOf = (page: Page, box: Rect): Uint8Array | undefined => {
    let r = crops.get(page);
    if (!r) { r = pageRegionRenderer(doc, page, CROP_SCALE); crops.set(page, r); }
    return r(box);
  };
  const contextOf = (page: Page): string => {
    let t = pageText.get(page);
    if (t === undefined) { t = trimmed(page.GetText()); pageText.set(page, t); }
    return t;
  };

  const els: StructElement[] = [];
  const walk = (list: StructElement[]): void => {
    for (const e of list) { if (e.StandardType === 'Figure') els.push(e); else walk(e.Children); }
  };
  walk(tree.Children);

  for (const el of els) {
    const page = figurePage(el);
    if (!page) continue;
    const n = doc.Pages.indexOf(page) + 1;
    if (!selected.has(n)) continue;
    if (!opts.overwrite && (hasText(el.Alt) || hasText(el.ActualText))) continue;

    let images = content.imagesOf(el)
      .map((p) => encodeImage(doc, p.stream, BLACK))
      .filter((e): e is EncodedImage => e !== undefined);
    if (images.length === 0) {
      const box = content.bboxOf(el, page);
      const png = box ? cropOf(page, box) : undefined;
      if (png) images = [{ bytes: png, mediaType: 'image/png' }];
    }
    if (images.length === 0) { record({ page: n, status: 'skipped', reason: 'no image and no bounding box' }); continue; }

    const out = await describer.describe(images, contextOf(page), opts.language ?? el.EffectiveLang ?? doc.Lang);
    if (out.kind === 'described') { el.Alt = out.alt; record({ page: n, status: 'described', alt: out.alt }); }
    else if (out.kind === 'decorative') record({ page: n, status: 'decorative' });
    else record({ page: n, status: 'failed', reason: out.reason });
  }
  return { figures, requests: describer.requests, usage: describer.usage };
}

async function untagged(doc: Document, model: AiModel, opts: AltTextOptions): Promise<AltTextReport> {
  const describer = new Describer(model, opts.signal);
  const figures: AltTextFigure[] = [];
  const record = (r: AltTextFigure): void => { figures.push(r); opts.onFigure?.(r); };
  const altOf = new Map<PdfStream, string | undefined>();
  let pictures = 0;

  for (let n = 1; n <= doc.Pages.length; n++) {
    const page = doc.Pages[n - 1]!;
    const streams: PdfStream[] = [];
    visitContent(doc, page, {
      image: (e) => { if (e.addr.path.length === 0 && e.stream && !streams.includes(e.stream)) streams.push(e.stream); },
    });
    if (streams.length === 0) continue;
    pictures += streams.length;
    const context = trimmed(page.GetText());
    for (const stream of streams) {
      if (altOf.has(stream)) continue;
      const enc = encodeImage(doc, stream, BLACK);
      if (!enc) {
        altOf.set(stream, undefined);
        record({ page: n, status: 'failed', reason: 'the image could not be decoded; marked as an artifact' });
        continue;
      }
      const out = await describer.describe([enc], context, opts.language ?? doc.Lang);
      if (out.kind === 'described') { altOf.set(stream, out.alt); record({ page: n, status: 'described', alt: out.alt }); }
      else if (out.kind === 'decorative') { altOf.set(stream, undefined); record({ page: n, status: 'decorative' }); }
      else { altOf.set(stream, undefined); record({ page: n, status: 'failed', reason: `${out.reason}; marked as an artifact` }); }
    }
  }
  // An abort can land after the last request resolved; AutoTag rewrites every
  // page, so it must not start once the caller has asked to stop.
  if (opts.signal?.aborted) throw opts.signal.reason;
  if (pictures === 0) return { figures, requests: describer.requests, usage: describer.usage };
  doc.AutoTag({ alt: (img) => (img.stream ? altOf.get(img.stream) : undefined) });
  return { figures, requests: describer.requests, usage: describer.usage };
}
