import type { Annotation } from './annotation.js';
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement, StructTreeRoot } from './struct.js';
import { annotationObjects, tagAnnotation } from './structwrite.js';
import { assembleLines, layoutLines, runFromGlyph, visitContent, type GlyphEvent, type Rect } from './text.js';
import { isArray, name, type PdfDict } from './types.js';

/** One text line or table cell, in the structure order produced by AutoTag. */
export interface TextRegion { quad: Rect; owner: StructElement }

export function existingAnnotationOwners(doc: Document, root: StructTreeRoot): Map<PdfDict, StructElement> {
  const owners = new Map<PdfDict, StructElement>();
  const seen = new Set<PdfDict>();
  const pending = root.Children;
  while (pending.length) {
    const el = pending.pop()!;
    if (seen.has(el.Dict)) continue;
    seen.add(el.Dict);
    for (const obj of annotationObjects(doc, el.Dict)) owners.set(obj, el);
    for (const child of el.Children) pending.push(child);
  }
  // A producer may have supplied only the reverse link. Capture it before
  // AutoTag allocates any keys, and only reuse reachable structure elements.
  if (seen.size) for (const page of doc.Pages) for (const annot of page.Annotations) {
    const key = doc.resolve(annot.Dict.get('StructParent'));
    if (typeof key !== 'number' || owners.has(annot.Dict)) continue;
    const owner = root.ElementForObject(key);
    if (owner && seen.has(owner.Dict)) owners.set(annot.Dict, owner);
  }
  return owners;
}

function annotationRole(a: Annotation): string | undefined {
  const type = a.Subtype, flags = a.Flags;
  if (!type || type === 'Popup' || type === 'PrinterMark' || type === 'TrapNet') return undefined;
  // Invisible or Hidden; NoView still participates when ToggleNoView is set.
  if ((flags & 3) || ((flags & 32) && !(flags & 256))) return undefined;
  if (type === 'Widget') {
    const r = a.Rect;
    return r && r[0] === r[2] && r[1] === r[3] ? undefined : 'Form';
  }
  return type === 'Link' ? 'Link' : 'Annot';
}

function inside(rect: Rect, x: number, y: number): boolean {
  return Math.min(rect[0], rect[2]) <= x && x <= Math.max(rect[0], rect[2])
    && Math.min(rect[1], rect[3]) <= y && y <= Math.max(rect[1], rect[3]);
}

type Point = [number, number];
function linkQuads(doc: Document, annot: Annotation, rect: Rect): Point[][] {
  const raw = doc.resolve(annot.Dict.get('QuadPoints'));
  if (!isArray(raw) || raw.length % 8 !== 0) return [];
  const quads: Point[][] = [];
  for (let i = 0; i < raw.length; i += 8) {
    const points: Point[] = [];
    for (let j = i; j < i + 8; j += 2) {
      const x = doc.resolve(raw[j]), y = doc.resolve(raw[j + 1]);
      if (typeof x !== 'number' || typeof y !== 'number' || !inside(rect, x, y)) return [];
      points.push([x, y]);
    }
    // Producers use both perimeter and Z order. Normalize before testing the
    // four edges so a slanted link excludes glyphs in its bounding-box corners.
    const cx = points.reduce((s, p) => s + p[0], 0) / 4, cy = points.reduce((s, p) => s + p[1], 0) / 4;
    points.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    quads.push(points);
  }
  return quads;
}

function containsPoint(quad: Point[], x: number, y: number): boolean {
  return quad.every(([ax, ay], i) => {
    const [bx, by] = quad[(i + 1) % 4];
    return (bx - ax) * (y - ay) >= (by - ay) * (x - ax);
  });
}

function orderedGlyphs(doc: Document, page: Page): GlyphEvent[] {
  const glyphs: GlyphEvent[] = [];
  visitContent(doc, page, { glyph: g => { if (!g.artifact) glyphs.push(g); } }, { skipHidden: true });
  const { refs } = layoutLines(glyphs.map(g => runFromGlyph(g, g)));
  return Array.from(new Set(refs.filter((g): g is GlyphEvent => g !== undefined)));
}

function linkAnchor(doc: Document, annot: Annotation, rect: Rect, regions: TextRegion[], glyphs: GlyphEvent[]) {
  const quads = linkQuads(doc, annot, rect), hits = [];
  let anchor: { owner: StructElement; order: number } | undefined;
  for (const [order, glyph] of glyphs.entries()) {
    const x = (glyph.quad[0] + glyph.quad[2]) / 2, y = (glyph.quad[1] + glyph.quad[3]) / 2;
    if (!inside(rect, x, y) || (quads.length && !quads.some(q => containsPoint(q, x, y)))) continue;
    hits.push(runFromGlyph(glyph));
    if (!anchor && glyph.text.trim()) {
      const region = regions.find(r => inside(r.quad, x, y));
      if (region) anchor = { owner: region.owner, order };
    }
  }
  return anchor && { ...anchor, text: assembleLines(hits).trim() };
}

export function tagPageAnnotations(doc: Document, root: StructTreeRoot, page: Page, annotations: Annotation[], regions: TextRegion[],
  existing: Map<PdfDict, StructElement>, seen: Set<PdfDict>): number {
  if (!annotations.length) return 0;
  page.Dict.set('Tabs', name('S'));
  doc.markModified();
  const pending = [];
  let glyphs: GlyphEvent[] | undefined;
  for (const annot of annotations) {
    if (seen.has(annot.Dict)) continue;
    seen.add(annot.Dict);
    const role = annotationRole(annot);
    if (!role) continue;
    const owner = existing.get(annot.Dict);
    if (owner) {
      tagAnnotation(doc, owner, annot, page);
      continue;
    }
    const rect = annot.Rect;
    const anchor = role === 'Link' && rect && regions.length
      ? linkAnchor(doc, annot, rect, regions, glyphs ??= orderedGlyphs(doc, page)) : undefined;
    pending.push({ annot, role, anchor });
  }
  // Stable sort leaves ties and unmatched entries in the original /Annots order.
  pending.sort((a, b) => (a.anchor?.order ?? glyphs?.length ?? 0) - (b.anchor?.order ?? glyphs?.length ?? 0));
  for (const { annot, role, anchor } of pending) {
    const alt = annot.Contents ?? anchor?.text;
    const element = (anchor?.owner ?? root).Append(role, alt ? { alt } : undefined);
    tagAnnotation(doc, element, annot, page);
  }
  return pending.length;
}
