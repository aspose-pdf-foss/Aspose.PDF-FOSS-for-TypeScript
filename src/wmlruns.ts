/** WordprocessingML inline content to the flow engine's runs (`m2fp.5`): text
 *  runs, image atomics among them, and the report of what did not map. Pure:
 *  fonts and image bytes arrive through `WmlFlowEnv`.
 *
 *  **Invariant:** a run states its face, size and colour outright — Word has
 *  already resolved them (`readDocx`), so nothing here inherits from the block.
 *
 *  **Invariant:** only an EXTERNAL hyperlink links. An internal anchor has no
 *  destination until the document is placed, and a `/URI` to `#name` is a link
 *  that looks clickable and does nothing (`cssinline.ts`'s rule), so it is
 *  reported and its text kept. */
import type { WmlInline, WmlNoteRef, WmlText } from './wmlbody.js';
import type { FlowNote, FlowTextRun } from './flownotes.js';
import type { TextRun } from './textdecor.js';
import type { FlowAtomic } from './flow.js';
import type { AuthoringFont } from './stamp.js';
import type { ResolvedFamily } from './mdstyle.js';
import type { SkipLog, WmlFlowEnv } from './wmlflow.js';
import { imageSize } from './imageembed.js';

export interface RunCtx {
  env: WmlFlowEnv;
  log: SkipLog;
  /** How a note reference becomes a cited note (v9j3.3.2); an undefined result
   *  means `cite` reported why. ABSENT where a reference cannot be honoured —
   *  a note body (a table cell cites since v9j3.3.3) — and then `refusal`
   *  names the place in `skipped`. */
  cite?: (r: WmlNoteRef) => { kind: 'footnote' | 'endnote'; note: FlowNote } | undefined;
  refusal?: 'in a note';
  /** (v9j3.1) A table cell has no tab-stop path, so a tab there stays the
   *  space it always was, and is reported. */
  inCell?: boolean;
}

function face(f: ResolvedFamily, bold: boolean, italic: boolean): AuthoringFont {
  return bold && italic ? f.boldItalic : bold ? f.bold : italic ? f.italic : f.regular;
}

/** `readDocx` reports colour as 0..255 (`hexColor`); a `TextRun` wants 0..1. */
export const unitRgb = (c: readonly [number, number, number]): [number, number, number] => [c[0] / 255, c[1] / 255, c[2] / 255];

function textRun(t: WmlText, c: RunCtx): TextRun {
  const fam = c.env.family(t.props.font);
  if (t.props.font !== undefined && !fam.resolved) c.log.add(`font:${t.props.font}`, 'degraded');
  for (const u of t.unmodelled) c.log.add(u, 'degraded');
  const run: TextRun = { text: t.text, font: face(fam.family, t.props.bold, t.props.italic), fontSize: t.props.sizePt };
  if (t.props.color) run.color = unitRgb(t.props.color);
  if (t.props.underline) run.underline = true;
  if (t.props.strike) run.strikethrough = true;
  if (t.props.highlight) run.background = unitRgb(t.props.highlight);
  if (t.link) {
    if ('url' in t.link) run.link = t.link.url;
    else c.log.add('w:hyperlink (anchor)', 'degraded');
  }
  return run;
}

type WmlImage = Extract<WmlInline, { kind: 'image' }>;

/** An image's bytes, or undefined — reported — when it cannot be drawn. A
 *  drawing with no part was already recorded by readDocx, with its reason. */
export function imageData(i: WmlImage, c: RunCtx): Uint8Array | undefined {
  if (i.part === undefined) return undefined;
  const got = c.env.image(i.part);
  if (!got) { c.log.add('a:blip (unreadable image)', 'dropped'); return undefined; }
  if (imageSize(got.bytes) === undefined) { c.log.add(`image:${got.contentType ?? 'unknown'}`, 'dropped'); return undefined; }
  return got.bytes;
}

/** The 96-dpi convention `mdflow.ts` and `cssflow.ts` size an image by. */
const PT_PER_PIXEL = 0.75;

/** An image among words. With no usable `wp:extent` it draws at its intrinsic
 *  pixels, as the lone-image path already does — never silently not at all. */
function imageAtomic(i: WmlImage, beforeRun: number, c: RunCtx): FlowAtomic | undefined {
  const data = imageData(i, c);
  if (!data) return undefined;
  if (i.widthPt > 0 && i.heightPt > 0) return { beforeRun, data, width: i.widthPt, height: i.heightPt };
  const nat = imageSize(data);
  if (!nat || !(nat.width > 0) || !(nat.height > 0)) { c.log.add('image:no-extent', 'dropped'); return undefined; }
  return { beforeRun, data, width: nat.width * PT_PER_PIXEL, height: nat.height * PT_PER_PIXEL };
}

/** The face and size a break or a tab takes: the run's before it. */
const fontOf = (x?: TextRun): Pick<TextRun, 'font' | 'fontSize'> => (x ? { font: x.font, fontSize: x.fontSize } : {});

export function inlineContent(inlines: WmlInline[], c: RunCtx): { runs: FlowTextRun[]; atomics: FlowAtomic[]; maxSize: number } {
  const runs: FlowTextRun[] = [];
  const atomics: FlowAtomic[] = [];
  let maxSize = 0;
  for (const i of inlines) {
    if (i.kind === 'text') {
      runs.push(textRun(i, c));
      maxSize = Math.max(maxSize, i.props.sizePt);
    } else if (i.kind === 'break') {
      // page/column breaks were split out by the caller; only line breaks reach here.
      runs.push({ ...fontOf(runs[runs.length - 1]), text: '\n' });
    } else if (i.kind === 'tab') {
      // (v9j3.1) A real tab: the paragraph opts in with its stops.
      if (c.inCell) { runs.push({ ...fontOf(runs[runs.length - 1]), text: ' ' }); c.log.add('w:tab (in a table cell)'); }
      else runs.push({ ...fontOf(runs[runs.length - 1]), text: '\t' });
    } else if (i.kind === 'image') {
      const a = imageAtomic(i, runs.length, c);
      if (a) atomics.push(a);
    } else if (i.kind === 'note') {
      const tag = i.note === 'footnote' ? 'w:footnoteReference' : 'w:endnoteReference';
      if (c.cite === undefined) { c.log.add(`${tag} (${c.refusal ?? 'in a note'})`, 'dropped'); continue; }
      const got = c.cite(i);
      if (got === undefined) continue;
      // An EMPTY run carrying the note, in the reference run's own face and
      // size: the engine draws the mark after it (a mark in bold text is bold).
      // Its unmodelled names (the superscript) are not reported: the raised
      // mark is the engine's to draw.
      const fam = c.env.family(i.props.font);
      runs.push({ text: '', font: face(fam.family, i.props.bold, i.props.italic), fontSize: i.props.sizePt, [got.kind]: got.note });
    }
  }
  return { runs, atomics, maxSize };
}
