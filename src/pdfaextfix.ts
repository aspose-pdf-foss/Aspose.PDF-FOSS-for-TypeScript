import type { Document } from './document.js';
import type { ConvertAction } from './conversion.js';
import { isStream, isRef, name, type PdfDict, type PdfObject, type PdfRef } from './types.js';
import { metadataStreams } from './validatectx.js';
import { typeMismatches, repairProperty } from './pdfavaluetypes.js';
import { inflateStream } from './flate.js';
import { parseRdfPacket, type RdfPacket, type RdfProperty } from './xmprdf.js';
import { writeXmpPacket } from './xmp.js';
import { rethrowLimit } from './errors.js';
import {
  undescribedProperties, extensionContainer, childOf, textOf, REQUIRED_PREFIX, type PdfaPart,
  PDFA_EXTENSION_NS, PDFA_SCHEMA_NS, PDFA_PROPERTY_NS,
} from './pdfaext.js';

/** Writing the extension-schema descriptions PDF/A needs (`o6uu.6`), for the
 *  properties whose type can be stated TRUTHFULLY: `pdfuaid` and `pdfxid`
 *  from their standards, and a simple non-URI value in any other namespace as
 *  `Text`. An array, a struct or a URI in an unknown namespace is left and
 *  stays reported — its type would be a guess. */

const PDFUA_NS = 'http://www.aiim.org/pdfua/ns/id/';
const PDFX_NS = 'http://www.npes.org/pdfx/ns/id/';

interface KnownSchema { schema: string; prefix: string; props: Record<string, { valueType: string; description: string }> }
const KNOWN: ReadonlyMap<string, KnownSchema> = new Map<string, KnownSchema>([
  [PDFUA_NS, { schema: 'PDF/UA Universal Accessibility Schema', prefix: 'pdfuaid', props: {
    part: { valueType: 'Integer', description: 'Indicates, which part of ISO 14289 standard is followed' },
    rev: { valueType: 'Integer', description: 'Indicates the year of the revision of the part of ISO 14289 that is followed' },
    amd: { valueType: 'Text', description: 'Optional: specifies amendment identifier' },
    corr: { valueType: 'Text', description: 'Optional: specifies corrigenda identifier' },
  } }],
  [PDFX_NS, { schema: 'PDF/X ID Schema', prefix: 'pdfxid', props: {
    GTS_PDFXVersion: { valueType: 'Text', description: 'ID of PDF/X standard' },
  } }],
]);

const simple = (ns: string, name: string, value: string): RdfProperty => ({ ns, name, value: { kind: 'simple', value } });

function describe(name: string, valueType: string, category: string, description: string): RdfProperty['value'] {
  return { kind: 'struct', fields: [
    simple(PDFA_PROPERTY_NS, 'name', name), simple(PDFA_PROPERTY_NS, 'valueType', valueType),
    simple(PDFA_PROPERTY_NS, 'category', category), simple(PDFA_PROPERTY_NS, 'description', description),
  ] };
}

/** Bind each PDF/A extension namespace to its required prefix, taking the
 *  prefix from any other namespace that holds it — the serializer prefers the
 *  model's binding, so without this a source's `ps:` is written back.
 *
 *  A foreign namespace displaced that way is re-bound to a fresh prefix
 *  HERE, and every description of it has its `pdfaSchema:prefix` rewritten to
 *  match (`o6uu.11`). Left to the serializer, the namespace was written under
 *  a generated prefix while its description still named the one it lost —
 *  including a description this pass had just written, which read the prefix
 *  before pinning. */
function pinPdfaPrefixes(packet: RdfPacket): void {
  const renamed = new Map<string, string>();
  for (const [ns, pre] of REQUIRED_PREFIX) {
    for (const [other, p] of [...packet.prefixes]) {
      if (p !== pre || other === ns) continue;
      packet.prefixes.delete(other);
      renamed.set(other, p);
    }
    packet.prefixes.set(ns, pre);
  }
  if (renamed.size === 0) return;
  const inUse = new Set(packet.prefixes.values());
  for (const [ns, old] of renamed) {
    let n = 1;
    while (inUse.has(`${old}${n}`) || REQUIRED_PREFIX_VALUES.has(`${old}${n}`)) n++;
    const fresh = `${old}${n}`;
    inUse.add(fresh);
    packet.prefixes.set(ns, fresh);
    renamed.set(ns, fresh);
  }
  const c = extensionContainer(packet);
  if (c === undefined || c.value.kind !== 'array') return;
  for (const item of c.value.items) {
    const s = item.value;
    const ns = textOf(childOf(s, PDFA_SCHEMA_NS, 'namespaceURI'));
    const fresh = ns === undefined ? undefined : renamed.get(ns);
    const pf = childOf(s, PDFA_SCHEMA_NS, 'prefix');
    if (fresh !== undefined && pf !== undefined && pf.value.kind === 'simple') pf.value = { kind: 'simple', value: fresh };
  }
}

const REQUIRED_PREFIX_VALUES: ReadonlySet<string> = new Set(REQUIRED_PREFIX.values());

/** Describe what can be described, in place. `added` and `left` are
 *  `prefix:name` labels. `main` is the catalog packet, for an object-level
 *  one at parts 2–3, whose descriptions it may borrow. */
export function addMissingDescriptions(packet: RdfPacket, part: PdfaPart, main?: RdfPacket): { added: string[]; left: string[] } {
  const label = (p: RdfProperty) => `${packet.prefixes.get(p.ns) ?? p.ns}:${p.name}`;
  const missing = undescribedProperties(packet, part, main);
  if (missing.length === 0) return { added: [], left: [] };
  let container = extensionContainer(packet);
  if (container !== undefined && !(container.value.kind === 'array' && container.value.form === 'Bag'))
    return { added: [], left: missing.map(label) };

  const plan = new Map<string, { prop: RdfProperty; desc: RdfProperty['value'] }[]>();
  const left: string[] = [];
  for (const p of missing) {
    const known = KNOWN.get(p.ns);
    const k = known?.props[p.name];
    let desc: RdfProperty['value'] | undefined;
    if (k !== undefined) desc = describe(p.name, k.valueType, 'internal', k.description);
    else if (known === undefined && p.value.kind === 'simple' && !p.value.uri)
      desc = describe(p.name, 'Text', 'external', 'Added by PDF/A conversion: the value is carried as Text.');
    if (desc === undefined) { left.push(label(p)); continue; }
    if (!plan.has(p.ns)) plan.set(p.ns, []);
    plan.get(p.ns)!.push({ prop: p, desc });
  }
  if (plan.size === 0) return { added: [], left };

  if (container === undefined) {
    container = { ns: PDFA_EXTENSION_NS, name: 'schemas', value: { kind: 'array', form: 'Bag', items: [] } };
    packet.properties.push(container);
  }
  const items = (container.value as Extract<RdfProperty['value'], { kind: 'array' }>).items;
  const added: string[] = [];
  for (const [ns, entries] of plan) {
    const descItems = entries.map((e) => ({ value: e.desc }));
    // veraPDF registers the LAST entry for a namespace, so that is the one to extend.
    let entry: (typeof items)[number] | undefined;
    for (let i = items.length - 1; i >= 0 && entry === undefined; i--)
      if (textOf(childOf(items[i].value, PDFA_SCHEMA_NS, 'namespaceURI')) === ns) entry = items[i];
    if (entry === undefined) {
      const known = KNOWN.get(ns);
      items.push({ value: { kind: 'struct', fields: [
        simple(PDFA_SCHEMA_NS, 'schema', known?.schema ?? `Properties in ${ns}`),
        simple(PDFA_SCHEMA_NS, 'namespaceURI', ns),
        simple(PDFA_SCHEMA_NS, 'prefix', known?.prefix ?? packet.prefixes.get(ns) ?? 'ns'),
        { ns: PDFA_SCHEMA_NS, name: 'property', value: { kind: 'array', form: 'Seq', items: descItems } },
      ] } });
    } else {
      const props = childOf(entry.value, PDFA_SCHEMA_NS, 'property');
      if (props === undefined && entry.value.kind === 'struct')
        entry.value.fields.push({ ns: PDFA_SCHEMA_NS, name: 'property', value: { kind: 'array', form: 'Seq', items: descItems } });
      else if (props !== undefined && props.value.kind === 'array') {
        // A Bag or Alt list registers but fails the Seq rule; extending it as
        // it stands would report the property added while the entry still
        // fails, so the list becomes the Seq PDF/A requires (`o6uu.11`).
        props.value = { ...props.value, form: 'Seq', items: [...props.value.items, ...descItems] };
      }
      else { left.push(...entries.map((e) => label(e.prop))); continue; }
    }
    added.push(...entries.map((e) => label(e.prop)));
  }
  if (added.length) pinPdfaPrefixes(packet);
  return { added, left };
}

interface ParsedPacket { ref: PdfRef; main: boolean; packet: RdfPacket }

/** Every reachable metadata packet that parses, the catalog's FIRST — an
 *  object packet resolves descriptions and types through it at parts 2–3, so
 *  it must be settled before they are read. A packet that will not parse is
 *  left alone: there is nothing safe to edit. */
function readPackets(doc: Document): ParsedPacket[] {
  const R = (o: PdfObject | undefined) => doc.resolve(o);
  const mainRef = doc.catalog().get('Metadata');
  const out: ParsedPacket[] = [];
  for (const [ref, s] of metadataStreams({ catalog: doc.catalog(), R })) {
    try {
      out.push({ ref, main: isRef(mainRef) && mainRef.num === ref.num, packet: parseRdfPacket(inflateStream(s), doc.loadLimits) });
    } catch (e) {
      rethrowLimit(e);
    }
  }
  return out.sort((a, b) => Number(b.main) - Number(a.main));
}

/** Write a packet back INTO the stream it came from (`o6uu.13`), keeping every
 *  entry the producer wrote except the ENCODING, which no longer describes
 *  the rewritten, uncompressed payload. In place rather than through
 *  `installXmpText`, which allocates a new stream and repoints only the
 *  catalog: a stream the catalog SHARES with a page would then leave the page
 *  naming the old, unrepaired packet. */
function writeBack(doc: Document, ref: PdfRef, packet: RdfPacket): void {
  const old = doc.resolve(ref);
  const dict: PdfDict = new Map(isStream(old) ? old.dict : []);
  for (const k of ['Filter', 'DecodeParms', 'Length', 'DL']) dict.delete(k);
  dict.set('Type', name('Metadata'));
  dict.set('Subtype', name('XML'));
  doc.replaceObject(ref.num, { kind: 'stream', dict, raw: new TextEncoder().encode(writeXmpPacket(packet)) });
}

/** Run `addMissingDescriptions` over EVERY reachable metadata packet and write
 *  each changed one back in place (`o6uu.13` — it covered the catalog's
 *  alone, so at part 1, where an object packet may not borrow the catalog's
 *  descriptions, a page's packet stayed undescribed). An object packet at
 *  parts 2–3 is checked against the catalog's descriptions, as the rule
 *  checks it, so nothing the catalog already describes is repeated. */
export function describeXmpPackets(doc: Document, part: PdfaPart): ConvertAction[] {
  const packets = readPackets(doc);
  const main = packets.find((p) => p.main)?.packet;
  const added: string[] = [];
  let repinned = false;
  for (const p of packets) {
    // A description can be complete and still fail on its PREFIXES alone; the
    // rewrite repairs that too, so it runs even when nothing is missing (a
    // final-review finding). A packet with no container needs no pinning.
    const repin = extensionContainer(p.packet) !== undefined
      && [...REQUIRED_PREFIX].some(([ns, pre]) => p.packet.prefixes.has(ns) && p.packet.prefixes.get(ns) !== pre);
    const r = addMissingDescriptions(p.packet, part, p.main ? undefined : main);
    if (r.added.length === 0 && !repin) continue;
    pinPdfaPrefixes(p.packet);
    writeBack(doc, p.ref, p.packet);
    added.push(...r.added);
    repinned ||= repin;
  }
  const actions: ConvertAction[] = [];
  if (added.length) actions.push({ rule: 'XmpPropertyNotDescribed', action: `Described ${added.join(', ')} in pdfaExtension:schemas.` });
  if (repinned) actions.push({ rule: 'XmpExtensionField', action: 'Rewrote pdfaExtension:schemas with the prefixes PDF/A requires.' });
  return actions;
}

/** Repair the XMP value-type mismatches `repairProperty` can (`o6uu.10`), in
 *  every reachable metadata packet, each written back into its own stream. */
export function repairXmpValueTypes(doc: Document, part: PdfaPart): ConvertAction[] {
  const packets = readPackets(doc);
  const main = packets.find((p) => p.main)?.packet;
  const actions: ConvertAction[] = [];
  for (const p of packets) {
    let changed = false;
    for (const m of typeMismatches(p.packet, part, p.main ? undefined : main)) {
      const fixed = repairProperty(m.property, m.type, m.registry);
      if (fixed === undefined) continue;
      p.packet.properties[p.packet.properties.indexOf(m.property)] = fixed;
      changed = true;
      actions.push({ rule: 'XmpValueType', action: `Rewrote ${p.packet.prefixes.get(m.property.ns) ?? m.property.ns}:${m.property.name} as ${m.type}.` });
    }
    if (changed) writeBack(doc, p.ref, p.packet);
  }
  return actions;
}
