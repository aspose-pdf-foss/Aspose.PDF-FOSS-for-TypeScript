const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

interface Obj { [n: number]: string }

/** Serialize numbered objects (1..maxObj) into a classic-xref PDF. */
function serialize(objects: Obj, maxObj: number): Uint8Array {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    if (!objects[n]) continue;
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

function contentObj(stream: string, extra = ''): string {
  return `<< /Length ${byteLen(stream)} ${extra}>>\nstream\n${stream}\nendstream`;
}

/** An appearance stream: a Form XObject sharing the page's /F1 font. */
function apObj(bbox: string, body: string, extra = ''): string {
  return contentObj(body, `/Type /XObject /Subtype /Form /BBox [${bbox}] ` +
    `/Resources << /Font << /F1 5 0 R >> >> ${extra}`);
}

/** Draw `word` at (2, 5) inside an appearance stream, 10pt Helvetica. */
const draw = (word: string) => `BT /F1 10 Tf 2 5 Td (${word}) Tj ET`;

/**
 * One 300x300 page carrying page text "alpha" at baseline y=100 plus six
 * annotations. See docs/superpowers/plans/2026-08-17-annotation-appearance-search.md
 * for the full geometry map and why each case is shaped as it is.
 *
 * "bravo" deliberately shares baseline y=100 with the page's "alpha": a shared
 * layoutLines assembly would splice them into the single line "alpha bravo",
 * which is the phantom match the per-annotation assembly exists to prevent.
 */
export function buildAnnotTextPdf(): Uint8Array {
  const objects: Obj = {
    // The widget below is a merged field/widget dict, so it is its own terminal
    // field and belongs in /AcroForm /Fields. Without the form, removeField
    // finds no field tree and redaction leaves the widget in place — a real
    // enough shape, but a malformed one, and not what this fixture is for.
    1: `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [8 0 R] >> >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> ` +
       `/Contents 4 0 R /Annots [6 0 R 8 0 R 10 0 R 12 0 R 14 0 R 16 0 R] >>`,
    4: contentObj('BT /F1 10 Tf 20 100 Td (alpha) Tj ET'),
    5: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,

    // Shares the page text's baseline — the interleaving case.
    6: `<< /Type /Annot /Subtype /FreeText /Rect [120 95 220 115] /AP << /N 7 0 R >> >>`,
    7: apObj('0 0 100 20', draw('bravo')),

    // A filled form field: its value is drawn only in the appearance.
    8: `<< /Type /Annot /Subtype /Widget /FT /Tx /T (f1) /V (charlie) ` +
       `/Rect [20 200 220 220] /AP << /N 9 0 R >> >>`,
    9: apObj('0 0 200 20', draw('charlie')),

    // /F 2 = Hidden.
    10: `<< /Type /Annot /Subtype /FreeText /F 2 /Rect [20 250 220 270] /AP << /N 11 0 R >> >>`,
    11: apObj('0 0 200 20', draw('delta')),

    12: `<< /Type /Annot /Subtype /Popup /Rect [20 30 220 50] /AP << /N 13 0 R >> >>`,
    13: apObj('0 0 200 20', draw('echo')),

    // Unknown filter: decodeStream throws UnsupportedFeatureError on this one.
    // Placed BEFORE "golf" so that degradation is observable.
    14: `<< /Type /Annot /Subtype /FreeText /Rect [20 150 220 170] /AP << /N 15 0 R >> >>`,
    15: apObj('0 0 200 20', draw('foxtrot'), '/Filter /NotAFilter '),

    // /Matrix must be re-applied on top of the placement matrix.
    16: `<< /Type /Annot /Subtype /FreeText /Rect [20 60 120 80] /AP << /N 17 0 R >> >>`,
    17: apObj('0 0 100 20', draw('golf'), '/Matrix [1 0 0 1 500 500] '),
  };
  return serialize(objects, 17);
}
