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

/** A page drawing: a filled-RGB rectangle, a stroked-CMYK line, a filled+stroked
 *  bezier via `B`, an even-odd clip, and a `v`/`y` curve. MediaBox 0 0 200 200. */
export function buildPathsPdf(): Uint8Array {
  const content = [
    // filled red rectangle (DeviceRGB), 10 10 -> 60 40
    '1 0 0 rg 10 10 50 30 re f',
    // stroked line (DeviceCMYK cyan), width 4
    '1 0 0 0 K 4 w 10 100 m 90 120 l S',
    // fill+stroke bezier with B (nonzero), green fill / black stroke
    '0 1 0 rg 0 0 0 RG 2 w 100 100 m 120 180 160 180 180 100 c B',
    // even-odd clip rectangle then n (clip-only)
    '20 20 40 40 re W* n',
    // v and y curves in their own subpath, stroked
    '10 150 m 10 160 30 160 v 50 160 30 150 y S',
  ].join('\n');
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R >>`;
  objects[4] = streamObj(content);
  return assemble(objects, 4, 1);
}

/** A page whose /Resources define a Separation "Spot" colorspace (tint -> CMYK),
 *  used to fill a rectangle at tint 1.0. MediaBox 0 0 100 100. */
export function buildSeparationPathPdf(): Uint8Array {
  const content = '/CS0 cs 1 scn 10 10 50 50 re f';
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 100 100] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /ColorSpace << /CS0 5 0 R >> >> /Contents 4 0 R >>`;
  objects[4] = streamObj(content);
  // Separation: tint 1.0 -> CMYK [0 1 1 0] -> cmykToRgb = red.
  objects[5] = `[ /Separation /Spot /DeviceCMYK 6 0 R ]`;
  objects[6] = `<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 1 1 0] /N 1 >>`;
  return assemble(objects, 6, 1);
}

/** A page that draws a Form XObject (named /Fm0) under a 2x scale + (100,100)
 *  translate. The form fills a 0 0 20 20 rectangle in blue. So in device space
 *  the rectangle is [100,100,140,140]. MediaBox 0 0 200 200. */
export function buildXObjectPathPdf(): Uint8Array {
  const page = 'q 2 0 0 2 100 100 cm /Fm0 Do Q';
  const form = '0 0 1 rg 0 0 20 20 re f';
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm0 5 0 R >> >> /Contents 4 0 R >>`;
  objects[4] = streamObj(page);
  objects[5] = `<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length ${byteLen(form)} >>\nstream\n${form}\nendstream`;
  return assemble(objects, 5, 1);
}

/** A page with a path inside a tagged marked-content sequence (MCID 3, via a
 *  named property) and a second path inside an /Artifact scope. MediaBox 0 0 100 100. */
export function buildTaggedPathPdf(): Uint8Array {
  const content = [
    '/Span /P0 BDC 0 0 0 rg 10 10 20 20 re f EMC',
    '/Artifact BMC 1 0 0 rg 40 40 20 20 re f EMC',
  ].join('\n');
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 100 100] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Properties << /P0 << /MCID 3 >> >> >> /Contents 4 0 R >>`;
  objects[4] = streamObj(content);
  return assemble(objects, 4, 1);
}
