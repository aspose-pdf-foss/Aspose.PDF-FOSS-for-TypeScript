const ID = 'http://www.aiim.org/pdfa/ns/id/';

/** Literal XML fixtures, independent of the library's XMP writer. */
export function buildPdfaIdPacket(attributes: string, body = '', bindings = `xmlns:a="${ID}"`): string {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/">`
    + `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`
    + `<rdf:Description rdf:about="" ${bindings} ${attributes}>${body}</rdf:Description>`
    + `</rdf:RDF></x:xmpmeta>`;
}
