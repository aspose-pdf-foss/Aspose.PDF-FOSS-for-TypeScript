import type { Document } from './document.js';
import { isSignatureDict, streamCryptFilter } from './crypto.js';
import { PdfParseError, UnsupportedFeatureError } from './errors.js';
import { inflateStream } from './flate.js';
import { decodePdfText } from './metadata.js';
import { INFO_XMP_FIELDS, infoSide, planSync } from './metasync.js';
import { isArray, isDict, isName, isRef, isStream, isString, type PdfDict, type PdfObject } from './types.js';
import { applyXmpUpdate, claimPrefix, NS, writeXmpPacket, type XmpUpdate } from './xmp.js';
import { isXmlNcName, parseRdfPacket, stripNonXmlChars, type RdfPacket } from './xmprdf.js';

export interface DocumentId {
  readonly original: string;
  readonly modified: string;
}

export type Pdf20MigrationChange =
  | { kind: 'version'; from: string; to: '2.0' }
  | { kind: 'metadata'; key: string; namespace: string; property: string; action: 'copied' | 'kept-existing' }
  | { kind: 'remove'; key: string; path: string };

export interface Pdf20MigrationReport {
  previousVersion: string;
  version: '2.0';
  changes: Pdf20MigrationChange[];
}

const PDFX_CUSTOM = 'http://ns.adobe.com/pdfx/1.3/';
const DATE_KEYS = new Set(['CreationDate', 'ModDate']);
const SHARED_KEYS = new Set(INFO_XMP_FIELDS.map(([, key]) => key));
const RIGHTS_KEYS = new Set(['UR', 'UR3']);

function readPacket(doc: Document, catalog: PdfDict): RdfPacket {
  if (!catalog.has('Metadata')) return { properties: [], prefixes: new Map() };
  const stream = doc.resolve(catalog.get('Metadata'));
  if (!isStream(stream)) throw new PdfParseError('ConvertToPdf20: catalog /Metadata is not a stream');
  return parseRdfPacket(inflateStream(stream), doc.loadLimits);
}

interface RetainedEncryption { filters: PdfDict; stream: string }

function hasIndirectEntries(value: PdfObject): boolean {
  if (isRef(value)) return true;
  if (isArray(value)) return value.some(hasIndirectEntries);
  return isDict(value) && [...value.values()].some(hasIndirectEntries);
}

function checkEncryption(encrypt: PdfDict | undefined): RetainedEncryption | undefined {
  if (!encrypt) return undefined;
  const filter = encrypt.get('Filter');
  const revision = encrypt.get('R');
  const cf = encrypt.get('CF');
  const stream = encrypt.get('StmF');
  const embedded = encrypt.get('EFF');
  const modernHandler = isName(filter) && (filter.name === 'Adobe.PubSec'
    || (filter.name === 'Standard' && revision === 6));
  const supportedFilter = (active: PdfObject | undefined): boolean =>
    isName(active) && (active.name === 'Identity' || (isDict(cf) && cf.has(active.name)));
  if (modernHandler && encrypt.get('V') === 5 && isDict(cf) && isName(stream)
    && supportedFilter(stream) && supportedFilter(encrypt.get('StrF'))
    && (embedded === undefined || (isName(embedded) && embedded.name === stream.name))
    && [...cf.values()].every((entry) => {
      const method = isDict(entry) ? entry.get('CFM') : undefined;
      return isName(method) && method.name === 'AESV3';
    }) && !hasIndirectEntries(encrypt)) {
    return { filters: cf, stream: stream.name };
  }
  throw new UnsupportedFeatureError(
    'ConvertToPdf20: unsupported retained encryption. Save and reopen with AES-256 or plaintext before migration',
  );
}

function checkClaims(doc: Document, packet: RdfPacket, info: PdfDict | undefined): boolean {
  const xmp = (ns: string, key: string): string | undefined => {
    const v = packet.properties.find((p) => p.ns === ns && p.name === key)?.value;
    return v?.kind === 'simple' && !v.uri ? v.value.trim() : undefined;
  };
  const pdfaPart = xmp(NS.pdfaid, 'part');
  if (pdfaPart !== undefined && pdfaPart !== '4') throw new UnsupportedFeatureError(
    `ConvertToPdf20: PDF/A-${pdfaPart} is incompatible with this migration. Choose a PDF/A-4 conversion.`,
  );
  const pdfuaPart = xmp(NS.pdfuaid, 'part');
  if (pdfuaPart !== undefined && pdfuaPart !== '2') throw new UnsupportedFeatureError(
    `ConvertToPdf20: PDF/UA-${pdfuaPart} is incompatible with this migration. Choose a PDF/UA-2 conversion.`,
  );
  const printClaims = [xmp(NS.pdfxid, 'GTS_PDFXVersion')];
  for (const key of ['GTS_PDFXVersion', 'GTS_PDFXConformance']) {
    const value = doc.resolve(info?.get(key));
    if (isString(value)) printClaims.push(decodePdfText(value.bytes).trim());
  }
  const incompatible = printClaims.find((claim) => claim && !/^PDF\/X-6(?:[pn])?(?:\b|$)/i.test(claim));
  if (incompatible) throw new UnsupportedFeatureError(`ConvertToPdf20: incompatible PDF/X identification (${incompatible})`);
  return pdfaPart === '4';
}

function customProperty(key: string): string {
  if (isXmlNcName(key)) return key;
  const name = key.replace(/[^A-Za-z0-9_.-]/g, '_');
  return /^[A-Za-z_]/.test(name) ? name : `_${name}`;
}

function planMetadata(doc: Document, info: PdfDict, packet: RdfPacket, keep: ReadonlySet<string>,
  changes: Pdf20MigrationChange[]): string | undefined {
  const has = (ns: string, name: string) => packet.properties.some((p) => p.ns === ns && p.name === name);
  const addChange = (key: string, namespace: string, property: string, existing: boolean) => {
    changes.push({ kind: 'metadata', key, namespace, property, action: existing ? 'kept-existing' : 'copied' });
  };
  const assertText = (key: string, text: string): void => {
    if (stripNonXmlChars(text) !== text)
      throw new UnsupportedFeatureError(`ConvertToPdf20: /Info /${key} contains text that XMP cannot represent`);
  };
  const input = infoSide(info, (obj) => doc.resolve(obj));
  const defaults = planSync(input, {}, 'infoToXmp').xmp;
  const update: XmpUpdate = {};
  for (const [field, key, xkey, ns, property] of INFO_XMP_FIELDS) {
    if (!info.has(key)) continue;
    const existing = has(ns, property);
    if (existing) {
      if (!keep.has(key)) addChange(key, ns, property, true);
      continue;
    }
    if (defaults[xkey] === undefined) {
      if (keep.has(key)) continue;
      throw new UnsupportedFeatureError(`ConvertToPdf20: /Info /${key} cannot be represented in XMP`);
    }
    const value = input[field];
    if (typeof value === 'string') assertText(key, value);
    (update as Record<string, unknown>)[xkey] = defaults[xkey];
    addChange(key, ns, property, false);
  }
  applyXmpUpdate(packet, update, undefined);

  const customNames = new Set<string>();
  for (const [key, raw] of info) {
    if (SHARED_KEYS.has(key)) continue;
    const ns = key === 'Trapped' ? NS.pdf : key === 'GTS_PDFXVersion' ? NS.pdfxid : PDFX_CUSTOM;
    const property = customProperty(key);
    if (ns === PDFX_CUSTOM) {
      if (customNames.has(property)) throw new UnsupportedFeatureError(
        `ConvertToPdf20: /Info /${key} maps to a duplicate XMP property ${property}`,
      );
      customNames.add(property);
    }
    const existing = has(ns, property);
    addChange(key, ns, property, existing);
    if (existing) continue;
    const value = doc.resolve(raw);
    const text = isString(value) ? decodePdfText(value.bytes) : key === 'Trapped' && isName(value) ? value.name : undefined;
    if (text === undefined) throw new UnsupportedFeatureError(`ConvertToPdf20: /Info /${key} cannot be represented in XMP`);
    assertText(key, text);
    if (ns === PDFX_CUSTOM && !packet.prefixes.has(ns)) claimPrefix(packet, ns, 'pdfx');
    packet.properties.push({ ns, name: property, value: { kind: 'simple', value: text } });
  }
  return changes.some((c) => c.kind === 'metadata' && c.action === 'copied') ? writeXmpPacket(packet) : undefined;
}

interface Removal { dict: PdfDict; key: string; path: string }

/** Plan removals anywhere the full writer would retain, including resources
 *  inside forms and font dictionaries. Track resolved objects once on cycles. */
function planRemovals(doc: Document, catalog: PdfDict, encryption: RetainedEncryption | undefined): Removal[] {
  const removals: Removal[] = [];
  const planned = new Map<PdfDict, Set<string>>();
  const remove = (obj: PdfObject, key: string, parent: string): void => {
    if (!isDict(obj) || !obj.has(key)) return;
    let keys = planned.get(obj);
    if (keys === undefined) planned.set(obj, keys = new Set());
    if (keys.has(key)) return;
    keys.add(key);
    removals.push({ dict: obj, key, path: `${parent}/${key}` });
  };
  const perms = doc.resolve(catalog.get('Perms'));
  if (isDict(perms)) {
    if (perms.has('DocMDP')) throw new UnsupportedFeatureError('ConvertToPdf20: rewriting a certified document invalidates its signature');
    for (const key of RIGHTS_KEYS) remove(perms, key, '/Root/Perms');
    if ([...perms.keys()].every((key) => RIGHTS_KEYS.has(key))) remove(catalog, 'Perms', '/Root');
  }
  remove(doc.resolve(catalog.get('MarkInfo')), 'Suspects', '/Root/MarkInfo');
  const form = doc.resolve(catalog.get('AcroForm'));
  if (isDict(form)) remove(doc.resolve(form.get('DR')), 'ProcSet', '/Root/AcroForm/DR');

  const seen = new Set<PdfObject>();
  const pending: { object: PdfObject; path: string }[] = [{ object: catalog, path: '/Root' }];
  while (pending.length > 0) {
    const { object, path } = pending.pop()!;
    const value = doc.resolve(object);
    const dict = isStream(value) ? value.dict : value;
    if ((!isDict(dict) && !isArray(dict)) || seen.has(dict)) continue;
    seen.add(dict);
    const at = isRef(object) ? `${object.num} ${object.gen} R` : path;
    if (encryption && isStream(value)) {
      const selected = streamCryptFilter(value.dict, (obj) => doc.resolve(obj));
      const written = streamCryptFilter(value.dict, (obj) => obj ?? null);
      if (selected !== written || (selected !== undefined && selected !== 'Identity'
        && (!encryption.filters.has(selected) || encryption.stream === 'Identity')))
        throw new UnsupportedFeatureError(`ConvertToPdf20: unsupported retained encryption filter at ${at}`);
    }
    if (isArray(dict)) {
      dict.forEach((item, i) => pending.push({ object: item, path: `${at}[${i}]` }));
      continue;
    }
    // A value dictionary being filled by a pending signer has no byte range
    // yet. Empty signature fields have no value dictionary.
    if (isSignatureDict(dict))
      throw new UnsupportedFeatureError('ConvertToPdf20: rewriting a signed or timestamped document invalidates its signature');
    const type = doc.resolve(dict.get('Type'));
    if (dict.has('Resources')) {
      const subtype = doc.resolve(dict.get('Subtype'));
      const page = isName(type) && (type.name === 'Page' || type.name === 'Pages');
      const type3 = isName(subtype) && subtype.name === 'Type3';
      const formOrPattern = isStream(value) && ((isName(subtype) && subtype.name === 'Form')
        || doc.resolve(dict.get('PatternType')) === 1);
      if (page || type3 || formOrPattern) remove(doc.resolve(dict.get('Resources')), 'ProcSet', `${at}/Resources`);
    }
    if (isName(type) && type.name === 'FontDescriptor') {
      remove(dict, 'CharSet', at);
      remove(dict, 'CIDSet', at);
    }
    for (const [key, item] of dict) {
      if (!planned.get(dict)?.has(key)) pending.push({ object: item, path: `${at}/${key}` });
    }
  }
  return removals;
}

/** Validate and plan before editing live dictionaries. The facade sets the
 *  requested header after this returns so refusals keep the old version. */
export function migratePdf20(doc: Document, encrypt: PdfDict | undefined): Pdf20MigrationChange[] {
  const catalog = doc.catalog();
  const encryption = checkEncryption(encrypt);
  const originalInfo = doc.resolve(doc.trailer.get('Info'));
  if (doc.trailer.has('Info') && !isDict(originalInfo))
    throw new PdfParseError('ConvertToPdf20: trailer /Info is not a dictionary');
  const info = isDict(originalInfo) ? originalInfo : undefined;
  const packet = readPacket(doc, catalog);
  const pdfa4 = checkClaims(doc, packet, info);
  const removals = planRemovals(doc, catalog, encryption);
  const changes: Pdf20MigrationChange[] = [];
  const keep = pdfa4 ? new Set(catalog.has('PieceInfo') ? ['ModDate'] : []) : DATE_KEYS;
  const text = info ? planMetadata(doc, info, packet, keep, changes) : undefined;
  if (info) {
    for (const key of info.keys()) if (!keep.has(key)) removals.push({ dict: info, key, path: `/Info/${key}` });
    if (![...info.keys()].some((key) => keep.has(key)))
      removals.push({ dict: doc.trailer, key: 'Info', path: '/Info' });
  }

  if (text !== undefined) doc.installXmpText(text);
  for (const { dict, key, path } of removals) {
    if (dict.delete(key)) changes.push({ kind: 'remove', key, path });
  }
  return changes;
}
