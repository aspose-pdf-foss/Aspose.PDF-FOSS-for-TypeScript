import type { Document } from './document.js';
import { addAssociatedFile, buildFilespec, type Attachment, type AFRelationship } from './embeddedfile.js';
import { registerFilespec } from './associatedfile.js';
import { flatNameNode, nameTreeEntries } from './nametree.js';
import { decodePdfByteString, encodePdfByteString } from './metadata.js';
import { PdfParseError, UnsupportedFeatureError, rethrowLimit } from './errors.js';
import { inflateStream } from './flate.js';
import { isArray, isDict, isStream, type PdfDict, type PdfObject } from './types.js';
import { parseRdfPacket, type RdfPacket, type RdfProperty } from './xmprdf.js';
import { writeXmpPacket } from './xmp.js';
import { childOf, extensionContainer, PDFA_EXTENSION_NS, PDFA_PROPERTY_NS, PDFA_SCHEMA_NS, REQUIRED_PREFIX, textOf } from './pdfaext.js';
import { describeExtensionProperty, pinPdfaPrefixes } from './pdfaextfix.js';
import { nsChildren, parseNsXml, type NsElement } from './xmlns.js';

/** The embedded CII document and the profile declared in its guideline ID. */
export interface HybridInvoice {
  readonly filename: string;
  readonly guidelineId: string;
  readonly profile: string;
  /** Caller-owned original XML bytes, including any BOM and original line endings. */
  readonly xml: Uint8Array;
}

export interface HybridInvoiceOptions {
  /** Semantic relationship of the XML to the visual invoice. Defaults to the profile convention. */
  relationship?: Extract<AFRelationship, 'Data' | 'Alternative' | 'Source'>;
}

const un = 'urn:un:unece:uncefact:data:standard:';
const legacyRoot = 'urn:ferd:CrossIndustryDocument:invoice:1p0';
const en = 'urn:cen.eu:en16931:2017';
const fx = 'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#';
const zf1 = 'urn:ferd:pdfa:CrossIndustryDocument:invoice:1p0#';
const zf2 = 'urn:zugferd:pdfa:CrossIndustryDocument:invoice:2p0#';
const xmpNamespaces = new Set([fx, zf1, zf2,
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

const descriptions = new Map([
  ['DocumentFileName', 'Name of the embedded invoice XML file'],
  ['DocumentType', 'Type of the embedded document'],
  ['Version', 'Version of the invoice standard'],
  ['ConformanceLevel', 'Invoice profile declared by the XML guideline'],
]);

function invoiceClaims(doc: Document, strict: boolean) {
  const claims = new Map<string, string>();
  let namespace: string | undefined;
  const md = doc.resolve(doc.catalog().get('Metadata'));
  let packet: RdfPacket = { properties: [], prefixes: new Map() };
  if (isStream(md)) {
    try {
      packet = parseRdfPacket(inflateStream(md), doc.loadLimits, true);
    } catch (caught) {
      rethrowLimit(caught);
      if (strict) fail('unreadable catalog XMP: ' + String(caught));
      return { claims, namespace, packet };
    }
    for (const p of packet.properties) {
      if (!xmpNamespaces.has(p.ns) || !descriptions.has(p.name)) continue;
      if (namespace && namespace !== p.ns) fail('conflicting invoice XMP namespaces');
      namespace = p.ns;
      if (p.value.kind !== 'simple' || p.value.uri || !p.value.value.trim()) fail('invalid XMP ' + p.name);
      claims.set(p.name, p.value.value.trim());
    }
  }
  return { claims, namespace, packet };
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

function locateInvoice(doc: Document, writing = false) {
  const files = [...doc.GetAssociatedFiles(), ...doc.GetAttachments()];
  const isNamed = (file: Attachment) => invoiceNames.has(file.Name.toLowerCase());
  if (writing && doc.catalog().has('Metadata') && !isStream(doc.resolve(doc.catalog().get('Metadata'))))
    fail('catalog metadata is not a stream');
  const { claims, namespace, packet } = invoiceClaims(doc, writing || files.some(isNamed));
  const declared = claims.get('DocumentFileName');
  const candidates = new Map<PdfDict, Attachment>();
  for (const file of files) {
    if (isNamed(file) || file.Name === declared) candidates.set(file.Dict, file);
  }
  if (candidates.size > 1) fail('multiple invoice attachments');
  const [file] = candidates.values();
  if ((!file && namespace) || (declared && declared !== file?.Name)) fail('XMP DocumentFileName does not identify the invoice attachment');
  return { file, claims, namespace, packet };
}

function decodeInvoice(doc: Document, file: Attachment, claims: Map<string, string>, namespace?: string) {
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
  return { filename: file.Name, profile, guidelineId, xml };
}

export function readHybridInvoice(doc: Document): HybridInvoice | undefined {
  const { file, claims, namespace } = locateInvoice(doc);
  if (!file) return undefined;
  const invoice = decodeInvoice(doc, file, claims, namespace);
  return { ...invoice, xml: Uint8Array.from(invoice.xml) };
}

function invoiceMetadata(packet: RdfPacket, ns: string, filename: string, profile: string) {
  const prefix = ns === fx ? 'fx' : 'zf';
  packet.properties = packet.properties.filter(p => !(xmpNamespaces.has(p.ns) && descriptions.has(p.name)));
  const property = (ns: string, name: string, value: string): RdfProperty => ({ ns, name, value: { kind: 'simple', value } });
  packet.properties.push(property(ns, 'DocumentType', 'INVOICE'), property(ns, 'DocumentFileName', filename),
    property(ns, 'Version', ns === zf2 ? '2p0' : '1.0'), property(ns, 'ConformanceLevel', profile));
  let schemas = extensionContainer(packet);
  if (!schemas) {
    schemas = { ns: PDFA_EXTENSION_NS, name: 'schemas', value: { kind: 'array', form: 'Bag', items: [] } };
    packet.properties.push(schemas);
  }
  if (schemas.value.kind !== 'array' || schemas.value.form !== 'Bag') fail('invalid PDF/A extension schema container');
  // Replace just the invoice property definitions. A producer can have declared
  // additional properties or value types even in one of the invoice namespaces.
  const definitions = [...descriptions].map(([key, description]) => ({
    value: describeExtensionProperty(key, 'Text', 'external', description),
  }));
  let existing: RdfProperty | undefined;
  schemas.value.items = schemas.value.items.filter(item => {
    const uri = textOf(childOf(item.value, PDFA_SCHEMA_NS, 'namespaceURI'));
    if (!uri || !xmpNamespaces.has(uri)) return true;
    const props = childOf(item.value, PDFA_SCHEMA_NS, 'property');
    if (props?.value.kind !== 'array' || props.value.form !== 'Seq') fail('invalid invoice extension property list');
    props.value.items = props.value.items.filter(p => !descriptions.has(textOf(childOf(p.value, PDFA_PROPERTY_NS, 'name')) ?? ''));
    if (uri === ns) {
      const binding = childOf(item.value, PDFA_SCHEMA_NS, 'prefix');
      if (!binding) fail('missing invoice extension prefix');
      binding.value = { kind: 'simple', value: prefix };
      existing = props;
      return true;
    }
    return props.value.items.length > 0 || !!childOf(item.value, PDFA_SCHEMA_NS, 'valueType');
  });
  if (existing?.value.kind === 'array') existing.value.items.push(...definitions);
  else schemas.value.items.push({ value: { kind: 'struct', fields: [
    property(PDFA_SCHEMA_NS, 'schema', (ns === fx ? 'Factur-X' : 'ZUGFeRD') + ' PDFA Extension Schema'),
    property(PDFA_SCHEMA_NS, 'namespaceURI', ns), property(PDFA_SCHEMA_NS, 'prefix', prefix),
    { ns: PDFA_SCHEMA_NS, name: 'property', value: { kind: 'array', form: 'Seq', items: definitions } },
  ] } });
  pinPdfaPrefixes(packet, new Map([...REQUIRED_PREFIX, [ns, prefix]]));
  return writeXmpPacket(packet);
}

function installInvoiceFile(doc: Document, old: PdfDict | undefined, xml: Uint8Array, filename: string, relationship: AFRelationship) {
  const catalog = doc.catalog();
  const af = doc.resolve(catalog.get('AF'));
  if (catalog.has('AF') && !isArray(af)) fail('catalog AF is not an array');
  const names = doc.resolve(catalog.get('Names')) ?? new Map<string, PdfObject>();
  if (!isDict(names)) fail('catalog Names is not a dictionary');
  const tree = names.get('EmbeddedFiles');
  if (tree !== undefined && !isDict(doc.resolve(tree))) fail('invalid EmbeddedFiles name tree');
  const entries = [...nameTreeEntries(doc, tree)].filter(([key, raw]) => {
    if (old && doc.resolve(raw) === old) return false;
    if (decodePdfByteString(key.bytes) === filename) fail('invoice filename collides with another name-tree entry');
    return true;
  });
  const spec = buildFilespec(xml, filename, { mimeType: 'text/xml', relationship }, o => doc.allocObject(o));
  const target = old ?? spec;
  if (old) for (const [key, value] of spec) old.set(key, value);
  const ref = old ? registerFilespec(doc, target) : doc.allocObject(target);
  if (old && isArray(af)) {
    let seen = false;
    let kept = 0;
    for (const entry of af) {
      if (doc.resolve(entry) === old) {
        if (seen) continue;
        seen = true;
      }
      af[kept++] = entry;
    }
    af.length = kept;
  }
  entries.push([{ kind: 'string', bytes: encodePdfByteString(filename) }, ref]);
  names.set('EmbeddedFiles', doc.allocObject(flatNameNode(entries)));
  if (!catalog.has('Names')) catalog.set('Names', names);
  addAssociatedFile(doc, ref);
}

/** Assemble on a private copy so parsing or serialization cannot leave a partial envelope. */
export function installHybridInvoice(doc: Document, xml: Uint8Array, options: HybridInvoiceOptions): void {
  const { profile, guidelineId, legacy } = invoiceProfile(parseNsXml(xml, doc.loadLimits, { completeDocument: true }));
  const { file, packet, namespace, claims } = locateInvoice(doc, true);
  if (file) decodeInvoice(doc, file, claims, namespace);
  // EN 16931 alone does not distinguish ZUGFeRD 2.0 from Factur-X. Keep the
  // existing generation when replacing that shared guideline.
  const zugferd2 = guidelineId.includes('urn:zugferd.de:2p0:') || (guidelineId === en && namespace === zf2);
  const ns = legacy ? zf1 : zugferd2 ? zf2 : fx;
  const filename = ns === zf1 ? 'ZUGFeRD-invoice.xml' : ns === zf2 ? 'zugferd-invoice.xml'
    : profile === 'XRECHNUNG' ? 'xrechnung.xml' : 'factur-x.xml';
  const metadata = invoiceMetadata(packet, ns, filename, profile);
  const partial = ns === fx && (profile === 'MINIMUM' || profile === 'BASIC WL');
  const relationship = options.relationship ?? (partial ? 'Data' : 'Alternative');
  if (!['Data', 'Source', 'Alternative'].includes(relationship)) throw new RangeError('invalid invoice XML relationship');
  installInvoiceFile(doc, file?.Dict, xml, filename, relationship);
  doc.installXmpText(metadata);
}
