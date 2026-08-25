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

/** One page carrying two existing annotations: a /Text note and a /Link. */
export function buildAnnotTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R 5 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Text /Rect [10 20 30 40] /Contents (hello) /C [1 0 0] /F 4 >>`;
  objects[5] = `<< /Type /Annot /Subtype /Link /Rect [50 60 200 80] >>`;
  return assemble(objects, 5, 1);
}

/** One page carrying a single existing /Stamp annotation (standard name). */
export function buildStampReadTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Stamp /Rect [10 20 110 60] /Name /Approved /F 4 >>`;
  return assemble(objects, 4, 1);
}

/** One page carrying a single existing /Highlight markup annotation. */
export function buildMarkupReadTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Highlight /Rect [10 30 60 40] ` +
    `/QuadPoints [10 40 60 40 10 30 60 30] /C [1 1 0] /F 4 >>`;
  return assemble(objects, 4, 1);
}

/** Two pages; page 1 carries a URI link and a GoTo-to-page-2 link. */
export function buildLinkReadTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 2 /Kids [3 0 R 6 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R 5 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Link /Rect [10 10 100 30] ` +
    `/A << /S /URI /URI (https://example.com) >> >>`;
  objects[5] = `<< /Type /Annot /Subtype /Link /Rect [10 40 100 60] ` +
    `/A << /S /GoTo /D [6 0 R /Fit] >> >>`;
  objects[6] = `<< /Type /Page /Parent 2 0 R >>`;
  return assemble(objects, 6, 1);
}

/** One page with no /Annots entry. */
export function buildBlankPage(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R >>`;
  return assemble(objects, 3, 1);
}

/** One page carrying a /FreeText annotation with DA, Q, IC, BS, CL, LE, IT. */
export function buildFreeTextReadTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /FreeText /Rect [20 20 160 90] ` +
    `/Contents (note) /DA (/Helv 14 Tf 1 0 0 rg) /Q 1 /IC [0.9 0.9 0.9] ` +
    `/BS << /Type /Border /W 2 >> /IT /FreeTextCallout ` +
    `/CL [30 30 60 60 100 80] /LE /OpenArrow /F 4 >>`;
  return assemble(objects, 4, 1);
}

/** One page carrying a /Text markup and its linked /Popup companion. */
export function buildPopupReadTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R 5 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Text /Rect [10 20 30 40] /Contents (hi) /Popup 5 0 R /F 4 >>`;
  objects[5] = `<< /Type /Annot /Subtype /Popup /Rect [40 20 240 120] /Parent 4 0 R /Open true >>`;
  return assemble(objects, 5, 1);
}

/** One page carrying /Square (with /IC + /BS), /Circle (no /IC), and /Line. */
export function buildShapeReadTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R 5 0 R 6 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Square /Rect [10 10 90 60] ` +
    `/C [0 0 1] /IC [1 1 0] /BS << /Type /Border /W 2 >> /F 4 >>`;
  objects[5] = `<< /Type /Annot /Subtype /Circle /Rect [100 10 180 60] /C [1 0 0] /F 4 >>`;
  objects[6] = `<< /Type /Annot /Subtype /Line /Rect [10 100 190 140] ` +
    `/L [20 110 180 130] /LE [/None /OpenArrow] /C [0 0 0] /F 4 >>`;
  return assemble(objects, 6, 1);
}

/** One page carrying /Polygon (with /IC + /BS), /PolyLine (with /LE), and a
 *  multi-stroke /Ink. */
export function buildPathReadTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R 5 0 R 6 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Polygon /Rect [10 10 90 60] ` +
    `/Vertices [10 10 90 10 50 60] /C [0 0 1] /IC [1 1 0] /BS << /Type /Border /W 2 >> /F 4 >>`;
  objects[5] = `<< /Type /Annot /Subtype /PolyLine /Rect [10 100 90 160] ` +
    `/Vertices [10 100 90 100 90 160] /LE [/None /OpenArrow] /C [0 0 0] /F 4 >>`;
  objects[6] = `<< /Type /Annot /Subtype /Ink /Rect [10 10 80 50] ` +
    `/InkList [[10 10 40 40] [50 50 80 20]] /C [1 0 0] /F 4 >>`;
  return assemble(objects, 6, 1);
}
