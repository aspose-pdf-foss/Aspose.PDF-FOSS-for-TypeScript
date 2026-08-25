const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

export interface UaNode {
  type: string;              // /S structure type
  alt?: string;              // /Alt
  actualText?: string;       // /ActualText
  lang?: string;             // /Lang
  mcid?: number;             // tagged content run owned by this element
  text?: string;             // glyph text for the mcid run (ASCII, no parens)
  roleMapTo?: string;        // register `type` -> this standard type in /RoleMap
  children?: UaNode[];
}

export interface UaOptions {
  tagged?: boolean;          // default true; false omits /StructTreeRoot + /MarkInfo
  marked?: boolean;          // default true; /MarkInfo /Marked value
  lang?: string | null;      // default 'en-US'; null omits catalog /Lang
  title?: string | null;     // default 'Test Document'; null omits /Info /Title
  displayDocTitle?: boolean; // default true; /ViewerPreferences /DisplayDocTitle
  suspects?: boolean;        // default false; /MarkInfo /Suspects true when set
  root?: UaNode[];           // default [{ Document > P mcid 0 }]
}

interface Flat { node: UaNode; num: number; parentRef: string; }

/** Assign object numbers (pre-order from `next.n`) to every node; collect refs. */
function flatten(nodes: UaNode[], parentRef: string, next: { n: number }, out: Flat[]): string[] {
  const refs: string[] = [];
  for (const node of nodes) {
    const num = next.n++;
    refs.push(`${num} 0 R`);
    out.push({ node, num, parentRef });
    if (node.children) flatten(node.children, `${num} 0 R`, next, out);
  }
  return refs;
}

export function buildUaPdf(opts: UaOptions = {}): Uint8Array {
  const tagged = opts.tagged ?? true;
  const marked = opts.marked ?? true;
  const lang = opts.lang === undefined ? 'en-US' : opts.lang;
  const title = opts.title === undefined ? 'Test Document' : opts.title;
  const displayDocTitle = opts.displayDocTitle ?? true;
  const suspects = opts.suspects ?? false;
  const root: UaNode[] = opts.root ?? [{ type: 'Document', children: [{ type: 'P', mcid: 0, text: 'Body' }] }];

  // Fixed objects 1..8; struct elems start at 9.
  const STRUCT_ROOT = 7, PARENT_TREE = 8;
  const flat: Flat[] = [];
  const topRefs = flatten(root, `${STRUCT_ROOT} 0 R`, { n: 9 }, flat);

  // Content runs + ParentTree, keyed by mcid.
  const byMcid: Record<number, string> = {};
  const runs: string[] = [];
  for (const f of flat) {
    const { node, num } = f;
    if (node.mcid !== undefined) {
      byMcid[node.mcid] = `${num} 0 R`;
      const y = 350 - 30 * node.mcid;
      runs[node.mcid] = `/${node.type} <</MCID ${node.mcid}>> BDC\nBT /F1 12 Tf 50 ${y} Td (${node.text ?? 'X'}) Tj ET\nEMC\n`;
    }
  }
  const content = runs.filter((s) => s !== undefined).join('');

  // RoleMap from any node.roleMapTo.
  const roleEntries = flat
    .filter((f) => f.node.roleMapTo)
    .map((f) => `/${f.node.type} /${f.node.roleMapTo}`)
    .join(' ');

  // ParentTree Nums: page key 0 -> array indexed by mcid.
  const maxMcid = Object.keys(byMcid).map(Number).reduce((a, b) => Math.max(a, b), -1);
  const ptArray = maxMcid < 0 ? '[]'
    : '[' + Array.from({ length: maxMcid + 1 }, (_, i) => byMcid[i] ?? 'null').join(' ') + ']';

  const objects: string[] = [];
  const markInfoParts: string[] = [];
  if (tagged) markInfoParts.push(`/Marked ${marked}`);
  if (suspects) markInfoParts.push(`/Suspects true`);
  const catParts = [`/Type /Catalog`, `/Pages 2 0 R`];
  if (tagged) catParts.push(`/StructTreeRoot ${STRUCT_ROOT} 0 R`);
  if (markInfoParts.length) catParts.push(`/MarkInfo << ${markInfoParts.join(' ')} >>`);
  if (lang !== null) catParts.push(`/Lang (${lang})`);
  if (displayDocTitle) catParts.push(`/ViewerPreferences << /DisplayDocTitle true >>`);

  objects[1] = `<< ${catParts.join(' ')} >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /StructParents 0 >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[6] = title === null ? `<< >>` : `<< /Title (${title}) >>`;
  if (tagged) {
    objects[STRUCT_ROOT] = `<< /Type /StructTreeRoot /K [${topRefs.join(' ')}] /ParentTree ${PARENT_TREE} 0 R`
      + (roleEntries ? ` /RoleMap << ${roleEntries} >>` : '') + ` >>`;
    objects[PARENT_TREE] = `<< /Nums [0 ${ptArray}] >>`;
    for (const f of flat) {
      const { node, num, parentRef } = f;
      // /K = own mcid (if any) followed by child element refs (from the flat list).
      const kids: string[] = [];
      if (node.mcid !== undefined) kids.push(`${node.mcid}`);
      for (const fr of flat) if (fr.parentRef === `${num} 0 R`) kids.push(`${fr.num} 0 R`);
      const parts = [`/Type /StructElem`, `/S /${node.type}`, `/P ${parentRef}`];
      if (node.mcid !== undefined) parts.push(`/Pg 3 0 R`);
      parts.push(`/K [${kids.join(' ')}]`);
      if (node.alt !== undefined) parts.push(`/Alt (${node.alt})`);
      if (node.actualText !== undefined) parts.push(`/ActualText (${node.actualText})`);
      if (node.lang !== undefined) parts.push(`/Lang (${node.lang})`);
      objects[num] = `<< ${parts.join(' ')} >>`;
    }
  }

  const maxObj = objects.reduce((m, _, i) => (objects[i] !== undefined ? i : m), 0);
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    if (objects[n] === undefined) continue;
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) {
    xref += objects[n] === undefined
      ? `0000000000 00000 f \n`
      : `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}
