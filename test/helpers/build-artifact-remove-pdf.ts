// Two pages for artifact REMOVAL (krf2.2), hand-built because each shape is one
// the authoring API never writes:
//
// - both pages share ONE indirect /Resources (object 5), so a prune or a
//   copy-on-write done to it in place would change the other page;
// - page 1's watermark OPENS in one /Contents stream and CLOSES in the next;
// - /Fm1 holds an artifact of its own (a header) beside ordinary ink;
// - /Fm2 has NO /Resources, so it inherits the page's and names /F1 there;
// - page 2 names /F1 nowhere but inside its watermark and through /Fm2.

const enc = (s: string) => new TextEncoder().encode(s);
const len = (s: string) => enc(s).length;
const stream = (content: string, dict = '') => `<< ${dict} /Length ${len(content)} >>\nstream\n${content}\nendstream`;

const WM = '/Artifact <</Type /Pagination /Subtype /Watermark>> BDC';

/** A page artifact whose only content is `/FmX Do`, where /FmX holds an
 *  artifact of its own: selecting both must remove /FmX outright, and editing
 *  the orphaned form must not put its resource entry back. */
export function buildNestedAcrossFormPdf(): Uint8Array {
  const o: string[] = [];
  o[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  o[2] = '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>';
  o[3] = '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /FmX 5 0 R >> >> /Contents 4 0 R >>';
  o[4] = stream('/Artifact <</Type /Page>> BDC /FmX Do EMC 0 0 0 rg 150 150 5 5 re f');
  o[5] = stream('/Artifact <</Type /Layout>> BDC 1 0 0 rg 0 0 20 20 re f EMC',
    '/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << >>');
  return assemble(o);
}

/** Three bare artifacts of exactly equal op length at different places: after
 *  the first is removed, the second's stale address names the THIRD's BMC, so
 *  only the fingerprint (the measured box) can tell them apart. */
export function buildThreeArtifactsPdf(): Uint8Array {
  const o: string[] = [];
  o[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  o[2] = '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>';
  o[3] = '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>';
  o[4] = stream([10, 60, 110].map((x) => `/Artifact BMC 0 0 0 rg ${x} 10 10 10 re f EMC`).join('\n'));
  return assemble(o);
}

/** Four pages for watermark DETECTION (krf2.3). Pages 1-2 draw /Fm0 -- BBox
 *  [0 0 10 5] under /Matrix [1 0 0 1 3 0] -- through `2 0 0 2 10 20 cm`, so
 *  its page box is [16 20 36 30] and only both matrices give that. Pages 3-4
 *  draw /Fm1 inside a TAGGED sequence (`/Figure <</MCID 0>> BDC`), which is
 *  structure content and never a candidate. */
export function buildRepeatedFormsPdf(): Uint8Array {
  const o: string[] = [];
  o[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  o[2] = '<< /Type /Pages /Count 4 /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /MediaBox [0 0 200 200] >>';
  const res = '<< /XObject << /Fm0 7 0 R /Fm1 8 0 R >> >>';
  for (let i = 0; i < 4; i++) o[3 + i] = `<< /Type /Page /Parent 2 0 R /Resources ${res} /Contents ${9 + (i < 2 ? 0 : 1)} 0 R >>`;
  o[7] = stream('0 0 1 rg 0 0 10 5 re f', '/Type /XObject /Subtype /Form /BBox [0 0 10 5] /Matrix [1 0 0 1 3 0]');
  o[8] = stream('1 0 0 rg 0 0 10 5 re f', '/Type /XObject /Subtype /Form /BBox [0 0 10 5]');
  o[9] = stream('q 2 0 0 2 10 20 cm /Fm0 Do Q');
  o[10] = stream('/Figure <</MCID 0>> BDC /Fm1 Do EMC');
  return assemble(o);
}

function assemble(o: string[]): Uint8Array {
  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (let n = 1; n < o.length; n++) { offsets[n] = len(body); body += `${n} 0 obj\n${o[n]}\nendobj\n`; }
  const xref = len(body);
  body += `xref\n0 ${o.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < o.length; n++) body += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${o.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc(body);
}

export function buildArtifactRemovePdf(): Uint8Array {
  const o: string[] = [];
  o[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  o[2] = '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 200 200] >>';
  o[3] = '<< /Type /Page /Parent 2 0 R /Resources 5 0 R /Contents [10 0 R 11 0 R] >>';
  o[4] = '<< /Type /Page /Parent 2 0 R /Resources 5 0 R /Contents 12 0 R >>';
  o[5] = '<< /XObject << /Fm0 6 0 R /Fm1 7 0 R /Fm2 8 0 R >> /ExtGState << /GS0 << /ca 0.5 >> >> /Font << /F1 9 0 R >> >>';
  o[6] = stream('0 0 1 rg 0 0 50 50 re f', '/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << >>');
  o[7] = stream('/Artifact <</Type /Pagination /Subtype /Header>> BDC 1 0 0 rg 0 180 200 20 re f EMC 0 1 0 rg 0 0 10 10 re f',
    '/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << >>');
  o[8] = stream('BT /F1 12 Tf 10 100 Td (keep) Tj ET', '/Type /XObject /Subtype /Form /BBox [0 0 200 200]');
  o[9] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  o[10] = stream(`${WM} /GS0 gs /Fm0 Do BT /F1 30 Tf 20 20 Td (WM) Tj ET`);
  o[11] = stream('EMC /Fm1 Do /Fm2 Do BT /F1 10 Tf 10 150 Td (body) Tj ET');
  o[12] = stream(`${WM} /GS0 gs /Fm0 Do BT /F1 30 Tf 20 20 Td (WM) Tj ET EMC /Fm1 Do /Fm2 Do`);
  return assemble(o);
}
