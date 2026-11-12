import { parseRdfPacket } from './xmprdf.js';
import { LoadLimits } from './loadlimits.js';
import { rethrowLimit } from './errors.js';

const PDFA_ID = 'http://www.aiim.org/pdfa/ns/id/';
type IdProperty = 'part' | 'conformance' | 'rev';
type PdfaIdentification = Partial<Record<IdProperty, string>>;

/** PDF/A identification as scalar text, preserving empty versus absent and
 *  lexical numbers for validation. Prefixes and entity spelling are XML syntax,
 *  not property identity. Only unreadable RDF takes the old lenient fallback. */
export function readPdfaIdentification(raw: string, limits: LoadLimits = LoadLimits.defaults): PdfaIdentification {
  try {
    const packet = parseRdfPacket(new TextEncoder().encode(raw), limits);
    const value = (prop: IdProperty): string | undefined => {
      const v = packet.properties.find((p) => p.ns === PDFA_ID && p.name === prop)?.value;
      return v?.kind === 'simple' && !v.uri ? v.value.trim() : undefined;
    };
    return { part: value('part'), conformance: value('conformance'), rev: value('rev') };
  } catch (e) {
    rethrowLimit(e);
    // Legacy fragments and damaged packets were readable before namespace
    // parsing. Keep that fallback, including empty attributes/elements (ugxr).
    const value = (prop: IdProperty): string | undefined => {
      const m = new RegExp(`pdfaid:${prop}\\s*=\\s*["']([^"']*)["']`).exec(raw)
        ?? new RegExp(`<pdfaid:${prop}>\\s*([^<]*?)\\s*</pdfaid:${prop}>`).exec(raw);
      return m?.[1].trim();
    };
    return { part: value('part'), conformance: value('conformance'), rev: value('rev') };
  }
}
