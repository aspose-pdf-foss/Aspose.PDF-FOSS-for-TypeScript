import type { Document, Page } from '../../src/index.js';
import { addText, sectionHeader, INK, MUTED, NAVY } from './theme.js';
import { asposeLogoPng } from './assets.js';

/** A floor plan drawn across six optional-content groups, one of them nested.
 *
 *  Only three kinds of content can bind to a layer: a PageGraphics sequence
 *  between BeginLayer/EndLayer, an image XObject via AddImage({ layer }), and a
 *  barcode via AddBarcode({ layer }). Text stamping (AddText / AddTextBlock)
 *  takes no layer option, so the legend below is base content and stays visible
 *  whatever the viewer toggles. That is a real limit of the API, noted here and
 *  stated on the page itself rather than papered over. */
export function addLayerShowcase(doc: Document, page: Page): void {
  sectionHeader(page, 'Optional-Content Layers',
    'OCGs  •  nested /D /Order  •  a default-off layer  •  layered images and barcodes');

  const oc = doc.OptionalContent;
  const walls = oc.AddLayer('Walls');
  const furniture = oc.AddLayer('Furniture');
  const seating = oc.AddLayer('Seating', { parent: furniture });
  const grid = oc.AddLayer('Grid', { visible: false });
  const branding = oc.AddLayer('Branding');
  const assetTag = oc.AddLayer('Asset Tag');

  // Plan bounds.
  const x0 = 80, y0 = 300, x1 = 515, y1 = 640;
  const g = page.Graphics();

  // --- Grid (default off): a dashed 40pt measurement grid ------------------
  g.BeginLayer(grid);
  g.save().setStrokeColor([0.72, 0.76, 0.88]).setLineWidth(0.4).setDash([3, 3]);
  for (let x = x0; x <= x1; x += 40) g.drawLine(x, y0, x, y1);
  for (let y = y0; y <= y1; y += 40) g.drawLine(x0, y, x1, y);
  g.stroke().restore();
  g.EndLayer();

  // --- Walls: the outer shell, a partition, and a door swing ---------------
  g.BeginLayer(walls);
  g.save().setStrokeColor(NAVY).setLineWidth(3).setLineJoin(0)
    .rect(x0, y0, x1 - x0, y1 - y0).stroke().restore();
  g.save().setStrokeColor(NAVY).setLineWidth(3)
    .drawLine(x0 + 250, y0, x0 + 250, y1 - 90).stroke().restore();
  g.save().setStrokeColor([0.55, 0.60, 0.75]).setLineWidth(1).setDash([4, 3])
    .moveTo(x0 + 250, y1 - 90).arc(x0 + 250, y1 - 90, 46, 0, Math.PI / 2)
    .stroke().restore();
  g.EndLayer();

  // --- Furniture: desks in the left room -----------------------------------
  g.BeginLayer(furniture);
  g.save().setFillColor([0.88, 0.91, 0.98]).setStrokeColor([0.45, 0.52, 0.75]).setLineWidth(1);
  g.rect(x0 + 30, y1 - 90, 90, 50).fillStroke();
  g.rect(x0 + 140, y1 - 90, 90, 50).fillStroke();
  g.rect(x0 + 30, y0 + 40, 200, 55).fillStroke();
  g.restore();
  g.EndLayer();

  // --- Seating (nested under Furniture): a chair beside each desk ----------
  g.BeginLayer(seating);
  g.save().setFillColor([1.0, 0.90, 0.76]).setStrokeColor([0.80, 0.55, 0.20]).setLineWidth(1);
  const chairs: Array<[number, number]> = [
    [x0 + 75, y1 - 115], [x0 + 185, y1 - 115], [x0 + 80, y0 + 20], [x0 + 180, y0 + 20],
  ];
  for (const [cx, cy] of chairs) g.circle(cx, cy, 13).fillStroke();
  g.restore();
  g.EndLayer();

  g.apply();

  // --- Branding: an image XObject bound to a layer via /OC -----------------
  page.AddImage(asposeLogoPng(), [x0 + 290, y1 - 90, 110, 34], { layer: branding });

  // --- Asset Tag: a barcode bound to a layer -------------------------------
  page.AddBarcode({ type: 'code128', data: 'ROOM-204' },
    [x0 + 290, y0 + 40, 130, 44], { layer: assetTag, text: true });

  // --- Legend (base content — see the note on this function) ---------------
  addText(page, 'Layers in this drawing', [80, 262, 320, 278],
    { font: 'Helvetica-Bold', size: 12, color: NAVY });

  const rows: Array<[string, string]> = [
    ['Walls', 'on — outer shell, partition, door swing'],
    ['Furniture', 'on — desks'],
    ['Furniture › Seating', 'on — nested under Furniture in /D /Order'],
    ['Grid', 'OFF — switch it on in the layers panel'],
    ['Branding', 'on — an image XObject bound via /OC'],
    ['Asset Tag', 'on — a barcode bound via /OC'],
  ];
  rows.forEach(([layerName, note], i) => {
    const y = 246 - i * 15;
    addText(page, layerName, [80, y, 210, y + 12], { size: 9.5, color: INK });
    addText(page, note, [216, y, 545, y + 12], { size: 9.5, color: MUTED });
  });

  addText(page,
    'Text stamping takes no layer option — only PageGraphics sequences, image '
    + 'XObjects and barcodes bind to an optional-content group. This legend is '
    + 'therefore base content and stays visible whatever you toggle.',
    [80, 120, 545, 152],
    { size: 8.5, color: MUTED, lineSpacing: 1.35 });
}
