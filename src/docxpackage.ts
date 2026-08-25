import { buildOoxmlPackage, type OoxmlPart, type OoxmlRelationship } from './ooxml.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DOC_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The `word/document.xml` part.
 *
 *  **Invariant:** the XML declaration and the `w:` namespace declaration are
 *  both required by ECMA-376. Whether a given consumer tolerates their absence
 *  is untested here — conformance is the standard held, not what some reader
 *  happens to accept. */
function documentXml(bodyXml: string): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + `<w:document xmlns:w="${W_NS}" xmlns:r="${REL_BASE}"`
    + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
    + `><w:body>${bodyXml}</w:body></w:document>\n`;
}

/** Parts and relationships a caller adds beside the minimal set — styles,
 *  numbering, images. */
export interface DocxExtras { parts?: OoxmlPart[]; rels?: OoxmlRelationship[] }

/** Write a minimal conformant `.docx` whose body is `bodyXml` — the inner XML
 *  of `<w:body>`.
 *
 *  `bodyXml` is the seam: this module owns the package and knows nothing about
 *  where the content came from, which is what lets `8yt9.2` map `docmodel.ts`
 *  into it without touching any of the three layers below. It is inserted
 *  verbatim, so a caller is responsible for producing valid WordprocessingML —
 *  escaping text is the mapper's job, not the package's.
 *
 *  There is deliberately no `word/_rels/document.xml.rels`: a relationships
 *  part with no relationships is legal and says nothing, and emitting one would
 *  need a DOCX-shaped special case inside the format-neutral `ooxml.ts`. The
 *  first image or hyperlink creates it through the same path every other
 *  `.rels` uses. */
export function writeDocx(bodyXml: string, extras: DocxExtras = {}): Uint8Array {
  const parts: OoxmlPart[] = [
    { path: 'word/document.xml', bytes: utf8(documentXml(bodyXml)), contentType: DOC_TYPE },
    ...(extras.parts ?? []),
  ];
  const rels: OoxmlRelationship[] = [
    {
      source: '', id: 'rId1',
      type: `${REL_BASE}/officeDocument`, target: 'word/document.xml',
    },
    ...(extras.rels ?? []),
  ];
  return buildOoxmlPackage(parts, rels);
}
