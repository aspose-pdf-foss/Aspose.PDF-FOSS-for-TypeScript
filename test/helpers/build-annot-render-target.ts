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
 * One 200x200 page of render-only annotation edge cases. Every annotation sits
 * in the y range [10 30] so a single device row (y=180) probes them all.
 *
 *  - obj 4:  /Popup at x [10 30] with a usable /AP (obj 5, green) — a viewer
 *            draws popups only when open, so a static render must skip it.
 *  - obj 6:  NoView (/F 32) stamp at x [40 60] sharing that /AP — skipped.
 *  - obj 7:  widget at x [70 90] whose /AS names a state absent from the /N
 *            subdict — no usable appearance.
 *  - obj 8:  stamp at x [100 120] whose /AP /N stream (obj 9) has no /BBox —
 *            unplaceable.
 *  - obj 12: stamp at x [160 180] whose /AP /N (obj 13) declares /FlateDecode
 *            over non-deflate bytes — inflating it throws inside drawForm.
 *  - obj 10: a well-formed BLUE stamp at x [130 150], listed in /Annots AFTER
 *            the throwing one, proving a malformed appearance does not suppress
 *            the annotations that follow it.
 */
export function buildAnnotRenderTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R 6 0 R 7 0 R 8 0 R 12 0 R 10 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Popup /Rect [10 10 30 30] /F 4 /AP << /N 5 0 R >> >>`;
  objects[5] = formXObject(`/BBox [0 0 20 20]`, `q 0 1 0 rg 0 0 20 20 re f Q`);  // green
  objects[6] = `<< /Type /Annot /Subtype /Stamp /Rect [40 10 60 30] /F 32 /AP << /N 5 0 R >> >>`;
  objects[7] = `<< /Type /Annot /Subtype /Widget /Rect [70 10 90 30] /F 4 ` +
    `/AS /Missing /AP << /N << /On 5 0 R >> >> >>`;
  objects[8] = `<< /Type /Annot /Subtype /Stamp /Rect [100 10 120 30] /F 4 /AP << /N 9 0 R >> >>`;
  objects[9] = formXObject(``, `q 0 1 0 rg 0 0 20 20 re f Q`);                   // no /BBox
  objects[10] = `<< /Type /Annot /Subtype /Stamp /Rect [130 10 150 30] /F 4 /AP << /N 11 0 R >> >>`;
  objects[11] = formXObject(`/BBox [0 0 20 20]`, `q 0 0 1 rg 0 0 20 20 re f Q`); // blue
  objects[12] = `<< /Type /Annot /Subtype /Stamp /Rect [160 10 180 30] /F 4 /AP << /N 13 0 R >> >>`;
  objects[13] = formXObject(`/BBox [0 0 20 20] /Filter /FlateDecode`, `not-deflate-data`);
  return assemble(objects, 13, 1);
}
