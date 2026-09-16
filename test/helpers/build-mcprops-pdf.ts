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

function streamObj(content: string): string {
  return `<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
}

/** One show operation, optionally inside a marked-content sequence. */
export interface McSpec {
  text: string;
  /** Property-list entries; omit to draw outside any BDC. */
  props?: Record<string, string>;
  /** Omit the /MCID, so `MarkedContentEvent` never fires for this sequence. */
  noMcid?: boolean;
  /** A nested BDC drawn inside this one. */
  nested?: { props: Record<string, string>; text: string };
}

/** A one-page document drawing each spec, optionally inside a `/Span` BDC.
 *
 *  Hand-assembled rather than authored, because no authoring API writes an
 *  arbitrary property list — `build-paths-pdf.ts`'s idiom, which is what the
 *  suite uses for a hand-written content stream. */
export function buildMcPropsPdf(specs: McSpec[]): Uint8Array {
  let mcid = 0;
  const parts: string[] = [];
  let y = 700;
  const dict = (p: Record<string, string>, withMcid: boolean): string => {
    const entries = Object.entries(p).map(([k, v]) => `/${k} (${v})`);
    if (withMcid) entries.unshift(`/MCID ${mcid++}`);
    return `<< ${entries.join(' ')} >>`;
  };
  const show = (t: string, at: number): string =>
    `BT /F1 12 Tf 1 0 0 1 72 ${at} Tm (${t}) Tj ET`;
  for (const s of specs) {
    if (s.props === undefined) { parts.push(show(s.text, y)); y -= 20; continue; }
    const inner = s.nested === undefined ? '' :
      `\n/Span ${dict(s.nested.props, true)} BDC\n${show(s.nested.text, y - 20)}\nEMC`;
    parts.push(`/Span ${dict(s.props, s.noMcid !== true)} BDC\n${show(s.text, y)}${inner}\nEMC`);
    y -= s.nested === undefined ? 20 : 40;
  }
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /StructParents 0 >>`;
  objects[4] = streamObj(parts.join('\n'));
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  return assemble(objects, 5, 1);
}
