// Hand-built PDFs shaped to reach a LoadLimits bound (`ibzo.2`).
//
// Each builder states the ONE thing that is large, so a test can lower the
// matching limit and reach it with a small file — a bound is observable at 10
// as well as at 10 million, and the suite stays fast. The acceptance-scale
// inputs (a 10-million-row xref, a 10,000-deep array) are built here too, for
// the handful of cases that assert the default policy itself.

const enc = (s: string) => new TextEncoder().encode(s);

/** A minimal catalog, page tree and one page: objects 1-3. */
export const BASE_OBJECTS = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>',
];

/** Classic xref rows for objects 1..n at the given offsets, free head first. */
export function xrefRows(offsets: number[]): string {
  return '0000000000 65535 f \n'
    + offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
}

/** Serialize `objects` (object 1 first) with a classic xref. `tail` replaces
 *  the default `xref … trailer <<…>>` text and receives the object offsets and
 *  the offset the xref section starts at; the builder appends `startxref`. */
export function buildObjectsPdf(
  objects: string[],
  tail?: (offsets: number[], xrefAt: number) => string,
): Uint8Array {
  let body = '%PDF-1.7\n';
  const offsets: number[] = [0];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefAt = body.length;
  const xref = tail
    ? tail(offsets, xrefAt)
    : `xref\n0 ${objects.length + 1}\n${xrefRows(offsets)}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  return enc(`${body}${xref}startxref\n${xrefAt}\n%%EOF\n`);
}

/** The base document plus object 4 holding `value`, reachable from nothing. */
export function withObject(value: string): Uint8Array {
  return buildObjectsPdf([...BASE_OBJECTS, value]);
}

/** An array nested `depth` levels deep, as object 4. */
export function deepArrayPdf(depth: number): Uint8Array {
  return withObject('['.repeat(depth) + ']'.repeat(depth));
}

/** Object 4 is a dict nested `depth` levels deep: `<< /A << /A … >> >>`. */
export function deepDictPdf(depth: number): Uint8Array {
  return withObject('<< /A '.repeat(depth) + '>> '.repeat(depth));
}

/** Object 4 is an array of `n` integers. */
export function wideArrayPdf(n: number): Uint8Array {
  return withObject(`[${'1 '.repeat(n)}]`);
}

/** Object 4 is a dict with `n` keys. */
export function wideDictPdf(n: number): Uint8Array {
  let d = '<<';
  for (let i = 0; i < n; i++) d += ` /K${i} 1`;
  return withObject(`${d} >>`);
}

/** Object 4 is a literal string of `n` bytes. */
export function longStringPdf(n: number): Uint8Array {
  return withObject(`(${'a'.repeat(n)})`);
}

/** Object 4 is a stream of `n` payload bytes. */
export function longStreamPdf(n: number): Uint8Array {
  return withObject(`<< /Length ${n} >>\nstream\n${'a'.repeat(n)}\nendstream`);
}

/** A classic xref whose single section declares `extra` further rows after the
 *  three real objects — every one PRESENT, pointing at object 1. */
export function manyRowsPdf(extra: number): Uint8Array {
  return buildObjectsPdf(BASE_OBJECTS, (offsets) =>
    `xref\n0 4\n${xrefRows(offsets)}4 ${extra}\n${`${String(offsets[1]).padStart(10, '0')} 00000 n \n`.repeat(extra)}`
    + `trailer\n<< /Size ${4 + extra} /Root 1 0 R >>\n`);
}

/** `sections` classic xref sections chained through `/Prev`, each re-stating
 *  the same three rows. The newest is written last and named by startxref. */
export function prevChainPdf(sections: number): Uint8Array {
  let body = '%PDF-1.7\n';
  const offsets: number[] = [0];
  BASE_OBJECTS.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  let prev: number | undefined;
  for (let s = 0; s < sections; s++) {
    const at = body.length;
    body += `xref\n0 4\n${xrefRows(offsets)}trailer\n<< /Size 4 /Root 1 0 R`
      + `${prev === undefined ? '' : ` /Prev ${prev}`} >>\n`;
    prev = at;
  }
  return enc(`${body}startxref\n${prev}\n%%EOF\n`);
}

/** A single xref section whose `/Prev` names ITSELF. */
export function selfPrevPdf(): Uint8Array {
  return buildObjectsPdf(BASE_OBJECTS, (offsets, at) =>
    `xref\n0 4\n${xrefRows(offsets)}trailer\n<< /Size 4 /Root 1 0 R /Prev ${at} >>\n`);
}

/** A page tree `depth` intermediate `/Pages` nodes deep, each its own object,
 *  above a single page. Every object is FLAT, so only a graph walk sees depth. */
export function deepPageTreePdf(depth: number): Uint8Array {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>'];
  for (let i = 0; i < depth; i++) objects.push(`<< /Type /Pages /Kids [${i + 3} 0 R] /Count 1 >>`);
  objects.push('<< /Type /Page /MediaBox [0 0 10 10] >>');
  return buildObjectsPdf(objects);
}

/** An outline `depth` items deep: each item's only child is the next. */
export function deepOutlinePdf(depth: number): Uint8Array {
  const objects = ['<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>', BASE_OBJECTS[1], BASE_OBJECTS[2],
    '<< /Type /Outlines /First 5 0 R /Last 5 0 R >>'];
  for (let i = 0; i < depth; i++) {
    const kid = i + 1 < depth ? ` /First ${i + 6} 0 R /Last ${i + 6} 0 R /Count 1` : '';
    objects.push(`<< /Title (item ${i}) /Parent ${i + 4} 0 R /Dest [3 0 R /Fit]${kid} >>`);
  }
  return buildObjectsPdf(objects);
}

/** An AcroForm field tree `depth` fields deep, a text field at the bottom. */
export function deepFieldPdf(depth: number): Uint8Array {
  const objects = ['<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> >>',
    BASE_OBJECTS[1], BASE_OBJECTS[2]];
  for (let i = 0; i < depth; i++) {
    objects.push(i + 1 < depth
      ? `<< /T (f${i}) /Kids [${i + 5} 0 R] >>`
      : `<< /T (f${i}) /FT /Tx /V (leaf) >>`);
  }
  return buildObjectsPdf(objects);
}

/** A `/Names /Dests` name tree `depth` nodes deep, one destination at the
 *  bottom. `selfLoop` instead makes the root's only kid the root itself. */
export function deepNameTreePdf(depth: number, selfLoop = false): Uint8Array {
  const objects = ['<< /Type /Catalog /Pages 2 0 R /Names << /Dests 4 0 R >> >>', BASE_OBJECTS[1], BASE_OBJECTS[2]];
  if (selfLoop) {
    objects.push('<< /Kids [4 0 R] >>');
    return buildObjectsPdf(objects);
  }
  for (let i = 0; i < depth; i++) {
    objects.push(i + 1 < depth ? `<< /Kids [${i + 5} 0 R] >>` : '<< /Names [(a) [3 0 R /Fit]] >>');
  }
  return buildObjectsPdf(objects);
}

/** A page whose `/XObject` resources nest `depth` Form XObjects, each drawing
 *  the next, with a 1x1 image at the bottom. */
export function deepFormXObjectPdf(depth: number): Uint8Array {
  const objects = [BASE_OBJECTS[0], BASE_OBJECTS[1],
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Resources << /XObject << /X 4 0 R >> >> >>'];
  for (let i = 0; i < depth; i++) {
    objects.push(`<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /X ${i + 5} 0 R >> >> /Length 0 >>\nstream\n\nendstream`);
  }
  objects.push('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x00\nendstream');
  return buildObjectsPdf(objects);
}

/** A one-page document whose page content is each of `streams`, in order —
 *  one stream gives a `/Contents` stream, several give a `/Contents` array.
 *  Every payload is ASCII so the builder's text encoding cannot mangle it; pass
 *  `filter` and a hex-encoded payload to reach a binary one. */
export function contentPdf(
  streams: string[], opts: { mediaBox?: string; filter?: string; extraObjects?: string[]; resources?: string } = {},
): Uint8Array {
  const kids = streams.map((_, i) => `${i + 4} 0 R`);
  const contents = streams.length === 1 ? kids[0] : `[${kids.join(' ')}]`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox ${opts.mediaBox ?? '[0 0 10 10]'} `
      + `/Resources ${opts.resources ?? '<< >>'} /Contents ${contents} >>`,
    ...streams.map((s) => `<< ${opts.filter ? `/Filter ${opts.filter} ` : ''}/Length ${s.length} >>\nstream\n${s}\nendstream`),
    ...(opts.extraObjects ?? []),
  ];
  return buildObjectsPdf(objects);
}

/** A tagged page whose structure tree is `depth` elements deep, one per object;
 *  the innermost `/P` marks MCID 0, which draws "Hello". `cycle` instead makes
 *  the innermost element's `/K` point back at the outermost. */
export function deepStructPdf(depth: number, cycle = false): Uint8Array {
  const leaf = depth + 5;
  const content = depth + 6;
  const o = [
    '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 4 0 R /MarkInfo << /Marked true >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /StructParents 0 /Contents ${content} 0 R `
      + '/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
    '<< /Type /StructTreeRoot /K 6 0 R /ParentTree 5 0 R >>',
    `<< /Nums [0 [${leaf} 0 R]] >>`,
  ];
  for (let i = 0; i < depth; i++) {
    const num = i + 6;
    const parent = i === 0 ? 4 : num - 1;
    if (i + 1 < depth) o.push(`<< /Type /StructElem /S /Div /P ${parent} 0 R /K ${num + 1} 0 R >>`);
    else o.push(`<< /Type /StructElem /S /P /P ${parent} 0 R /Pg 3 0 R /K ${cycle ? '[0 6 0 R]' : '0'} >>`);
  }
  const c = '/P << /MCID 0 >> BDC BT /F1 12 Tf 10 50 Td (Hello) Tj ET EMC';
  o.push(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
  return buildObjectsPdf(o);
}

/** A tagged page whose `/ParentTree` is a `/Kids` chain `depth` nodes deep. */
export function deepNumberTreePdf(depth: number): Uint8Array {
  const o = [
    '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 4 0 R /MarkInfo << /Marked true >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /StructParents 0 >>',
    '<< /Type /StructTreeRoot /K 5 0 R /ParentTree 6 0 R >>',
    '<< /Type /StructElem /S /P /P 4 0 R /Pg 3 0 R /K 0 >>',
  ];
  for (let i = 0; i < depth; i++) o.push(i + 1 < depth ? `<< /Kids [${i + 7} 0 R] >>` : '<< /Nums [0 [5 0 R]] >>');
  return buildObjectsPdf(o);
}

/** A page filling a square inside an optional-content section whose OCMD's /VE
 *  nests `depth` levels, each its own indirect array: `/Not` wrappers around an
 *  innermost `[/Not L]`. With `cycle` the innermost is `[/And <outermost> L]`
 *  instead — it loops back BEFORE it names the layer, which is the only shape a
 *  walk that stops at the first reference to the layer cannot skip. With `unused` the
 *  OCMD is still in the page's /Properties but no content selects it, so only a
 *  walk over the resources — RemoveLayer's — can reach the expression. */
export function deepVePdf(depth: number, cycle = false, unused = false): Uint8Array {
  const c = unused ? '0 0 10 10 re f' : '/OC /MC0 BDC 0 0 10 10 re f EMC';
  const o = [
    '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R] /D << /ON [5 0 R] >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /Properties << /MC0 6 0 R >> >> >>',
    `<< /Length ${c.length} >>\nstream\n${c}\nendstream`,
    '<< /Type /OCG /Name (L) >>',
    '<< /Type /OCMD /VE 7 0 R >>',
  ];
  for (let i = 0; i < depth; i++) {
    const num = i + 7;
    o.push(i + 1 < depth ? `[/Not ${num + 1} 0 R]` : cycle ? '[/And 7 0 R 5 0 R]' : '[/Not 5 0 R]');
  }
  return buildObjectsPdf(o);
}

/** Page 1 draws a chain of `depth` Form XObjects, each drawing the next. */
export function deepFormChainPdf(depth: number): Uint8Array {
  const c = '/X Do';
  const o = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /XObject << /X 5 0 R >> >> >>',
    `<< /Length ${c.length} >>\nstream\n${c}\nendstream`,
  ];
  for (let i = 0; i < depth; i++) {
    const last = i + 1 === depth;
    const res = last ? '' : `/Resources << /XObject << /X ${i + 6} 0 R >> >> `;
    const body = last ? '0 0 1 1 re f' : '/X Do';
    o.push(`<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] ${res}/Length ${body.length} >>\nstream\n${body}\nendstream`);
  }
  return buildObjectsPdf(o);
}
