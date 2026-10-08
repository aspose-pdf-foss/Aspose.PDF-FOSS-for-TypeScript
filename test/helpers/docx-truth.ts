/** m2fp.4's ground truth: the schema the two reader scripts write
 *  (scripts/docx-truth-word.ps1, scripts/docx-truth-lo.py), and the projection
 *  of readDocx's model into the same schema, so all three compare by JSON path.
 *
 *  styleName is recorded and never compared: Word's localized UI names a style
 *  `Заголовок 1`, LibreOffice `Heading 1`, readDocx `heading 1`. */
import { readFileSync } from 'node:fs';
import type { WmlDocument } from '../../src/wmlread.js';
import type { WmlBlock, WmlCell, WmlInline, WmlLink, WmlParagraph } from '../../src/wmlbody.js';
import { formatMark } from '../../src/flownotes.js';
import { noteFormat, sectionNotes } from '../../src/wmlflow.js';

export interface Segment { text: string; bold: boolean; italic: boolean; sizePt: number; font: string }
/** A paragraph's tab stop as a reader resolves it (v9j3.1): `pos` in points
 *  from the margin, rounded to a twip, so Word's points and LibreOffice's
 *  1/100 mm compare exactly. */
export interface TruthTab { pos: number; align: string; leader: string }
export interface TruthParagraph {
  text: string; styleName: string; heading: number | null; listLabel: string | null; inTable: boolean; segments: Segment[];
  tabs: TruthTab[];
}
export type TruthLink = { text: string; url: string } | { text: string; anchor: string };
export const COUNT_KEYS = ['headers', 'footers', 'footnotes', 'endnotes', 'textBoxes', 'fields', 'comments', 'revisions'] as const;
export type TruthCounts = Record<(typeof COUNT_KEYS)[number], number>;
/** The names readDocx (and so AddDocx's `skipped`) reports each counted construct
 *  under. One owner: the reader's corpus test and the renderer's both read it. */
export const SKIP_MAP: Record<keyof TruthCounts, string[]> = {
  headers: ['w:headerReference'], footers: ['w:footerReference'],
  footnotes: ['w:footnoteReference'], endnotes: ['w:endnoteReference'],
  textBoxes: ['w:txbxContent', 'w:pict'], fields: ['w:fldChar', 'w:fldSimple'],
  comments: ['w:commentReference'], revisions: ['w:ins', 'w:del'],
};
/** A footnote or endnote as a reader shows it (v9j3.3.2). */
export interface TruthNote { mark: string; text: string }
export interface TruthNotes { footnotes: TruthNote[]; endnotes: TruthNote[] }
export interface DocxTruth {
  notes: TruthNotes;
  reader: string;
  paragraphs: TruthParagraph[];
  tables: { rows: string[][] }[];
  links: TruthLink[];
  images: number;
  counts: TruthCounts;
}
export interface Comparable {
  notes: TruthNotes;
  paragraphs: Omit<TruthParagraph, 'styleName'>[];
  tables: { rows: string[][] }[];
  links: TruthLink[];
  images: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Throws naming the file and the path of the first field of the wrong shape —
 *  chiefly a one-element array PowerShell's ConvertTo-Json collapsed to a scalar. */
export function assertTruthShape(t: unknown, where: string): asserts t is DocxTruth {
  const fail = (path: string): never => { throw new Error(`${where}: ${path} has the wrong shape`); };
  if (!isObj(t)) fail('(root)');
  const o = t as Record<string, unknown>;
  if (typeof o.reader !== 'string') fail('reader');
  if (!Array.isArray(o.paragraphs)) fail('paragraphs');
  (o.paragraphs as unknown[]).forEach((p, i) => {
    if (!isObj(p) || typeof p.text !== 'string') fail(`paragraphs[${i}]`);
    const q = p as Record<string, unknown>;
    if (!Array.isArray(q.segments)) fail(`paragraphs[${i}].segments`);
    (q.segments as unknown[]).forEach((s, j) => { if (!isObj(s) || typeof s.text !== 'string') fail(`paragraphs[${i}].segments[${j}]`); });
    if (!Array.isArray(q.tabs)) fail(`paragraphs[${i}].tabs`);
    (q.tabs as unknown[]).forEach((t, j) => { if (!isObj(t) || typeof t.pos !== 'number') fail(`paragraphs[${i}].tabs[${j}]`); });
  });
  if (!Array.isArray(o.tables)) fail('tables');
  (o.tables as unknown[]).forEach((t2, i) => {
    if (!isObj(t2) || !Array.isArray(t2.rows)) fail(`tables[${i}].rows`);
    ((t2 as { rows: unknown[] }).rows).forEach((row, j) => { if (!Array.isArray(row)) fail(`tables[${i}].rows[${j}]`); });
  });
  if (!Array.isArray(o.links)) fail('links');
  if (typeof o.images !== 'number') fail('images');
  if (!isObj(o.counts)) fail('counts');
  for (const k of COUNT_KEYS) if (typeof (o.counts as Record<string, unknown>)[k] !== 'number') fail(`counts.${k}`);
  if (!isObj(o.notes)) fail('notes');
  for (const k of ['footnotes', 'endnotes']) {
    const list = (o.notes as Record<string, unknown>)[k];
    if (!Array.isArray(list)) fail(`notes.${k}`);
    (list as unknown[]).forEach((n, i) => {
      if (!isObj(n) || typeof n.mark !== 'string' || typeof n.text !== 'string') fail(`notes.${k}[${i}]`);
    });
  }
}

export function readTruth(path: string): DocxTruth {
  const t: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  assertTruthShape(t, path);
  return t;
}

const fmtKey = (s: Segment): string => JSON.stringify([s.bold, s.italic, s.sizePt, s.font]);
export function mergeSegments(segs: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    if (s.text === '') continue;
    const last = out[out.length - 1];
    if (last && fmtKey(last) === fmtKey(s)) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

/** Leaf paths where `a` and `b` differ. Arrays of different length report
 *  `<path>.length` and are compared element by element up to the shorter. */
export function leafDiff(a: unknown, b: unknown, path = '', out: string[] = []): string[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}.length`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) leafDiff(a[i], b[i], `${path}[${i}]`, out);
  } else if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) leafDiff(a[k], b[k], path ? `${path}.${k}` : k, out);
  } else if (!Object.is(a, b) && !(typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.01)) {
    out.push(path);
  }
  return out;
}

export function comparable(t: DocxTruth): Comparable {
  return {
    paragraphs: t.paragraphs.map(({ styleName: _ignored, ...rest }) => rest),
    tables: t.tables, links: t.links, images: t.images, notes: t.notes,
  };
}

export function readerDisagreements(a: DocxTruth, b: DocxTruth): string[] {
  return [...leafDiff(comparable(a), comparable(b)), ...leafDiff(a.counts, b.counts, 'counts')];
}

// ---- readDocx's model in the truth schema ----

const strip = (s: string, list: readonly string[]): string => list.reduce((acc, x) => acc.split(x).join(''), s);

function inlineText(i: WmlInline): string {
  switch (i.kind) {
    case 'text': return i.text;
    case 'tab': return '\t';
    case 'break': return i.type === 'line' ? '\n' : '';
    default: return '';
  }
}

function flatten(blocks: readonly WmlBlock[], inTable: boolean, out: { p: WmlParagraph; inTable: boolean }[]): void {
  for (const b of blocks) {
    if (b.kind === 'paragraph') out.push({ p: b, inTable });
    else for (const row of b.rows) for (const cell of row.cells) flatten(cell.blocks, true, out);
  }
}

function segmentsOf(p: WmlParagraph, list: readonly string[]): Segment[] {
  const segs: Segment[] = [];
  let pending = '';
  for (const i of p.inlines) {
    if (i.kind === 'text') {
      segs.push({ text: pending + i.text, bold: i.props.bold, italic: i.props.italic, sizePt: i.props.sizePt, font: i.props.font ?? '' });
      pending = '';
    } else {
      const t = inlineText(i);
      if (t === '') continue;
      if (segs.length > 0) segs[segs.length - 1].text += t; else pending += t;
    }
  }
  return mergeSegments(segs.map((s) => ({ ...s, text: strip(s.text, list) })));
}

const paraText = (p: WmlParagraph, list: readonly string[]): string => strip(p.inlines.map(inlineText).join(''), list);

function cellText(cell: WmlCell, list: readonly string[]): string {
  const ps: { p: WmlParagraph; inTable: boolean }[] = [];
  flatten(cell.blocks, true, ps);
  // Non-empty paragraphs only: a nested table leaves an empty paragraph after it
  // in the cell, and Word's cell text an empty line per row mark.
  return ps.map((x) => paraText(x.p, list)).filter((t) => t !== '').join('\n');
}

/** `strip` removes text a reader attributes to another story (the text-box
 *  recipe's words, which readDocx keeps inline by m2fp.3's rule). */
export function truthOf(doc: WmlDocument, list: readonly string[] = []): Comparable {
  const flat: { p: WmlParagraph; inTable: boolean }[] = [];
  flatten(doc.blocks, false, flat);
  const links: TruthLink[] = [];
  let images = 0;
  for (const { p } of flat) {
    // A tab or a break carries no link in the model, so it is held and given to
    // the link only if the SAME link's text follows — a TOC entry is one link
    // across its tab, as Word reads it.
    let open: { link: WmlLink; entry: TruthLink } | undefined;
    let held = '';
    for (const i of p.inlines) {
      if (i.kind === 'image') images++;
      if (i.kind === 'text' && i.link) {
        if (open && JSON.stringify(open.link) === JSON.stringify(i.link)) { open.entry.text += held + i.text; held = ''; continue; }
        const entry: TruthLink = 'url' in i.link ? { text: i.text, url: i.link.url } : { text: i.text, anchor: i.link.anchor };
        links.push(entry);
        open = { link: i.link, entry };
        held = '';
      } else if (open && (i.kind === 'tab' || i.kind === 'break')) {
        held += inlineText(i);
      } else { open = undefined; held = ''; }
    }
  }
  return {
    paragraphs: flat.map(({ p, inTable }) => ({
      text: paraText(p, list), heading: p.heading ?? null, listLabel: p.list?.label ?? null, inTable,
      segments: segmentsOf(p, list),
      tabs: (p.props.tabs ?? []).map((t) => ({ pos: Math.round(t.posPt * 20) / 20, align: t.align, leader: t.leader })),
    })),
    tables: doc.blocks.filter((b) => b.kind === 'table').map((t) => ({
      rows: t.rows.map((row) => row.cells.filter((c) => c.vMerge !== 'continue').map((c) => cellText(c, list))),
    })),
    links, images, notes: notesOf(doc),
  };
}

/** Our notes in the truth schema (v9j3.3.2): each reference in document order,
 *  its note's text, and the mark Word's numbering gives it — resolved by
 *  wmlflow.ts's own noteFormat/sectionNotes and the engine's formatMark,
 *  counting only auto-numbered notes, restarting at an eachSect section.
 *  Per-page restart is not projected (no recipe uses it). Cell references are
 *  included: Word and LibreOffice number them. */
function notesOf(doc: WmlDocument): TruthNotes {
  const secs = sectionNotes(doc);
  const out: TruthNotes = { footnotes: [], endnotes: [] };
  const counters = { footnote: 0, endnote: 0 };
  let sec = 0;
  const noteText = (blocks: readonly WmlBlock[]): string => {
    const flat: { p: WmlParagraph; inTable: boolean }[] = [];
    flatten(blocks, false, flat);
    return flat.map((x) => paraText(x.p, [])).join('\n').trim();
  };
  const visit = (blocks: readonly WmlBlock[], top: boolean): void => {
    for (const b of blocks) {
      if (b.kind === 'table') { for (const row of b.rows) for (const cell of row.cells) visit(cell.blocks, false); continue; }
      for (const i of b.inlines) {
        if (i.kind !== 'note') continue;
        const part = i.note === 'footnote' ? doc.footnotes : doc.endnotes;
        const body = part?.get(i.id);
        if (body === undefined) continue;
        const pr = secs[sec]?.[i.note === 'footnote' ? 'footnotePr' : 'endnotePr'];
        const mark = i.mark ?? formatMark((pr?.numStart ?? 1) + counters[i.note]++,
          noteFormat(pr?.numFmt) ?? (i.note === 'footnote' ? 'arabic' : 'roman'));
        out[i.note === 'footnote' ? 'footnotes' : 'endnotes'].push({ mark, text: noteText(body) });
      }
      if (top && b.sectionEnd !== undefined) {
        sec++;
        for (const k of ['footnote', 'endnote'] as const)
          if (secs[sec]?.[k === 'footnote' ? 'footnotePr' : 'endnotePr']?.numRestart === 'eachSect') counters[k] = 0;
      }
    }
  };
  visit(doc.blocks, true);
  return out;
}
