import { Document } from '../../src/document.js';
import { PageFormat } from '../../src/pageformat.js';

/** Primary-colour pages identify which selected page was actually processed. */
export function controlDocument(): Document {
  const doc = Document.New();
  for (let channel = 0; channel < 3; channel++) {
    const { page } = doc.AddPage(PageFormat.custom(40, 30));
    const color: [number, number, number] = [0, 0, 0];
    color[channel] = 1;
    const g = page.Graphics();
    g.setFillColor(color).rect(0, 0, 40, 30).fill();
    g.apply();
  }
  return doc;
}
