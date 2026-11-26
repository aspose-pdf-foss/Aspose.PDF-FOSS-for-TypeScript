import type { Document } from './document.js';
import type { Attachment } from './embeddedfile.js';
import { PdfParseError, UnsupportedFeatureError, rethrowLimit } from './errors.js';
import { inflateStream } from './flate.js';
import { isStream, type PdfDict } from './types.js';
import { parseRdfPacket, type RdfPacket } from './xmprdf.js';
import { nsChildren, parseNsXml, type NsElement } from './xmlns.js';

/** The embedded CII document and the profile declared in its guideline ID. */
export interface HybridInvoice {
  readonly filename: string;
  readonly guidelineId: string;
  readonly profile: string;
  /** Caller-owned original XML bytes, including any BOM and original line endings. */
  readonly xml: Uint8Array;
}

const un = 'urn:un:unece:uncefact:data:standard:';
const legacyRoot = 'urn:ferd:CrossIndustryDocument:invoice:1p0';
const en = 'urn:cen.eu:en16931:2017';
const fx = 'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#';
const zf1 = 'urn:ferd:pdfa:CrossIndustryDocument:invoice:1p0#';
const xmpNamespaces = new Set([fx, zf1, 'urn:zugferd:pdfa:CrossIndustryDocument:invoice:2p0#',
  'urn:zugferd:pdfa:CrossIndustryDocument:invoice:1p0#']);
const invoiceNames = new Set(['factur-x.xml', 'zugferd-invoice.xml', 'xrechnung.xml']);

const profiles = new Map([[en, 'EN 16931'],
  [en + ':compliant:factur-x.eu:1p0:basic', 'BASIC'],
  [en + '#conformant#urn.cpro.gouv.fr:1p0:extended-ctc-fr', 'EXTENDED-CTC-FR']]);
for (const scheme of ['urn:factur-x.eu:1p0:', 'urn:zugferd.de:2p0:']) {
  profiles.set(scheme + 'minimum', 'MINIMUM');
  profiles.set(scheme + 'basicwl', 'BASIC WL');
  profiles.set(en + '#compliant#' + scheme + 'basic', 'BASIC');
  profiles.set(en + '#conformant#' + scheme + 'extended', 'EXTENDED');
}

function fail(message: string): never { throw new PdfParseError('Hybrid invoice: ' + message); }

function invoiceClaims(doc: Document, namedCandidate: boolean) {
  const claims = new Map<string, string>();
  let namespace: string | undefined;
  const md = doc.resolve(doc.catalog().get('Metadata'));
  if (isStream(md)) {
    let packet: RdfPacket;
    try {
      packet = parseRdfPacket(inflateStream(md), doc.loadLimits, true);
    } catch (caught) {
      rethrowLimit(caught);
      if (namedCandidate) fail('unreadable catalog XMP: ' + String(caught));
      return { claims, namespace };
    }
    for (const p of packet.properties) {
      if (!xmpNamespaces.has(p.ns) || !['DocumentType', 'DocumentFileName', 'ConformanceLevel', 'Version'].includes(p.name)) continue;
      if (namespace && namespace !== p.ns) fail('conflicting invoice XMP namespaces');
      namespace = p.ns;
      if (p.value.kind !== 'simple' || p.value.uri || !p.value.value.trim()) fail('invalid XMP ' + p.name);
      claims.set(p.name, p.value.value.trim());
    }
  }
  return { claims, namespace };
}

function onlyChild(parent: NsElement, ns: string, local: string): NsElement {
  const matches = nsChildren(parent, ns, local);
  if (matches.length !== 1) fail('expected one ' + local + ' element in the invoice context');
  return matches[0];
}

function invoiceProfile(root: NsElement) {
  const legacy = root.ns === legacyRoot && root.local === 'CrossIndustryDocument';
  if (!legacy && !(root.ns === un + 'CrossIndustryInvoice:100' && root.local === 'CrossIndustryInvoice'))
    fail('attachment root is not a recognized CII invoice');
  const ram = un + 'ReusableAggregateBusinessInformationEntity:' + (legacy ? '12' : '100');
  const context = onlyChild(root, root.ns, legacy ? 'SpecifiedExchangedDocumentContext' : 'ExchangedDocumentContext');
  const parameter = onlyChild(context, ram, 'GuidelineSpecifiedDocumentContextParameter');
  const id = onlyChild(parameter, ram, 'ID');
  const guidelineId = id.text.trim();
  if (id.children.length || !guidelineId) fail('expected a scalar guideline ID');
  let profile: string | undefined;
  if (legacy) {
    for (const level of ['basic', 'comfort', 'extended'])
      if (guidelineId === legacyRoot + ':' + level) profile = level.toUpperCase();
  } else {
    profile = profiles.get(guidelineId);
    if (/^urn:cen\.eu:en16931:2017#compliant#urn:(?:xeinkauf\.de:kosit:|xoev-de:kosit:standard:)xrechnung_\d+\.\d+(?:\.\d+)?$/.test(guidelineId))
      profile = 'XRECHNUNG';
  }
  if (!profile) throw new UnsupportedFeatureError('Unknown CII invoice guideline: ' + guidelineId);
  return { guidelineId, profile, legacy };
}

export function readHybridInvoice(doc: Document): HybridInvoice | undefined {
  const files = [...doc.GetAssociatedFiles(), ...doc.GetAttachments()];
  const isNamed = (file: Attachment) => invoiceNames.has(file.Name.toLowerCase());
  const { claims, namespace } = invoiceClaims(doc, files.some(isNamed));
  const declared = claims.get('DocumentFileName');
  const candidates = new Map<PdfDict, Attachment>();
  for (const file of files) {
    if (isNamed(file) || file.Name === declared) candidates.set(file.Dict, file);
  }
  if (candidates.size === 0 && !namespace) return undefined;
  if (candidates.size > 1) fail('multiple invoice attachments');
  const [file] = candidates.values();
  if (!file || (declared && declared !== file.Name)) fail('XMP DocumentFileName does not identify the invoice attachment');
  const xml = file.GetBytes();
  const root = parseNsXml(xml, doc.loadLimits, { completeDocument: true });
  const { guidelineId, profile, legacy } = invoiceProfile(root);
  if (namespace && (namespace === zf1) !== legacy) fail('XMP invoice namespace disagrees with the CII generation');
  if (claims.has('DocumentType') && claims.get('DocumentType') !== 'INVOICE') fail('XMP DocumentType is not INVOICE');
  const version = claims.get('Version');
  if (version && version.replace('p', '.') !== (namespace === fx || namespace === zf1 ? '1.0' : '2.0'))
    fail('XMP Version disagrees with its invoice namespace');
  const level = claims.get('ConformanceLevel');
  if (level && level.toUpperCase().replace(/ /g, '') !== profile.replace(/ /g, ''))
    fail('XMP ConformanceLevel disagrees with the XML guideline ID');
  return { filename: file.Name, profile, guidelineId, xml: Uint8Array.from(xml) };
}
