// Optional-content RENDERING fixtures (q1g2.1). Distinct from build-ocg-pdf.ts,
// which exercises the OCG *API* — this one is built for pixels: a 200x200 page,
// two layers whose state the /D config fixes (Visible ON, Hidden OFF), and a
// caller-supplied content stream so each case writes exactly the marked content
// it means to test.
//
// The page resources name both layers in /Properties (/OCVis, /OCHid) and carry
// a form XObject (/Fm0, green), an image XObject (/Im0, magenta) and — when
// annotOc is given — a /Square annotation whose /AP paints cyan. Each of the
// three can be given an /OC of its own (q1g2.2); none has one by default, so
// the q1g2.1 cases that only mark content in the stream are unaffected.

const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** The form's own ink: a 40x40 green square at the origin of its BBox. */
const FORM_INK = '0 1 0 rg 0 0 40 40 re f\n';

/** The tiling pattern's own ink: a red 20x20 tile. */
const TILE_INK = '1 0 0 rg 0 0 20 20 re f\n';

/** The page's own `/Properties`. */
const PAGE_PROPS = '/Properties << /OCVis 6 0 R /OCHid 7 0 R >>';

/**
 * A NESTED scope's own `/Properties`, under keys the PAGE's does not carry.
 *
 * Deliberate: with the same key names, a walk that reached the stream but
 * resolved its BDC operands against the PAGE's resources gets the right answer
 * by accident, so the fixture could not tell a scope's own resources from its
 * parent's. Distinct names make the wrong lookup fail to resolve, which leaves
 * the section standing and the hidden ink visible.
 */
const nestedProps = (prefix: string) =>
  `/Properties << /${prefix}Vis 6 0 R /${prefix}Hid 7 0 R >>`;

/** `ink` wrapped in an `/OC` marked-content section, or left alone. */
const marked = (ink: string, oc: string | undefined) =>
  (oc ? `/OC /${oc} BDC\n${ink}EMC\n` : ink);

export interface OcgRenderOpts {
  /** `/OC` written on the form XObject `/Fm0` — `7 0 R` is the Hidden layer. */
  formOc?: string;
  /** `/OC` written on the image XObject `/Im0`. */
  imageOc?: string;
  /** Add a `/Square` annotation with this `/OC` and an `/AP` that paints. */
  annotOc?: string;
  // The five NESTED content scopes (`q1g2.6`). Each wraps that scope's own ink
  // in `/OC /<Prefix><Vis|Hid> BDC … EMC` and gives the scope its own
  // `/Properties` under keys the page does not carry — see `nestedProps`. An
  // `/OC` in any of them is honoured at render time, so a document-wide walk
  // that misses one leaves hidden ink to become visible the moment
  // `/OCProperties` goes.
  /** `/AP /N` appearance stream (needs `annotOc` too). Cyan 40x40. */
  apOc?: 'ApVis' | 'ApHid';
  /** The form XObject `/Fm0`'s own content. Green 40x40, drawn by `/Fm0 Do`.
   *  Distinct from `formOc`, which layers the whole XObject through its dict. */
  formOcSection?: 'FmVis' | 'FmHid';
  /** A tiling pattern `/P0`, a red 20x20 tile, reached with
   *  `/Pattern cs /P0 scn`. */
  patternOc?: 'PatVis' | 'PatHid';
  /** A Type 3 font `/T3` whose one glyph (code 97) is a green 40x40 square,
   *  drawn with `BT /T3 1 Tf x y Td (a) Tj ET`. */
  charProcOc?: 'T3Vis' | 'T3Hid';
  /** An ExtGState `/GS0` carrying a luminosity soft mask whose group paints
   *  white over the whole page. Reached with `/GS0 gs`: with the section
   *  hidden the group paints nothing, the mask is black and what follows is
   *  masked away entirely. */
  smaskOc?: 'SmVis' | 'SmHid';
  /** A SECOND page content stream, so `/Contents` is an array of two.
   *
   *  32000-1 7.8.2: the concatenation is interpreted as a single stream, so a
   *  `BDC` in the first member and its `EMC` in the second is a legal page —
   *  which is the shape a per-stream walk gets wrong. `Page.Contents` joins
   *  them, so the renderer already reads it that way. */
  content2?: string;
  /** `/D /BaseState`. Default 'ON', so only `/OFF` hides. */
  baseState?: 'ON' | 'OFF';
  /** Refs put in `/D /ON`. Default none. */
  on?: number[];
  /** Refs put in `/D /OFF`. Default `[7]` — the Hidden layer. */
  off?: number[];
  /** Omit `/OCProperties` from the catalog entirely. */
  noOcProperties?: boolean;
  /** Add a `/StructTreeRoot` with one `/P` per MCID listed, all on this page,
   *  so the TAGGED extraction path (`StructElement.Nodes`, and every export
   *  built on it) can be driven. The content stream must open the matching
   *  `/P << /MCID n >> BDC` sequences itself. */
  mcids?: number[];
  /** Structure type per entry in `mcids`, default `/P`. `/Figure` is what the
   *  tagged export path needs to resolve an image through its MCID. */
  structTypes?: string[];
}

/** One-page PDF with a Visible and a Hidden layer and the given content. */
export function buildOcgRenderPdf(content: string, opts: OcgRenderOpts = {}): Uint8Array {
  const refs = (ns: number[]) => ns.map((n) => `${n} 0 R`).join(' ');
  const on = opts.on ?? [];
  const off = opts.off ?? [7];

  // The optional nested scopes take object numbers past the /StructTreeRoot
  // block, allocated in order, so every option stays independent of the others.
  const mcidCount = opts.mcids?.length ?? 0;
  let nextObj = mcidCount ? 17 + mcidCount : 15;
  const alloc = (want: unknown) => (want ? nextObj++ : 0);
  const patternObj = alloc(opts.patternOc);
  const t3FontObj = alloc(opts.charProcOc);
  const t3ProcObj = alloc(opts.charProcOc);
  const smaskObj = alloc(opts.smaskOc);
  const content2Obj = alloc(opts.content2 !== undefined);

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R${opts.noOcProperties ? '' : ' /OCProperties 5 0 R'}`
    + `${opts.mcids ? ' /StructTreeRoot 15 0 R' : ''} >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << ${PAGE_PROPS} /XObject << /Fm0 8 0 R /Im0 10 0 R >> /Font << /F1 14 0 R${t3FontObj ? ` /T3 ${t3FontObj} 0 R` : ''} >>${patternObj ? ` /Pattern << /P0 ${patternObj} 0 R >>` : ''}${smaskObj ? ` /ExtGState << /GS0 << /Type /ExtGState /SMask << /S /Luminosity /G ${smaskObj} 0 R >> >> >>` : ''} >> /Contents ${content2Obj ? `[4 0 R ${content2Obj} 0 R]` : '4 0 R'}${opts.mcids ? ' /StructParents 0' : ''}${opts.annotOc ? ' /Annots [13 0 R]' : ''} >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /OCGs [6 0 R 7 0 R] /D 9 0 R >>`;
  objects[6] = `<< /Type /OCG /Name (Visible) >>`;
  objects[7] = `<< /Type /OCG /Name (Hidden) >>`;
  const FORM = marked(FORM_INK, opts.formOcSection);
  objects[8] = `<< /Type /XObject /Subtype /Form /BBox [0 0 40 40]`
    + `${opts.formOc ? ` /OC ${opts.formOc}` : ''}`
    + `${opts.formOcSection ? ` /Resources << ${nestedProps('Fm')} >>` : ''}`
    + ` /Length ${byteLen(FORM)} >>\nstream\n${FORM}endstream`;
  objects[9] = `<< /Name (Default) /BaseState /${opts.baseState ?? 'ON'}`
    + `${on.length ? ` /ON [${refs(on)}]` : ''}`
    + `${off.length ? ` /OFF [${refs(off)}]` : ''}`
    + ` /Order [6 0 R 7 0 R] >>`;
  // 10: a 1x1 magenta image, scaled by the content stream's own `cm`.
  // ASCIIHex rather than raw bytes: this whole file is UTF-8 encoded at the end,
  // so a literal 0xFF would come out as two bytes and /Length would be a lie.
  const IMG = 'FF00FF>';
  objects[10] = `<< /Type /XObject /Subtype /Image /Width 1 /Height 1`
    + ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode`
    + `${opts.imageOc ? ` /OC ${opts.imageOc}` : ''} /Length ${IMG.length} >>\nstream\n${IMG}\nendstream`;
  // 11: the annotation's appearance — a 40x40 cyan square PLUS the word
  // `secretword` at its bottom-left, so ONE fixture serves both the pixel cases
  // and SearchAnnotations. The text sits well clear of the centre probe.
  const AP_INK = '0 1 1 rg 0 0 40 40 re f\nBT /F1 8 Tf 2 3 Td (secretword) Tj ET\n';
  const AP = marked(AP_INK, opts.apOc);
  objects[11] = `<< /Type /XObject /Subtype /Form /BBox [0 0 40 40]`
    + ` /Resources << /Font << /F1 14 0 R >>`
    + `${opts.apOc ? ` ${nestedProps('Ap')}` : ''} >>`
    + ` /Length ${byteLen(AP)} >>\nstream\n${AP}endstream`;
  objects[12] = `<< /Type /OCMD /OCGs [7 0 R] >>`;
  objects[13] = `<< /Type /Annot /Subtype /Square /Rect [120 10 160 50]`
    + `${opts.annotOc ? ` /OC ${opts.annotOc}` : ''} /F 4`
    + ` /Contents (carried text) /AP << /N 11 0 R >> >>`;
  objects[14] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  // 15..: /StructTreeRoot, one /P per requested MCID, and the /ParentTree that
  // maps the page's /StructParents 0 back to them.
  const mcids = opts.mcids ?? [];
  const kidRefs = mcids.map((_, i) => `${16 + i} 0 R`).join(' ');
  if (mcids.length) {
    objects[15] = `<< /Type /StructTreeRoot /K [${kidRefs}] /ParentTree ${16 + mcids.length} 0 R >>`;
    mcids.forEach((m, i) => {
      const st = opts.structTypes?.[i] ?? 'P';
      objects[16 + i] = `<< /Type /StructElem /S /${st} /P 15 0 R /Pg 3 0 R /K ${m} /Alt (alt text) >>`;
    });
    objects[16 + mcids.length] = `<< /Nums [0 [${kidRefs}]] >>`;
  }
  if (patternObj) {
    const TILE = marked(TILE_INK, opts.patternOc);
    objects[patternObj] = `<< /Type /Pattern /PatternType 1 /PaintType 1`
      + ` /TilingType 1 /BBox [0 0 20 20] /XStep 20 /YStep 20`
      + ` /Resources << ${nestedProps('Pat')} >> /Length ${byteLen(TILE)} >>\nstream\n${TILE}endstream`;
  }
  if (t3FontObj) {
    // `d0` rather than `d1`: a d1 glyph is a shape whose colour comes from
    // the text state, and this one paints its own green.
    const PROC = `40 0 d0\n${marked(FORM_INK, opts.charProcOc)}`;
    objects[t3FontObj] = `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 40 40]`
      + ` /FontMatrix [1 0 0 1 0 0] /CharProcs << /sq ${t3ProcObj} 0 R >>`
      + ` /Encoding << /Type /Encoding /Differences [97 /sq] >>`
      + ` /FirstChar 97 /LastChar 97 /Widths [40]`
      + ` /Resources << ${nestedProps('T3')} >> >>`;
    objects[t3ProcObj] = `<< /Length ${byteLen(PROC)} >>\nstream\n${PROC}endstream`;
  }
  if (content2Obj) {
    const c2 = opts.content2!;
    objects[content2Obj] = `<< /Length ${byteLen(c2)} >>
stream
${c2}endstream`;
  }
  if (smaskObj) {
    const MASK = marked('1 g 0 0 200 200 re f\n', opts.smaskOc);
    objects[smaskObj] = `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200]`
      + ` /Group << /S /Transparency /CS /DeviceGray >>`
      + ` /Resources << ${nestedProps('Sm')} >> /Length ${byteLen(MASK)} >>\nstream\n${MASK}endstream`;
  }
  const maxObj = Math.max(nextObj - 1, mcids.length ? 16 + mcids.length : 14);

  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}
