// Hand-built pages whose content carries /Artifact marked-content scopes, for
// `page.Artifacts`. Raw content streams rather than the authoring API, because
// `wrapArtifact` emits a BARE `/Artifact BMC` with no property list at all —
// so nothing this library writes can exercise a declared /Type, /Subtype,
// /Attached or /BBox.

const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

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

function streamObj(content: string): string {
  return `<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
}

/** One page, one content stream, MediaBox 0 0 200 200. */
function onePage(content: string, extraResources = '', extraObjects: string[] = []): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << ${extraResources} >> /Contents 4 0 R >>`;
  objects[4] = streamObj(content);
  let n = 4;
  for (const o of extraObjects) objects[++n] = o;
  return assemble(objects, n, 1);
}

/** A pagination artifact declaring every modelled key, a bare `/Artifact BMC`
 *  whose extent can only be measured, and a tagged (non-artifact) sequence that
 *  must not be reported. */
export function buildArtifactsPdf(): Uint8Array {
  const content = [
    // /Attached carries a name that is not an edge beside one that is: an
    // unfiltered read would report it and put a non-ArtifactEdge past the type.
    '/Artifact << /Type /Pagination /Subtype /Header /Attached [/Top /Sideways] /BBox [10 170 190 190] >> BDC',
    '0 0 0 rg 20 175 100 10 re f',
    'EMC',
    '/Artifact BMC 1 0 0 rg 40 40 20 30 re f EMC',
    '/Span << /MCID 0 >> BDC 0 0 1 rg 10 10 5 5 re f EMC',
  ].join('\n');
  return onePage(content);
}

/** The property list reached by NAME through /Resources /Properties, which is
 *  the other half of the BDC operand grammar. */
export function buildNamedArtifactPdf(): Uint8Array {
  const content = '/Artifact /A0 BDC 0 0 0 rg 20 20 10 10 re f EMC';
  return onePage(content, '/Properties << /A0 << /Type /Layout /BBox [0 0 50 50] >> >>');
}

/** A /BBox written corner-to-corner the other way round — legal, and what some
 *  producers emit. */
export function buildReversedBBoxArtifactPdf(): Uint8Array {
  return onePage('/Artifact << /BBox [80 90 20 30] >> BDC 0 0 0 rg 21 31 1 1 re f EMC');
}

/** An artifact opened inside an artifact: two records, the inner naming the
 *  outer as its parent. The inner ink sits outside the outer's own ink, so the
 *  outer's measured extent can only be right if it unions its child in. */
export function buildNestedArtifactPdf(): Uint8Array {
  const content = [
    '/Artifact << /Type /Page >> BDC',
    '0 0 0 rg 10 10 20 20 re f',
    '/Artifact << /Type /Layout >> BDC 1 0 0 rg 100 100 20 20 re f EMC',
    'EMC',
  ].join('\n');
  return onePage(content);
}

/** An artifact opened INSIDE a Form XObject, drawn under a 2x scale and a
 *  (100,100) translate: the record's addr names the XObject chain and its
 *  measured extent is in page space. */
export function buildFormArtifactPdf(): Uint8Array {
  const form = '/Artifact BMC 0 0 1 rg 0 0 20 20 re f EMC';
  return onePage(
    'q 2 0 0 2 100 100 cm /Fm0 Do Q',
    '/XObject << /Fm0 5 0 R >>',
    [`<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length ${byteLen(form)} >>\nstream\n${form}\nendstream`],
  );
}

/** An artifact opened on the PAGE whose only ink is drawn inside a form it
 *  invokes — the inherited-scope direction, and the one that fails when the
 *  extent is measured per stream rather than per scope. */
export function buildArtifactAroundFormPdf(): Uint8Array {
  const form = '0 0 1 rg 0 0 20 20 re f';
  return onePage(
    '/Artifact BMC q 2 0 0 2 100 100 cm /Fm0 Do Q EMC',
    '/XObject << /Fm0 5 0 R >>',
    [`<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length ${byteLen(form)} >>\nstream\n${form}\nendstream`],
  );
}

/** A page artifact and a form artifact that sit at the SAME stream index and op
 *  index, so their addresses differ only by the XObject chain. The page scope
 *  draws AFTER the form registers, so a scope key blind to the path attributes
 *  that ink to the wrong artifact. */
export function buildCollidingArtifactPdf(): Uint8Array {
  const form = '/Artifact BMC 0 0 1 rg 0 0 20 20 re f EMC';
  return onePage(
    '/Artifact BMC q 1 0 0 1 100 100 cm /Fm0 Do Q 0 0 0 rg 5 5 5 5 re f EMC',
    '/XObject << /Fm0 5 0 R >>',
    [`<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length ${byteLen(form)} >>\nstream\n${form}\nendstream`],
  );
}

/** An artifact enclosing an image and one enclosing text: the two ink kinds no
 *  path fixture can reach. Helvetica 12pt at (100,700); a 1x1 inline image
 *  placed by `20 0 0 10 150 20 cm`. */
export function buildInkArtifactsPdf(): Uint8Array {
  const content = [
    '/Artifact BMC q 20 0 0 10 150 20 cm BI /W 1 /H 1 /CS /G /BPC 8 ID A EI Q EMC',
    '/Artifact BMC BT /F0 12 Tf 100 700 Td (Hi) Tj ET EMC',
  ].join('\n');
  return onePage(
    content,
    '/Font << /F0 5 0 R >>',
    ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
  );
}

/** An artifact scope enclosing no ink at all, beside one that draws. */
export function buildEmptyArtifactPdf(): Uint8Array {
  return onePage('/Artifact << /Type /Layout >> BDC EMC\n/Artifact BMC 0 0 0 rg 1 2 3 4 re f EMC');
}

/** An `/Artifact BMC` never closed: damaged content that must still report. */
export function buildUnbalancedArtifactPdf(): Uint8Array {
  return onePage('/Artifact BMC 0 0 0 rg 10 10 20 20 re f');
}
