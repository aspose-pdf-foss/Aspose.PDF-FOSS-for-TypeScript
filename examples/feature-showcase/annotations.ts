import type { Page } from '../../src/index.js';
import type { Box } from './theme.js';
import {
  addText, centeredRect, pageWidth, pageHeight, rectToQuads, sectionHeader, NAVY, FAINT,
} from './theme.js';

interface Cell {
  name: string;
  caption: string;
  render: (body: Box) => void;
}

export function addAnnotations(page: Page): void {
  const w = pageWidth(page);
  const h = pageHeight(page);

  sectionHeader(page, 'Annotation Gallery',
    '16 of 18 supported types  ·  Redact has its own page; Widget is shown via AcroForm');

  addText(page,
    'Also available  ·  read existing annotations via page.Annotations  ·  typed handles per /Subtype with live setters  ·  RemoveAnnotation  ·  /AP generated on create  ·  round-trip safe under AES encryption',
    [30, h - 148, w - 30, h - 115],
    { size: 9, color: FAINT, align: 'center', lineSpacing: 1.3 });

  const cardW = 235;
  const cardH = 75;
  const labelH = 14;
  const topY = 685;
  const gapX = 25;
  const leftX = 50;
  const rightX = leftX + cardW + gapX;

  // A markup sample: one line of text with the annotation over it. No manual
  // decoration — this library generates the /AP for all four markup subtypes,
  // where the Go original had to draw each decoration into the content stream.
  const markup = (body: Box, sample: string, add: (quads: number[]) => void): void => {
    const yMid = (body[1] + body[3]) / 2 - 6;
    const textRect: Box = [body[0] + 4, yMid, body[2] - 4, yMid + 16];
    addText(page, sample, textRect, { font: 'Times-Roman', size: 12 });
    add(rectToQuads(textRect));
  };

  const cells: Cell[] = [
    {
      name: 'Highlight',
      caption: 'translucent yellow over text',
      render: (body) => markup(body, 'Highlight this phrase', (quads) =>
        page.AddHighlight({ quads, color: [1, 1, 0], contents: 'Yellow highlight' })),
    },
    {
      name: 'Underline',
      caption: 'single line under the text',
      render: (body) => markup(body, 'Underline this phrase', (quads) =>
        page.AddUnderline({ quads, color: [0, 0, 1] })),
    },
    {
      name: 'Squiggly',
      caption: 'wavy underline for proofreaders',
      render: (body) => markup(body, 'Squiggle this phrase', (quads) =>
        page.AddSquiggly({ quads, color: [1, 0.5, 0] })),
    },
    {
      name: 'StrikeOut',
      caption: 'line through the text',
      render: (body) => markup(body, 'Strike this phrase out', (quads) =>
        page.AddStrikeOut({ quads, color: [1, 0, 0] })),
    },
    {
      name: 'Link',
      caption: 'clickable URL with a URI action',
      render: (body) => {
        const yMid = (body[1] + body[3]) / 2 - 6;
        const rect: Box = [body[0] + 4, yMid, body[2] - 4, yMid + 16];
        addText(page, 'Open example.com', rect,
          { font: 'Helvetica-Bold', size: 11, color: [0.1, 0.3, 0.7], underline: true });
        page.AddLink({ rect, action: { type: 'uri', uri: 'https://example.com' }, border: 0 });
      },
    },
    {
      name: 'Text — sticky note',
      caption: 'click the icon to read the comment',
      render: (body) => {
        const x = body[0] + 12;
        const y = body[1] + (body[3] - body[1]) / 2 - 4;
        page.AddTextNote({
          rect: [x, y, x + 20, y + 20], icon: 'Note', author: 'Reviewer',
          contents: 'This is a sticky-note annotation.',
        });
      },
    },
    {
      name: 'FreeText',
      caption: 'text drawn directly on the page',
      render: (body) => {
        page.AddFreeText({
          rect: [body[0] + 30, body[1] + 4, body[2] - 30, body[3] - 4],
          contents: 'FreeText sample', fontSize: 10, align: 'center',
          fill: [1, 1, 0.8], width: 1,
        });
      },
    },
    {
      name: 'Square',
      caption: 'filled rectangle with border',
      render: (body) => {
        page.AddSquare({
          rect: centeredRect(body, 80, 35), color: [0.8, 0, 0], fill: [1, 1, 0.5], width: 2,
        });
      },
    },
    {
      name: 'Circle',
      caption: 'stroked ellipse, no fill',
      render: (body) => {
        page.AddCircle({ rect: centeredRect(body, 80, 35), color: [0, 0.5, 0], width: 2 });
      },
    },
    {
      name: 'Line',
      caption: 'line with start/end arrow endings',
      render: (body) => {
        const midY = (body[1] + body[3]) / 2;
        page.AddLine({
          line: [body[0] + 25, midY, body[2] - 25, midY],
          color: [0, 0, 0.7], width: 2,
          startEnding: 'OpenArrow', endEnding: 'ClosedArrow',
        });
      },
    },
    {
      name: 'Ink',
      caption: 'free-hand pen strokes',
      render: (body) => {
        const midY = (body[1] + body[3]) / 2;
        const step = (body[2] - body[0] - 30) / 6;
        const x0 = body[0] + 15;
        const stroke: number[] = [];
        [-8, 6, -4, 10, -2, 8, -6].forEach((dy, i) => stroke.push(x0 + i * step, midY + dy));
        page.AddInk({ paths: [stroke], color: [0.6, 0, 0.6], width: 2 });
      },
    },
    {
      name: 'Polygon',
      caption: 'closed shape with fill + border',
      render: (body) => {
        const cx = (body[0] + body[2]) / 2;
        const cy = (body[1] + body[3]) / 2;
        const verts: number[] = [];
        for (let k = 0; k < 5; k++) {
          const ang = Math.PI / 2 + (k * 2 * Math.PI) / 5;
          verts.push(cx + 20 * Math.cos(ang), cy + 16 * Math.sin(ang));
        }
        page.AddPolygon({ vertices: verts, color: [0.8, 0, 0], fill: [0.6, 0.8, 1], width: 1.5 });
      },
    },
    {
      name: 'Polyline',
      caption: 'open vertex path with arrow ending',
      render: (body) => {
        const midY = (body[1] + body[3]) / 2;
        const x0 = body[0] + 20;
        const width = body[2] - body[0] - 40;
        page.AddPolyline({
          vertices: [
            x0, midY - 8,
            x0 + width * 0.35, midY + 10,
            x0 + width * 0.65, midY - 10,
            x0 + width, midY + 8,
          ],
          color: [0, 0.5, 0.2], width: 2, endEnding: 'ClosedArrow',
        });
      },
    },
    {
      name: 'Stamp',
      caption: 'predefined or custom-image stamp',
      render: (body) => {
        page.AddStamp({ rect: centeredRect(body, 110, 35), name: 'Approved' });
      },
    },
    {
      name: 'FileAttachment',
      caption: 'embedded file behind a paperclip icon',
      render: (body) => {
        const x = body[0] + 12;
        const y = body[1] + (body[3] - body[1]) / 2 - 4;
        page.AddFileAttachment({
          rect: [x, y, x + 20, y + 20],
          name: 'q3-report.txt',
          bytes: new TextEncoder().encode('Confidential report contents (demonstration only).'),
          icon: 'Paperclip',
          contents: 'Quarterly report — see attachment',
          description: 'Q3 financial summary',
          addToCatalog: true,
        });
      },
    },
    {
      name: 'Caret',
      caption: 'text-insertion marker (chevron)',
      render: (body) => {
        const cx = (body[0] + body[2]) / 2;
        const cy = (body[1] + body[3]) / 2;
        page.AddCaret({
          rect: [cx - 11, cy - 12, cx + 11, cy + 12],
          symbol: 'paragraph', color: [0.85, 0.1, 0.1],
        });
      },
    },
  ];

  // Two columns, filled column by column: cells 0-7 left, 8-15 right.
  const rowsPerCol = 8;
  const g = page.Graphics();
  cells.forEach((c, i) => {
    const colIdx = Math.floor(i / rowsPerCol);
    const rowIdx = i % rowsPerCol;
    const cardX = colIdx === 1 ? rightX : leftX;
    const cardTop = topY - rowIdx * cardH;
    const cardBot = cardTop - cardH;

    if (rowIdx > 0) {
      g.setStrokeColor([0.9, 0.9, 0.93]).setLineWidth(0.5)
        .drawLine(cardX + 4, cardTop - 1, cardX + cardW - 4, cardTop - 1).stroke();
    }

    addText(page, c.name, [cardX, cardTop - labelH, cardX + cardW, cardTop - 2],
      { font: 'Helvetica-Bold', size: 11, color: NAVY });
    addText(page, c.caption,
      [cardX, cardTop - labelH - 11, cardX + cardW, cardTop - labelH - 1],
      { font: 'Helvetica-Oblique', size: 8, color: [0.55, 0.55, 0.6] });

    c.render([cardX + 4, cardBot + 4, cardX + cardW - 4, cardTop - labelH - 14]);
  });
  g.apply();
}
