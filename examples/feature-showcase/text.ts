import type { EmbeddedFont, Page } from '../../src/index.js';
import { addText, pageWidth, pageHeight, sectionHeader, NAVY, FAINT, MUTED } from './theme.js';
import type { TextStyle } from './theme.js';

export function addPageText(page: Page, deja: EmbeddedFont): void {
  const w = pageWidth(page);
  const h = pageHeight(page);

  sectionHeader(page, 'Text Capabilities Showcase',
    'Standard 14 fonts  •  embedded TTF & Unicode  •  decorations  •  colors  •  word-wrap');

  addText(page,
    'Also available  ·  GetText / GetStructuredText (font, colour, position)  ·  Search / ReplaceText  ·  AddWatermark on selected pages  ·  destructive removal via Redact / ApplyRedactions',
    [50, h - 145, w - 50, h - 120],
    { size: 9, color: FAINT, align: 'center', lineSpacing: 1.3 });

  const sectionStyle: TextStyle = { font: 'Helvetica-Bold', size: 13, color: NAVY };
  const section = (label: string, top: number): void => {
    addText(page, label, [50, top - 16, w - 50, top], sectionStyle);
  };

  // ===== 1: Standard 14 PDF Fonts =====
  section('Standard 14 PDF Fonts', h - 170);
  const sample = 'The quick brown fox jumps over 42 lazy dogs.';
  const labelStyle: TextStyle = { font: 'Courier', size: 8, color: [0.5, 0.5, 0.5] };
  const fonts: Array<[TextStyle['font'], string]> = [
    ['Helvetica', 'Helvetica'],
    ['Helvetica-Bold', 'Helvetica-Bold'],
    ['Helvetica-Oblique', 'Helvetica-Oblique'],
    ['Helvetica-BoldOblique', 'Helvetica-BoldOblique'],
    ['Times-Roman', 'Times-Roman'],
    ['Times-Bold', 'Times-Bold'],
    ['Times-Italic', 'Times-Italic'],
    ['Times-BoldItalic', 'Times-BoldItalic'],
    ['Courier', 'Courier'],
    ['Courier-Bold', 'Courier-Bold'],
    ['Courier-Oblique', 'Courier-Oblique'],
    ['Courier-BoldOblique', 'Courier-BoldOblique'],
  ];
  let y = h - 200;
  for (const [font, label] of fonts) {
    addText(page, label, [50, y - 11, 185, y + 1], labelStyle);
    addText(page, sample, [190, y - 12, w - 50, y + 2], { font, size: 11 });
    y -= 12;
  }

  // ===== 2: Embedded TTF — Unicode & RTL =====
  y -= 14;
  section('Embedded TTF (DejaVu Sans) — Unicode & RTL', y);
  y -= 22;

  for (const line of [
    'Русский: Здравствуй, мир!',
    'Ελληνικά: Γειά σου, κόσμε!',
    'Deutsch: Schöne Grüße aus München',
    'Français: Bonjour à tous, ça va?',
    'Symbols: → ← ★ ♥ ☎ € § ¶ ¥ £ © ®',
  ]) {
    addText(page, line, [60, y - 14, w - 50, y + 1], { font: deja, size: 11 });
    y -= 15;
  }

  addText(page, 'Right-to-left — automatic BiDi + Arabic shaping, right-aligned:',
    [60, y - 12, w - 50, y + 1], { font: 'Helvetica-Oblique', size: 9, color: MUTED });
  y -= 15;
  for (const line of ['עברית — שלום עולם! (3 ספרים)', 'العربية — مرحبا بالعالم ٢٠٢٤']) {
    // shape + dir: 'rtl' drive the bidi engine and Arabic joining; align right
    // so the paragraph sits on the edge a reader of these scripts expects.
    page.AddTextBlock(line, [60, y - 15, w - 110, 16],
      { font: deja, fontSize: 12, shape: true, dir: 'rtl', align: 'right', leading: 12 });
    y -= 16;
  }

  // ===== 3: Decorations =====
  y -= 12;
  section('Decorations', y);
  y -= 22;
  addText(page, 'This text is underlined.', [60, y - 14, 295, y + 1],
    { size: 11, underline: true });
  addText(page, 'This text is struck through.', [310, y - 14, 545, y + 1],
    { size: 11, strikethrough: true });
  y -= 18;
  addText(page, 'Yellow highlight background.', [60, y - 14, 295, y + 2],
    { size: 11, background: [1, 0.95, 0.4] });
  addText(page, '35% opacity text (faded).', [310, y - 14, 545, y + 1],
    { size: 11, opacity: 0.35 });
  y -= 22;

  // ===== 4: Color palette =====
  section('Color palette', y);
  y -= 22;
  const colors: Array<[[number, number, number], string]> = [
    [[0.85, 0.10, 0.10], 'crimson'],
    [[0.10, 0.60, 0.20], 'forest'],
    [[0.10, 0.20, 0.80], 'azure'],
    [[0.60, 0.30, 0.70], 'violet'],
    [[0.95, 0.55, 0.05], 'amber'],
    [[0.05, 0.55, 0.55], 'teal'],
  ];
  const colW = (w - 100) / colors.length;
  colors.forEach(([color, label], i) => {
    addText(page, label, [50 + i * colW, y - 16, 50 + (i + 1) * colW, y + 2],
      { font: 'Helvetica-Bold', size: 13, color, align: 'center' });
  });
  y -= 28;

  // ===== 5: Word wrap & line spacing =====
  section('Word wrap & line spacing', y);
  y -= 22;
  addText(page,
    'This paragraph demonstrates automatic word wrapping at the right edge of the bounding '
    + 'rectangle. Words break on whitespace; line spacing is 1.4× the font size. AddTextBlock '
    + 'handles alignment, clipping at the rectangle boundary, and font-aware glyph-width '
    + 'measurement, so all these features carry through into table cells and free-text annotations.',
    [60, 80, w - 50, y + 2],
    { font: 'Times-Roman', size: 11, lineSpacing: 1.4 });
}
