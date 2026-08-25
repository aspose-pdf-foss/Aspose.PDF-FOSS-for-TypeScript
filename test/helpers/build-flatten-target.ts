const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Assemble a classic-xref PDF from a 1-based array of object bodies. */
function assemble(objects: string[], maxObj: number, rootNum: number): Uint8Array {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root ${rootNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

/** A Form XObject stream object body with the given dict extras and content. */
function formXObject(extra: string, content: string): string {
  return `<< /Type /XObject /Subtype /Form ${extra} /Length ${byteLen(content)} >>\n` +
    `stream\n${content}\nendstream`;
}

/**
 * One page carrying four /Stamp annotations to exercise flatten:
 *  - a4: visible stamp, identity Matrix, /AP /N a single stream (blue box).
 *  - a5: visible stamp, Matrix [2 0 0 2 0 0] (BBox half the apparent size),
 *        proves the transformed-box placement accounts for /Matrix.
 *  - a6: Hidden (/F 2) — must be skipped (kept in /Annots, not drawn).
 *  - a7: no /AP at all — must be skipped (kept in /Annots, not drawn).
 */
export function buildFlattenTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R 6 0 R 8 0 R 9 0 R] >>`;
  // a4 (obj 4): visible stamp, identity matrix, single-stream /AP /N (obj 5).
  objects[4] = `<< /Type /Annot /Subtype /Stamp /Rect [10 20 110 60] /F 4 /AP << /N 5 0 R >> >>`;
  objects[5] = formXObject(`/BBox [0 0 100 40] /Matrix [1 0 0 1 0 0]`, `q 0 0 1 rg 0 0 100 40 re f Q`);
  // a6 (obj 6): visible stamp, Matrix scales BBox x2; /AP /N (obj 7).
  objects[6] = `<< /Type /Annot /Subtype /Stamp /Rect [0 100 100 140] /F 4 /AP << /N 7 0 R >> >>`;
  objects[7] = formXObject(`/BBox [0 0 50 20] /Matrix [2 0 0 2 0 0]`, `q 1 0 0 rg 0 0 50 20 re f Q`);
  // a8 (obj 8): Hidden stamp with an appearance — must be skipped.
  objects[8] = `<< /Type /Annot /Subtype /Stamp /Rect [200 10 260 50] /F 2 /AP << /N 5 0 R >> >>`;
  // a9 (obj 9): stamp with no appearance — must be skipped.
  objects[9] = `<< /Type /Annot /Subtype /Stamp /Rect [200 100 260 140] /F 4 >>`;
  return assemble(objects, 9, 1);
}

/**
 * One page with a markup annotation and the /Popup window bound to it, both
 * carrying an /AP. Mirrors what a real annotating viewer writes:
 *  - a4: /Square markup, /Popup -> a6, /AP /N a5 (green box).
 *  - a6: /Popup, /Parent -> a4, /Open true, /AP /N a7 (the note window).
 * The popup must never be baked; a4 is flattened normally.
 */
export function buildFlattenPopupTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R 6 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Square /Rect [10 20 110 60] /F 4 ` +
    `/Popup 6 0 R /AP << /N 5 0 R >> >>`;
  objects[5] = formXObject(`/BBox [0 0 100 40]`, `q 0 1 0 rg 0 0 100 40 re f Q`);
  objects[6] = `<< /Type /Annot /Subtype /Popup /Rect [110 60 310 160] /F 4 ` +
    `/Parent 4 0 R /Open true /AP << /N 7 0 R >> >>`;
  objects[7] = formXObject(`/BBox [0 0 200 100]`, `q 1 1 0 rg 0 0 200 100 re f Q`);
  return assemble(objects, 7, 1);
}

/**
 * One page with a single checkbox-style widget whose /AP /N is a *state
 * subdictionary*; /AS selects which appearance to bake.
 */
export function buildFlattenStateTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Widget /Rect [10 10 30 30] /F 4 ` +
    `/AS /On /AP << /N << /On 5 0 R /Off 6 0 R >> >> >>`;
  objects[5] = formXObject(`/BBox [0 0 20 20]`, `q 0 1 0 rg 0 0 20 20 re f Q`); // On: green
  objects[6] = formXObject(`/BBox [0 0 20 20]`, `q 1 1 1 rg 0 0 20 20 re f Q`); // Off: white
  return assemble(objects, 6, 1);
}
