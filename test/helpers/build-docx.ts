/** A .docx for m2fp.5's tests: a body plus optional styles, numbering, font
 *  table, core properties, media and extra document relationships. The body is
 *  wrapped by helpers/wml.ts's docXml (which declares w, r, wp, a, pic). */
import { buildOoxmlPackage, type OoxmlPart, type OoxmlRelationship } from '../../src/ooxml.js';
import { docXml, stylesXml, numberingXml, enc, W_NS } from './wml.js';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml';

export interface DocxParts {
  styles?: string; numbering?: string; fontTable?: string; core?: string;
  media?: { name: string; bytes: Uint8Array; contentType: string }[];
  rels?: { id: string; type: string; target: string; external?: boolean }[];
}

export function buildDocx(bodyXml: string, parts: DocxParts = {}): Uint8Array {
  const p: OoxmlPart[] = [{ path: 'word/document.xml', bytes: docXml(bodyXml), contentType: `${CT}.document.main+xml` }];
  const r: OoxmlRelationship[] = [{ source: '', id: 'rId1', type: `${REL}/officeDocument`, target: 'word/document.xml' }];
  const docRel = (id: string, type: string, target: string, external?: boolean): void => {
    r.push({ source: 'word/document.xml', id, type: `${REL}/${type}`, target, ...(external ? { external: true } : {}) });
  };
  if (parts.styles !== undefined) {
    p.push({ path: 'word/styles.xml', bytes: stylesXml(parts.styles), contentType: `${CT}.styles+xml` });
    docRel('rSt', 'styles', 'styles.xml');
  }
  if (parts.numbering !== undefined) {
    p.push({ path: 'word/numbering.xml', bytes: numberingXml(parts.numbering), contentType: `${CT}.numbering+xml` });
    docRel('rNu', 'numbering', 'numbering.xml');
  }
  if (parts.fontTable !== undefined) {
    p.push({ path: 'word/fontTable.xml', bytes: enc(`<w:fonts xmlns:w="${W_NS}">${parts.fontTable}</w:fonts>`), contentType: `${CT}.fontTable+xml` });
    docRel('rFt', 'fontTable', 'fontTable.xml');
  }
  if (parts.core !== undefined) {
    p.push({ path: 'docProps/core.xml', contentType: 'application/vnd.openxmlformats-package.core-properties+xml',
      bytes: enc('<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        + `xmlns:dc="http://purl.org/dc/elements/1.1/">${parts.core}</cp:coreProperties>`) });
    r.push({ source: '', id: 'rCore', type: `${PKG_REL}/metadata/core-properties`, target: 'docProps/core.xml' });
  }
  for (const m of parts.media ?? []) {
    p.push({ path: `word/media/${m.name}`, bytes: m.bytes, contentType: m.contentType, store: true });
  }
  for (const x of parts.rels ?? []) docRel(x.id, x.type, x.target, x.external);
  return buildOoxmlPackage(p, r);
}
