import type { RdfPacket, RdfProperty, RdfValue } from './xmprdf.js';
import type { ValidationIssue } from './validation.js';
import { PROPERTY_TYPES_2004, PROPERTY_TYPES_2005 } from './xmpschemadata.js';
import { eraOf, simplifyValueType, type XmpEra } from './xmpschemas.js';
import { XmpTypeRegistry } from './xmptypes.js';
import {
  PDFA_EXTENSION_NS, PDFA_SCHEMA_NS, PDFA_PROPERTY_NS, extensionContainer, childOf, textOf, clause,
  type PacketUnderTest, type PdfaPart,
} from './pdfaext.js';

/** Every XMP property's VALUE matches its type (ISO 19005-1 6.7.9 test 3,
 *  -2/-3 6.6.2.3.1 test 2; `o6uu.10`) — veraPDF's `isValueTypeCorrect`.
 *  Pure over `RdfPacket`.
 *
 *  A property's type is the first found in: this packet's extension schemas;
 *  at parts 2–3 the catalog packet's; the era's predefined set
 *  (`AXLXMPProperty.getSchemasDefinition`). An extension schema therefore
 *  outranks a predefined type. A property with NO type is not reported here —
 *  `o6uu.6`'s rule already names it (a stated divergence: veraPDF's
 *  `null == true` reports it twice). */

export interface SchemaDef { registry: XmpTypeRegistry; types: Map<string, string> }

const itemsOf = (v: RdfValue | undefined): RdfValue[] => (v?.kind === 'array' ? v.items.map((i) => i.value) : []);
const isArray = (p: RdfProperty | undefined) => p?.value.kind === 'array';

/** veraPDF's `createExtendedSchemasDefinition`: namespace → its registry and
 *  property types. Each schema starts from `seed`'s registry for its namespace
 *  (the catalog packet's, for an object packet at parts 2–3) or a fresh era
 *  one, extended by its own `valueType`s. A registration naming an unknown
 *  type is dropped and the first per name wins; a later schema for a
 *  namespace REPLACES an earlier one. */
export function extensionDefinitions(packet: RdfPacket, era: XmpEra, seed?: ReadonlyMap<string, SchemaDef>): Map<string, SchemaDef> {
  const out = new Map<string, SchemaDef>();
  const c = extensionContainer(packet);
  if (c === undefined || c.value.kind !== 'array') return out;
  for (const schema of itemsOf(c.value)) {
    const ns = textOf(childOf(schema, PDFA_SCHEMA_NS, 'namespaceURI'));
    const props = childOf(schema, PDFA_SCHEMA_NS, 'property');
    if (ns === undefined || !isArray(props)) continue;
    const vts = childOf(schema, PDFA_SCHEMA_NS, 'valueType');
    const registry = (seed?.get(ns)?.registry ?? XmpTypeRegistry.forEra(era)).extend(isArray(vts) ? vts!.value : undefined);
    const types = new Map<string, string>();
    for (const p of itemsOf(props!.value)) {
      const n = textOf(childOf(p, PDFA_PROPERTY_NS, 'name'));
      const vt = textOf(childOf(p, PDFA_PROPERTY_NS, 'valueType'));
      if (n !== undefined && vt !== undefined && registry.isKnownType(vt) && !types.has(n)) types.set(n, vt);
    }
    out.set(ns, { registry, types });
  }
  return out;
}

const PREDEFINED = { '2004': PROPERTY_TYPES_2004, '2005': PROPERTY_TYPES_2005 } as const;

/** The predefined type, probed with `hasOwn`: names come from the document,
 *  and `constructor` must not find `Object.prototype`'s. */
function predefinedType(era: XmpEra, ns: string, name: string): string | undefined {
  const table = PREDEFINED[era];
  if (!Object.hasOwn(table, ns)) return undefined;
  return Object.hasOwn(table[ns], name) ? table[ns][name] : undefined;
}

export interface TypeMismatch { property: RdfProperty; type: string; registry: XmpTypeRegistry }

/** Top-level properties whose value does not match their resolved type. */
export function typeMismatches(packet: RdfPacket, part: PdfaPart, main?: RdfPacket): TypeMismatch[] {
  const era = eraOf(part);
  const mainDefs = part === 1 || main === undefined ? undefined : extensionDefinitions(main, era);
  const own = extensionDefinitions(packet, era, mainDefs);
  const out: TypeMismatch[] = [];
  for (const property of packet.properties) {
    if (property.ns === PDFA_EXTENSION_NS && property.name === 'schemas') continue;
    let resolved: { type: string; registry: XmpTypeRegistry } | undefined;
    for (const defs of [own, mainDefs]) {
      const d = defs?.get(property.ns);
      const type = d?.types.get(property.name);
      if (d !== undefined && type !== undefined) { resolved = { type, registry: d.registry }; break; }
    }
    if (resolved === undefined) {
      const type = predefinedType(era, property.ns, property.name);
      if (type !== undefined) resolved = { type, registry: XmpTypeRegistry.forEra(era) };
    }
    if (resolved !== undefined && !resolved.registry.validate(property.value, resolved.type))
      out.push({ property, ...resolved });
  }
  return out;
}

/** A type spelled for a reader, rebuilt from the SIMPLIFIED form by
 *  capitalising each word — `seq propername` shows as `Seq Propername`. The
 *  table's own capitalisation (`ProperName`) is not recoverable from it and is
 *  not kept. */
const shown = (type: string) => simplifyValueType(type).replace(/\b\w/g, (c) => c.toUpperCase());

/** Every `XmpValueType` issue for these packets at `part`. */
export function valueTypeIssues(packets: readonly PacketUnderTest[], part: PdfaPart): ValidationIssue[] {
  const main = packets.find((t) => t.main)?.packet;
  const out: ValidationIssue[] = [];
  for (const t of packets) {
    for (const m of typeMismatches(t.packet, part, t.main ? undefined : main)) {
      out.push({
        rule: 'XmpValueType', severity: 'error', clause: clause(part, '6.7.9', '6.6.2.3.1'),
        message: `XMP property ${t.packet.prefixes.get(m.property.ns) ?? m.property.ns}:${m.property.name} `
          + `does not match its type ${shown(m.type)}.`,
        ...(t.object !== undefined ? { object: t.object } : {}),
      });
    }
  }
  return out;
}

const FORMS = [['bag', 'Bag'], ['seq', 'Seq'], ['alt', 'Alt']] as const;

/** A lossless reshaping of `value` that satisfies `type`, or undefined. Tried
 *  in order and kept only if it VALIDATES: a simple value → the Lang Alt
 *  `x-default` item, or a one-item array of the expected form; Bag ↔ Seq,
 *  items in order; a one-item Bag/Seq → Alt. Nothing here invents or drops a
 *  value — anything else is the author's to fix. */
export function repairShape(value: RdfValue, type: string, registry: XmpTypeRegistry): RdfValue | undefined {
  const t = simplifyValueType(type);
  const candidates: RdfValue[] = [];
  if (t === 'lang alt' && value.kind === 'simple' && value.uri !== true)
    candidates.push({ kind: 'array', form: 'Alt', items: [{ value, lang: 'x-default' }] });
  for (const [a, form] of FORMS) {
    if (!t.startsWith(`${a} `)) continue;
    if (value.kind === 'simple') candidates.push({ kind: 'array', form, items: [{ value }] });
    else if (value.kind === 'array' && value.form !== form) {
      const swap = form !== 'Alt' ? value.form !== 'Alt' : value.items.length === 1;
      if (swap) candidates.push({ ...value, form });
    }
  }
  return candidates.find((c) => registry.validate(c, type));
}

/** `repairShape` at the PROPERTY level (`o6uu.13`): when a simple value is
 *  wrapped into an array item, what described that value moves with it — its
 *  qualifiers, and its language, which becomes the item's `xml:lang` in place
 *  of `x-default`. Left on the property they would describe the ARRAY: a
 *  `dc:title xml:lang="de"` would come out as a German-tagged Alt whose one
 *  item claims to be the default. A swap between array forms touches only the
 *  form. Returns a NEW property, or undefined when no repair validates. */
export function repairProperty(property: RdfProperty, type: string, registry: XmpTypeRegistry): RdfProperty | undefined {
  const fixed = repairShape(property.value, type, registry);
  if (fixed === undefined) return undefined;
  if (property.value.kind !== 'simple' || fixed.kind !== 'array') return { ...property, value: fixed };
  const { lang, qualifiers, ...rest } = property;
  const item = { ...fixed.items[0] };
  if (lang !== undefined) item.lang = lang;
  if (qualifiers?.length) item.qualifiers = qualifiers;
  return { ...rest, value: { ...fixed, items: [item] } };
}
