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

/** A PDF whose /Names /EmbeddedFiles is a NESTED tree (intermediate /Kids node →
 *  leaf /Names) carrying one raw (uncompressed) attachment "readme.txt". */
export function buildEmbeddedFileTarget(): Uint8Array {
  const content = 'hello attachment'; // 16 bytes
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles 6 0 R >> >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R >>`;
  objects[4] = `<< /Type /EmbeddedFile /Params << /Size ${byteLen(content)} >> /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
  objects[5] = `<< /Type /Filespec /F (readme.txt) /UF (readme.txt) /Desc (A readme) /EF << /F 4 0 R /UF 4 0 R >> >>`;
  objects[6] = `<< /Kids [7 0 R] >>`;
  objects[7] = `<< /Names [(readme.txt) 5 0 R] >>`;
  return assemble(objects, 7, 1);
}
