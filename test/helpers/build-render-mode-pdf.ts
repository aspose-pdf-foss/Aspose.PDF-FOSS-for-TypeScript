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

/** One show operation on the page. */
export interface ShowSpec {
  text: string;
  /** /Tr to set before showing; omitted leaves the mode as it stands. */
  mode?: number;
  /** Wrap the Tr and the show in `q` … `Q`, so the mode must be restored. */
  wrapInQ?: boolean;
}

/** A one-page document whose content stream shows each spec in turn in /F1.
 *
 *  Hand-assembled rather than authored through `AddText`, because `AddText`
 *  emits no `/Tr` at all and there is no authoring option for one — the render
 *  mode is a rendering concern this library writes only through PageGraphics.
 *  The plan named `Page.AppendContent` and `build-multi-stream-page.ts`; NEITHER
 *  EXISTS, so this follows `build-paths-pdf.ts`'s idiom, which is what the rest
 *  of the suite uses for a hand-written content stream. */
export function buildRenderModePdf(specs: ShowSpec[]): Uint8Array {
  const esc = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const parts: string[] = [];
  let y = 700;
  for (const s of specs) {
    const body = [
      s.mode === undefined ? '' : `${s.mode} Tr`,
      'BT /F1 12 Tf',
      `1 0 0 1 72 ${y} Tm`,
      `(${esc(s.text)}) Tj`,
      'ET',
    ].filter((l) => l !== '').join('\n');
    parts.push(s.wrapInQ === true ? `q\n${body}\nQ` : body);
    y -= 20;
  }
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`;
  objects[4] = streamObj(parts.join('\n'));
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  return assemble(objects, 5, 1);
}
