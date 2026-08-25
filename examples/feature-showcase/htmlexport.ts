import { writeFileSync } from 'node:fs';
import type { Document, Page } from '../../src/index.js';
import type { Box } from './theme.js';
import { addText, cardGrid, pageWidth, sectionHeader, INK, MUTED } from './theme.js';

const SEMANTIC_PATH = 'docs/feature-showcase.html';
const FIXED_PATH = 'docs/feature-showcase-fixed.html';

function kb(s: string): string {
  return `${(Buffer.byteLength(s, 'utf8') / 1024).toFixed(1)} KB`;
}

/** The first `count` non-blank lines of `html`, trimmed and clipped to `width`
 *  characters so each fits a card on one line. */
function excerpt(html: string, count: number, width: number): string[] {
  return html
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, count)
    .map((l) => (l.length > width ? `${l.slice(0, width - 1)}…` : l));
}

export function addHtmlShowcase(doc: Document, page: Page): void {
  const w = pageWidth(page);

  sectionHeader(page, 'HTML Export',
    'semantic reflowable markup  •  fixed positioned pages  •  fonts embedded as WOFF');

  // Semantic mode reflows from the structure tree, so this must run after the
  // tagging pass: ToHtml falls back to a heuristic body when GetStructTree() is
  // null, and the export loses its heading structure silently.
  const semantic = doc.ToHtml();
  const fixed = doc.ToHtml({ mode: 'fixed', fonts: 'embed' });

  writeFileSync(SEMANTIC_PATH, semantic, 'utf8');
  writeFileSync(FIXED_PATH, fixed, 'utf8');
  console.log(`html: ${SEMANTIC_PATH} (${kb(semantic)}), ${FIXED_PATH} (${kb(fixed)})`);

  const semanticTables = (semantic.match(/<table[ >]/g) ?? []).length;
  const semanticImages = (semantic.match(/<img[^>]*\ssrc=/g) ?? []).length;

  addText(page,
    'The same document, exported two ways. Semantic mode walks the structure '
    + 'tree the previous section built and emits reflowable markup — headings '
    + 'and paragraphs that read in a browser at any width. Fixed mode reproduces '
    + 'each page as positioned SVG and absolutely-placed text, inlining every '
    + 'embeddable font program as a base64 WOFF @font-face so the page looks the '
    + 'same without the reader having the fonts installed.',
    [50, 622, w - 50, 700], { size: 10, color: INK, lineSpacing: 1.35 });

  // Report what this run actually produced, not what the feature aspires to.
  addText(page,
    `On this document the semantic export carries ${semanticTables} table(s) and `
    + `${semanticImages} image(s), each inlined as a data URI — which is most of `
    + 'why the semantic file is the size it is. Every /Figure in the tree is '
    + 'matched to the image its marked content draws, by MCID, so the alt text '
    + 'stays with the right picture. Every table in the tree reaches the export, '
    + 'and the cards and callouts on these pages do not: a ruled rectangle with '
    + 'no interior rule is page furniture, so it is neither tagged as a table '
    + 'nor exported as one, and its text flows as prose. The counts above are '
    + 'measured from the file this run just wrote.',
    [50, 566, w - 50, 616], { size: 8.5, color: MUTED, lineSpacing: 1.3 });

  const inners = cardGrid(page, [
    `Semantic — feature-showcase.html  (${kb(semantic)})`,
    `Fixed — feature-showcase-fixed.html  (${kb(fixed)})`,
  ], { cols: 1, rows: 2, left: 50, right: w - 50, top: 556, bottom: 150, gapY: 18 });

  const paint = (inner: Box, html: string): void => {
    excerpt(html, 16, 104).forEach((line, i) => {
      const y = inner[3] - 12 - i * 10.5;
      if (y < inner[1]) return;
      addText(page, line, [inner[0], y, inner[2], y + 9.5], { size: 7, color: MUTED });
    });
  };
  paint(inners[0], semantic);
  paint(inners[1], fixed);

  addText(page,
    'Both files are build products, regenerated on every run and excluded from '
    + 'git. Open them beside this PDF to compare: the semantic export reflows to '
    + 'the window, the fixed export does not. Neither contains the signature '
    + 'section that follows — signing happens after the PDF is written.',
    [50, 108, w - 50, 142], { size: 8.5, color: MUTED, lineSpacing: 1.35 });
}
