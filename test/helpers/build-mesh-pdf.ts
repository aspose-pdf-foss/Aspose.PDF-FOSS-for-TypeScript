// Mesh-shading RENDER fixtures (4gtd.4). Distinct from build-grayscale-pdf.ts's
// buildGrayscaleMeshPdf, which exists for ConvertColors and whose shape is fixed
// by that feature's needs — a render test written against it would break
// confusingly the day colour conversion wants a different mesh.
//
// A 200x200 page, one `sh` over the whole of it, 16-bit coordinates decoded
// 0..200 so a vertex's PDF coordinate is its device x and 200 - y.

const enc = (s: string) => new TextEncoder().encode(s);

export interface MeshVertex {
  /** Type 4 edge flag: 0 starts a triangle, 1 and 2 continue the previous one. */
  flag?: number;
  x: number;
  y: number;
  /** Colour components, or the single parametric value when `fn` is given. */
  comps: number[];
}

/** One patch record, exactly as the stream states it: a flag of 0 carries all
 *  12 (type 6) or 16 (type 7) points and 4 colours; 1, 2 and 3 carry four
 *  points and two colours fewer, the rest coming from the previous patch. */
export interface MeshPatch {
  flag?: number;
  /** `[x, y]` pairs in stream order. */
  points: [number, number][];
  /** Colour components per corner, or one parametric value each when `fn` is given. */
  colors: number[][];
}

export interface MeshOpts {
  type: 4 | 5 | 6 | 7;
  /** Types 4 and 5. */
  vertices?: MeshVertex[];
  /** Types 6 and 7. */
  patches?: MeshPatch[];
  /** Type 5 only. */
  verticesPerRow?: number;
  /** `/ColorSpace`. Default DeviceRGB. */
  colorSpace?: string;
  /** A `/Function` object body; when given, each vertex carries ONE component. */
  fn?: string;
  /** Override the `/ShadingType` the dict DECLARES while keeping this packing.
   *  For asserting that a type we do not draw still degrades — patching the
   *  bytes of a built file instead would have to round-trip binary vertex data
   *  through a text decoder, which is lossy and silently corrupts the stream. */
  declaredType?: number;
}

/** Pack the record stream: flag(8) + coordinates(16 each) + comps(8 each).
 *  Every field is byte-aligned, so the per-record padding 32000-1 8.7.4.5.5
 *  calls for is a no-op here and stays that way. */
function packRecords(o: MeshOpts): Uint8Array {
  const out: number[] = [];
  const q = (v: number) => {                    // 0..200 -> 16-bit
    const n = Math.max(0, Math.min(65535, Math.round((v / 200) * 65535)));
    out.push((n >> 8) & 0xff, n & 0xff);
  };
  const comp = (c: number) => out.push(Math.max(0, Math.min(255, Math.round(c * 255))));

  if (o.type === 6 || o.type === 7) {
    for (const p of o.patches ?? []) {
      out.push(p.flag ?? 0);
      for (const [x, y] of p.points) { q(x); q(y); }
      for (const c of p.colors) for (const v of c) comp(v);
    }
    return Uint8Array.from(out);
  }
  for (const v of o.vertices ?? []) {
    if (o.type === 4) out.push(v.flag ?? 0);
    q(v.x); q(v.y);
    for (const c of v.comps) comp(c);
  }
  return Uint8Array.from(out);
}

export function buildMeshPdf(o: MeshOpts): Uint8Array {
  const data = packRecords(o);
  const nComps = o.fn ? 1
    : (o.vertices?.[0]?.comps.length ?? o.patches?.[0]?.colors[0]?.length ?? 3);
  const colorDecode = Array.from({ length: nComps }, () => '0 1').join(' ');
  const cs = o.colorSpace ?? '/DeviceRGB';

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Shading << /Sh0 5 0 R >> >> /Contents 4 0 R >>`;
  const content = 'q 0 0 200 200 re W n /Sh0 sh Q';
  objects[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objects[5] = `<< /ShadingType ${o.declaredType ?? o.type} /ColorSpace ${cs}`
    + ` /BitsPerCoordinate 16 /BitsPerComponent 8`
    + (o.type === 5 ? ` /VerticesPerRow ${o.verticesPerRow ?? 2}` : ' /BitsPerFlag 8')
    + ` /Decode [0 200 0 200 ${colorDecode}]`
    + (o.fn ? ' /Function 6 0 R' : '')
    + ` /Length ${data.length} >>`;
  if (o.fn) objects[6] = o.fn;
  const maxObj = o.fn ? 6 : 5;

  // Binary vertex data cannot go through the UTF-8 encoder, so the file is
  // assembled as byte chunks and only the object syntax is text.
  const chunks: Uint8Array[] = [];
  let len = 0;
  const push = (b: Uint8Array) => { chunks.push(b); len += b.length; };
  const offsets: number[] = new Array(maxObj + 1).fill(0);

  push(enc('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'));
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = len;
    if (n === 5) {
      push(enc(`5 0 obj\n${objects[5]}\nstream\n`));
      push(data);
      push(enc('\nendstream\nendobj\n'));
    } else {
      push(enc(`${n} 0 obj\n${objects[n]}\nendobj\n`));
    }
  }
  const xrefOffset = len;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(enc(xref + `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));

  const out = new Uint8Array(len);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
