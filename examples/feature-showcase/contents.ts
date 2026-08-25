import type { Document, Page } from '../../src/index.js';
import type { OutlineItem } from '../../src/index.js';
import type { Section } from './main.js';
import { addText, pageWidth, pageHeight, sectionHeader } from './theme.js';

export function addTOC(page: Page, sections: Section[]): void {
  const w = pageWidth(page);
  const h = pageHeight(page);

  sectionHeader(page, 'Contents',
    'page.AddTOC  •  dotted leaders  •  logical page labels  •  clickable links');

  // No explicit `label`: AddTOC defaults to each target page's /PageLabels
  // label, which main.ts set before calling this. A sequential "N." index is
  // folded into the title so the sales report's continuation page creates no
  // gap in the numbering.
  page.AddTOC(
    sections.map((s, i) => ({ title: `${i + 1}.  ${s.title}`, page: s.page.Number })),
    [72, 160, w - 172, h - 340],
    {
      font: 'Helvetica',
      fontSize: 13,
      color: [0.1, 0.1, 0.15],
      rowGap: 18,
    },
  );

  addText(page, 'Click any title above to jump to the section.',
    [50, 120, w - 50, 140],
    { font: 'Helvetica-Oblique', size: 10, color: [0.55, 0.55, 0.6], align: 'center' });
}

const OUTLINE_COLORS: Record<string, [number, number, number] | undefined> = {
  text: [0.15, 0.20, 0.55],
  image: undefined,
  form: undefined,
  annotations: [0.6, 0, 0.6],
  redaction: [0, 0, 0],
  bill: [0.6, 0.3, 0.1],
  sales: [0.1, 0.15, 0.4],
  landscape: [0.4, 0.3, 0.6],
  vector: [0.1, 0.5, 0.3],
  flatten: [0.3, 0.3, 0.3],
  flow: [0.2, 0.4, 0.6],
};

const BOLD_SUBTYPES = new Set(['text', 'bill', 'sales', 'vector']);

/** A two-level tree: one entry per section, with per-category children under
 *  the sales report. Every destination is a NAME, so it resolves at view time
 *  and keeps working after the redaction pass rewrites content streams. */
export function addBookmarks(doc: Document, sections: Section[]): void {
  const items: OutlineItem[] = sections.map((s) => {
    const item: OutlineItem = { Title: s.title, Dest: { name: s.dest } };
    const color = OUTLINE_COLORS[s.subtype];
    if (color) item.Color = color;
    if (BOLD_SUBTYPES.has(s.subtype)) item.Bold = true;
    if (s.subtype === 'sales') {
      item.Open = true;
      item.Children = ['Pasta', 'Pizza', 'Antipasti', 'Desserts', 'Beverages']
        .map((cat) => ({ Title: cat, Dest: { name: s.dest } }));
    }
    return item;
  });
  doc.SetOutlines(items);
}
