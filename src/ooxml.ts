import { writeZip, type ZipEntry } from './zip.js';
import { escapeXml } from './xml.js';

/** One part of an OPC package. */
export interface OoxmlPart {
  /** Package path, e.g. 'word/document.xml'. No leading slash. */
  path: string;
  bytes: Uint8Array;
  /** The part's media type, e.g. 'application/xml'. Required: a part the
   *  content-type file does not cover is a part a reader refuses. */
  contentType: string;
  /** Store rather than deflate — for already-compressed data such as a JPEG. */
  store?: boolean;
}

/** One entry of a `.rels` file. */
export interface OoxmlRelationship {
  /** The part whose relationships file this belongs in; '' for the package root. */
  source: string;
  /** Relationship id, unique within its source, e.g. 'rId1'. */
  id: string;
  /** The ECMA-376 relationship type URI. */
  type: string;
  /** Relative to the SOURCE part's directory, or an absolute URI when external. */
  target: string;
  /** A hyperlink rather than a part in this package. */
  external?: boolean;
}

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The `.rels` path for a source part. '' is the package root.
 *
 *  **Invariant:** a relationship lives beside its source, in that source's own
 *  `_rels` directory — `word/document.xml` keeps its relationships in
 *  `word/_rels/document.xml.rels`. Putting them all at the root produces a
 *  package whose parts exist and whose links dangle. */
function relsPath(source: string): string {
  if (source === '') return '_rels/.rels';
  const cut = source.lastIndexOf('/');
  const dir = cut < 0 ? '' : source.slice(0, cut + 1);
  const name = cut < 0 ? source : source.slice(cut + 1);
  return `${dir}_rels/${name}.rels`;
}

/** **Invariant:** `[Content_Types].xml` is GENERATED from the parts, never
 *  written by hand. Deriving it from the same list that produces the zip
 *  entries is what makes the two incapable of disagreeing about which parts
 *  exist. `.rels` is covered by its extension default rather than an override,
 *  which is what the specification requires. */
function contentTypesXml(parts: OoxmlPart[]): string {
  const overrides = parts
    .map((p) => `  <Override PartName="/${escapeXml(p.path)}" ContentType="${escapeXml(p.contentType)}"/>`)
    .join('\n');
  return `${DECL}<Types xmlns="${CT_NS}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
${overrides}
</Types>\n`;
}

function relsXml(rels: OoxmlRelationship[]): string {
  const items = rels.map((r) => {
    const mode = r.external ? ' TargetMode="External"' : '';
    return `  <Relationship Id="${escapeXml(r.id)}" Type="${escapeXml(r.type)}"`
      + ` Target="${escapeXml(r.target)}"${mode}/>`;
  }).join('\n');
  return `${DECL}<Relationships xmlns="${REL_NS}">
${items}
</Relationships>\n`;
}

/** Assemble an OPC package: the parts, their generated content-type file, and
 *  one `.rels` per source that has relationships.
 *
 *  A source with no relationships gets no `.rels` part. One containing nothing
 *  is legal and says nothing, and emitting it would need a format-specific
 *  special case in this, the format-neutral layer. */
export function buildOoxmlPackage(
  parts: OoxmlPart[], rels: OoxmlRelationship[],
): Uint8Array {
  for (const p of parts) {
    if (!p.contentType) throw new TypeError(`part ${p.path} has no content type`);
  }

  const entries: ZipEntry[] = [
    { path: '[Content_Types].xml', bytes: utf8(contentTypesXml(parts)) },
  ];

  const bySource = new Map<string, OoxmlRelationship[]>();
  for (const r of rels) {
    const list = bySource.get(r.source) ?? [];
    list.push(r);
    bySource.set(r.source, list);
  }
  for (const [source, list] of bySource) {
    entries.push({ path: relsPath(source), bytes: utf8(relsXml(list)) });
  }

  for (const p of parts) {
    entries.push({ path: p.path, bytes: p.bytes, method: p.store ? 'store' : 'deflate' });
  }
  return writeZip(entries);
}
