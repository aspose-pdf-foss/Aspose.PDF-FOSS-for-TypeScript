import { writeZip, type ZipEntry } from './zip.js';

/** The content directory, and the OPF's own directory. */
export const EPUB_DIR = 'EPUB';

const OPF_PATH = `${EPUB_DIR}/package.opf`;
const MIMETYPE = 'application/epub+zip';

/** A fixed modification date, for the same reason zip.ts fixes its timestamps:
 *  two runs over one input must give identical bytes. EPUB 3 wants a
 *  `dcterms:modified`, and reading the clock would make every archive unique
 *  and nothing downstream snapshot-testable. */
const MODIFIED = '1980-01-01T00:00:00Z';

/** One file in the package, plus what the OPF must say about it. */
export interface EpubPart {
  /** Path relative to the OPF's directory, e.g. 'content.xhtml'. */
  path: string;
  bytes: Uint8Array;
  mediaType: string;
  /** Manifest id. Unique across the package. */
  id: string;
  /** EPUB 3 manifest properties, e.g. 'nav'. */
  properties?: string;
  /** True when this is a content document in reading order. Spine order is
   *  array order. */
  spine?: boolean;
}

export interface EpubMetadata {
  identifier: string;
  title: string;
  language: string;
  author?: string;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** XML text escaping.
 *
 *  Only the five predefined entities exist in XML, which is why nothing here
 *  may emit a named entity such as `&nbsp;` — an XHTML document carrying one
 *  is not well-formed and a reader rejects the whole file. */
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
}

function containerXml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<container version="1.0" '
    + 'xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
    + '<rootfiles>\n'
    + `<rootfile full-path="${OPF_PATH}" `
    + 'media-type="application/oebps-package+xml"/>\n'
    + '</rootfiles>\n</container>\n';
}

function packageOpf(parts: EpubPart[], meta: EpubMetadata): string {
  const items = parts.map((p) =>
    `<item id="${esc(p.id)}" href="${esc(p.path)}" `
    + `media-type="${esc(p.mediaType)}"`
    + (p.properties ? ` properties="${esc(p.properties)}"` : '')
    + '/>').join('\n');
  const spine = parts.filter((p) => p.spine)
    .map((p) => `<itemref idref="${esc(p.id)}"/>`).join('\n');
  const creator = meta.author
    ? `<dc:creator>${esc(meta.author)}</dc:creator>\n` : '';
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
    + 'unique-identifier="pub-id">\n'
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
    + `<dc:identifier id="pub-id">${esc(meta.identifier)}</dc:identifier>\n`
    + `<dc:title>${esc(meta.title)}</dc:title>\n`
    + `<dc:language>${esc(meta.language)}</dc:language>\n`
    + creator
    + `<meta property="dcterms:modified">${MODIFIED}</meta>\n`
    + '</metadata>\n'
    + `<manifest>\n${items}\n</manifest>\n`
    + `<spine>\n${spine}\n</spine>\n`
    + '</package>\n';
}

/** Assemble an EPUB 3 archive: the OCF container, the OPF package document,
 *  and the parts.
 *
 *  **Invariant:** `mimetype` is the FIRST entry and is STORED. Both halves
 *  matter and neither is decorative — a reader identifies an EPUB by reading
 *  `application/epub+zip` at byte 38 (30 bytes of local file header plus the
 *  8-byte name, no extra field) without inflating anything. Deflate it or emit
 *  it second and the result is still a valid ZIP holding all the right parts;
 *  it simply stops being recognisable as an EPUB. This is the one rule in the
 *  format that a structural "are the parts present" test cannot see, so it is
 *  asserted on the archive's raw bytes.
 *
 *  **Invariant:** a manifest href is relative to the OPF's own directory, not
 *  to the archive root — the same trap ooxml.ts records for a relationship
 *  target. Getting it wrong yields a package whose parts all exist and whose
 *  links all dangle, so every symptom points at the target while the fault is
 *  in the base.
 *
 *  **Invariant:** nothing here reads a clock or a random source. `zip.ts` fixes
 *  its timestamps for the same reason, and an identifier or a modified date
 *  from the environment would undo byte-reproducibility for the whole format. */
export function writeEpub(parts: EpubPart[], meta: EpubMetadata): Uint8Array {
  const seen = new Set<string>();
  for (const p of parts) {
    if (seen.has(p.id)) throw new TypeError(`duplicate manifest id ${p.id}`);
    seen.add(p.id);
  }

  const entries: ZipEntry[] = [
    { path: 'mimetype', bytes: utf8(MIMETYPE), method: 'store' },
    { path: 'META-INF/container.xml', bytes: utf8(containerXml()) },
    { path: OPF_PATH, bytes: utf8(packageOpf(parts, meta)) },
  ];
  for (const p of parts) {
    entries.push({ path: `${EPUB_DIR}/${p.path}`, bytes: p.bytes });
  }
  return writeZip(entries);
}
