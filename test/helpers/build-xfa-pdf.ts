const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** A stream object body. `/Length` is the BYTE length of the payload, computed
 *  with a TextEncoder rather than `s.length`: XFA packets carry non-ASCII often
 *  enough that a character count silently truncates them. */
const streamObj = (payload: string) =>
  `<< /Length ${String(byteLen(payload))} >>\nstream\n${payload}\nendstream`;

export interface XfaPdfSpec {
  /** The `template` packet body. An empty string emits no template packet at
   *  all, which is how the no-template refusal is reached. */
  template: string;
  /** The `datasets` packet body. */
  datasets?: string;
  /** Further packets, name -> body. */
  extra?: Record<string, string>;
  /** Page count. Default 1. */
  pages?: number;
  /** The page box. Default US Letter, which is what
   *  `<medium short="8.5in" long="11in"/>` declares -- so the medium check
   *  passes unless a case deliberately disagrees with it. */
  mediaBox?: [number, number, number, number];
  /** Existing /AcroForm /Fields entries. The single-element shorthand
   *  `['{HYBRID}']` expands to the two-level tree form1[0] -> Page1[0] ->
   *  f1_01[0], the terminal being a real widget with /FT /Tx, a /Rect and a
   *  page /Annots entry -- the shape LiveCycle writes. */
  acroFieldObjects?: string[];
  /** Emit /XFA as a SINGLE XDP stream rather than the name/stream array. */
  singleStream?: boolean;
  /** Set the catalog's /NeedsRendering. */
  needsRendering?: boolean;
}

/** A one- or two-page PDF whose /AcroForm carries an /XFA of uncompressed
 *  packets. Object numbers are allocated dynamically, so a case may add packets
 *  and field objects freely. */
export function buildXfaPdf(spec: XfaPdfSpec): Uint8Array {
  const pageCount = spec.pages ?? 1;
  const box = spec.mediaBox ?? [0, 0, 612, 792];
  const objects: string[] = [];
  let next = 1;
  const alloc = (): number => next++;

  const catalogN = alloc();
  const pagesN = alloc();
  const pageNs = Array.from({ length: pageCount }, () => alloc());
  const contentsN = alloc();
  const acroN = alloc();

  // --- the XFA packets ---
  const packets: Array<[string, string]> = [];
  if (spec.template !== '') packets.push(['template', spec.template]);
  if (spec.datasets !== undefined) packets.push(['datasets', spec.datasets]);
  for (const [k, v] of Object.entries(spec.extra ?? {})) packets.push([k, v]);

  let xfaValue: string;
  if (spec.singleStream) {
    const n = alloc();
    objects[n] = streamObj(
      `<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">${
        packets.map(([, body]) => body).join('')}</xdp:xdp>`,
    );
    xfaValue = `${String(n)} 0 R`;
  } else {
    const parts: string[] = [];
    for (const [name, body] of packets) {
      const n = alloc();
      objects[n] = streamObj(body);
      parts.push(`(${name}) ${String(n)} 0 R`);
    }
    xfaValue = `[${parts.join(' ')}]`;
  }

  // --- an existing AcroForm field tree, for the hybrid case ---
  const fieldRefs: string[] = [];
  const annots: string[] = [];
  for (const entry of spec.acroFieldObjects ?? []) {
    if (entry !== '{HYBRID}') {
      const n = alloc();
      objects[n] = entry;
      fieldRefs.push(`${String(n)} 0 R`);
      continue;
    }
    // form1[0] -> Page1[0] -> f1_01[0]; the terminal is a merged field/widget.
    const rootN = alloc();
    const midN = alloc();
    const leafN = alloc();
    objects[rootN] = `<< /T (form1[0]) /Kids [${String(midN)} 0 R] >>`;
    objects[midN] =
      `<< /T (Page1[0]) /Parent ${String(rootN)} 0 R /Kids [${String(leafN)} 0 R] >>`;
    objects[leafN] = `<< /FT /Tx /T (f1_01[0]) /Parent ${String(midN)} 0 R `
      // DELIBERATELY NOT the rect POSITIONED_TEMPLATE computes ([72 628 288 648]).
      // Reconciliation must leave the AcroForm half's own geometry alone, and a
      // fixture whose two rects agree cannot tell that from a rewrite -- measured,
      // it passed with applyReconcile setting /Rect unconditionally.
      + `/Type /Annot /Subtype /Widget /Rect [100 100 300 120] /P ${String(pageNs[0])} 0 R >>`;
    fieldRefs.push(`${String(rootN)} 0 R`);
    annots.push(`${String(leafN)} 0 R`);
  }

  // --- the fixed objects ---
  objects[catalogN] = `<< /Type /Catalog /Pages ${String(pagesN)} 0 R `
    + `/AcroForm ${String(acroN)} 0 R`
    + `${spec.needsRendering ? ' /NeedsRendering true' : ''} >>`;
  objects[pagesN] = `<< /Type /Pages /Count ${String(pageCount)} `
    + `/Kids [${pageNs.map((n) => `${String(n)} 0 R`).join(' ')}] >>`;
  pageNs.forEach((n, i) => {
    objects[n] = `<< /Type /Page /Parent ${String(pagesN)} 0 R /Resources << >> `
      + `/MediaBox [${box.join(' ')}] /Contents ${String(contentsN)} 0 R`
      + `${i === 0 && annots.length > 0 ? ` /Annots [${annots.join(' ')}]` : ''} >>`;
  });
  objects[contentsN] = streamObj('');
  objects[acroN] = `<< /Fields [${fieldRefs.join(' ')}] /XFA ${xfaValue} >>`;

  // --- serialize ---
  const maxObj = next - 1;
  let body = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = new Array<number>(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${String(n)} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${String(maxObj + 1)}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++)
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${String(maxObj + 1)} /Root ${String(catalogN)} 0 R >>\n`
    + `startxref\n${String(xrefOffset)}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

// --- Template fragments the rule matrix reuses ---------------------------

/** One text field at x=1in, y=2in, w=3in, h=20pt on a US Letter page, with the
 *  whole chain positioned. The rect is therefore
 *  [72, 792-144-20, 72+216, 792-144] = [72, 628, 288, 648]. */
export const POSITIONED_TEMPLATE = `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/></pageArea></pageSet>
  <subform name="Page1" layout="position">
    <field name="f1_01" x="1in" y="2in" w="3in" h="20pt"><ui><textEdit/></ui></field>
  </subform></subform></template>`;

/** The same field under a layout="tb" subform, so it must degrade. */
export const FLOWED_TEMPLATE = `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/></pageArea></pageSet>
  <subform name="Page1" layout="tb">
    <field name="f1_01" x="1in" y="2in" w="3in" h="20pt"><ui><textEdit/></ui></field>
  </subform></subform></template>`;

/** A4 declared against a US Letter page: the medium mismatch, 17pt out. */
export const WRONG_MEDIUM_TEMPLATE = `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="210mm" long="297mm"/></pageArea></pageSet>
  <subform name="Page1" layout="position">
    <field name="f1_01" x="1in" y="2in" w="3in" h="20pt"><ui><textEdit/></ui></field>
  </subform></subform></template>`;

/** An exclGroup of two positioned check buttons. */
export const GROUP_TEMPLATE = `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/></pageArea></pageSet>
  <subform name="Page1" layout="position"><exclGroup name="colour">
    <field name="r" x="1in" y="1in" w="20pt" h="20pt"><ui><checkButton/></ui>
      <items><text>Red</text></items></field>
    <field name="g" x="1in" y="2in" w="20pt" h="20pt"><ui><checkButton/></ui>
      <items><text>Green</text></items></field>
  </exclGroup></subform></subform></template>`;

// --- Fixtures shaped for the seven mutation fences -----------------------
// Each is built for ONE mutation, and three of them would measure nothing in
// their obvious form. The comment on each says which trap it avoids.

/** A field 0.5in from the page TOP. With a flipped y-sign it lands near the
 *  BOTTOM -- which a field at the page centre could never show. Pair it with
 *  `mediaBox: [10, 20, 622, 812]`, whose non-zero origin also pins the offset. */
export const Y_FLIP_TEMPLATE = `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/></pageArea></pageSet>
  <subform name="Page1" layout="position">
    <field name="f" x="0.5in" y="0.5in" w="1in" h="18pt"><ui><textEdit/></ui></field>
  </subform></subform></template>`;

/** A template default that DIFFERS from the datum. With equal values, /V and
 *  /DV are indistinguishable and the swap is green. */
export const DIFFERING_DEFAULT_TEMPLATE = `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/></pageArea></pageSet>
  <subform name="Page1" layout="position">
    <field name="f" x="1in" y="1in" w="3in" h="20pt"><ui><textEdit/></ui>
      <value><text>AUTHORED</text></value></field>
  </subform></subform></template>`;

/** Three levels with a NON-ZERO offset at each: 0.25in + 1in + 10pt = 100pt.
 *  Two levels, or a zero anywhere, and "sum every level" and "read the last"
 *  give the same answer. */
export const THREE_DEEP_TEMPLATE = `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/></pageArea></pageSet>
  <subform name="Page1" layout="position" x="0.25in" y="0.25in">
    <subform name="A" layout="position" x="1in" y="1in">
      <subform name="B" layout="position" x="10pt" y="10pt">
        <field name="f" x="0" y="0" w="1in" h="20pt"><ui><textEdit/></ui></field>
      </subform></subform></subform></subform></template>`;

/** A choice whose export and display halves DIFFER, with the display list
 *  written first so "the save list" is not also "the first list". */
export const PAIRED_ITEMS_TEMPLATE = `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/></pageArea></pageSet>
  <subform name="Page1" layout="position">
    <field name="c" x="1in" y="1in" w="2in" h="20pt"><ui><choiceList/></ui>
      <items><text>United States</text></items>
      <items save="1"><text>US</text></items></field>
  </subform></subform></template>`;

/** A positioned subform INSIDE a flowed one: the immediate parent says
 *  position and the chain says no. A flat flowed template degrades under both
 *  readings and so measures nothing. */
export const NESTED_FLOW_TEMPLATE = `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/></pageArea></pageSet>
  <subform name="Page1" layout="tb">
    <subform name="Inner" layout="position">
      <field name="f" x="1in" y="1in" w="1in" h="20pt"><ui><textEdit/></ui></field>
    </subform></subform></subform></template>`;

/** One field carrying each flag, so each /Ff bit is asserted alone. */
export const FLAGS_TEMPLATE = `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/></pageArea></pageSet>
  <subform name="Page1" layout="position">
    <field name="ro" access="readOnly" x="1in" y="1in" w="1in" h="20pt">
      <ui><textEdit/></ui></field>
    <field name="req" x="1in" y="2in" w="1in" h="20pt"><ui><textEdit/></ui>
      <validate nullTest="error"/></field>
  </subform></subform></template>`;
