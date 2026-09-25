import type { PdfRef } from './types.js';
import type { ValidationIssue } from './validation.js';
import type { RdfPacket, RdfProperty, RdfValue } from './xmprdf.js';
import { eraOf, isPredefinedProperty, valueTypesFor, isKnownValueType } from './xmpschemas.js';

/** PDF/A's rule that every XMP property is predefined or described
 *  (ISO 19005-1 6.7.8–6.7.9, -2/-3 6.6.2.3), transcribed from veraPDF
 *  (`o6uu.6`). Pure over `RdfPacket`s — `pdfavalidate.ts` supplies them — so
 *  every rule is drivable from hand-built packets. Part 4 has no such rule and
 *  never reaches here.
 *
 *  Two readings are veraPDF's and look wrong: a later schema entry for a
 *  namespace REPLACES an earlier one (its registry is a map), and "shall be
 *  present" is enforced by the PREFIX test, since every shape test passes an
 *  absent field. */

export const PDFA_EXTENSION_NS = 'http://www.aiim.org/pdfa/ns/extension/';
export const PDFA_SCHEMA_NS = 'http://www.aiim.org/pdfa/ns/schema#';
export const PDFA_PROPERTY_NS = 'http://www.aiim.org/pdfa/ns/property#';
export const PDFA_TYPE_NS = 'http://www.aiim.org/pdfa/ns/type#';
export const PDFA_FIELD_NS = 'http://www.aiim.org/pdfa/ns/field#';

export const REQUIRED_PREFIX: ReadonlyMap<string, string> = new Map([
  [PDFA_EXTENSION_NS, 'pdfaExtension'], [PDFA_SCHEMA_NS, 'pdfaSchema'],
  [PDFA_PROPERTY_NS, 'pdfaProperty'], [PDFA_TYPE_NS, 'pdfaType'], [PDFA_FIELD_NS, 'pdfaField'],
]);

const ALLOWED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [PDFA_SCHEMA_NS, new Set(['schema', 'namespaceURI', 'prefix', 'property', 'valueType'])],
  [PDFA_PROPERTY_NS, new Set(['name', 'valueType', 'category', 'description'])],
  [PDFA_TYPE_NS, new Set(['type', 'namespaceURI', 'prefix', 'description', 'field'])],
  [PDFA_FIELD_NS, new Set(['name', 'valueType', 'description'])],
]);

export type PdfaPart = 1 | 2 | 3;

/** One metadata stream's packet. `main` is the catalog's; `object` names an
 *  object-level stream so its issues can point at it. */
export interface PacketUnderTest { packet: RdfPacket; main: boolean; object?: PdfRef }

const fieldsOf = (v: RdfValue): RdfProperty[] => (v.kind === 'struct' ? v.fields : []);
export const childOf = (v: RdfValue, ns: string, name: string): RdfProperty | undefined =>
  fieldsOf(v).find((f) => f.ns === ns && f.name === name);
export const textOf = (p: RdfProperty | undefined): string | undefined =>
  (p?.value.kind === 'simple' ? p.value.value : undefined);
const itemsOf = (v: RdfValue | undefined): RdfValue[] => (v?.kind === 'array' ? v.items.map((i) => i.value) : []);
/** XMPCore's `isArrayOrdered`, which an Alt satisfies too. */
const isOrdered = (v: RdfValue) => v.kind === 'array' && v.form !== 'Bag';

/** The `pdfaExtension:schemas` property. veraPDF lists it apart from the
 *  packet's properties, so it is never itself "undescribed". */
export function extensionContainer(packet: RdfPacket): RdfProperty | undefined {
  return packet.properties.find((p) => p.ns === PDFA_EXTENSION_NS && p.name === 'schemas');
}

/** Namespace → the property names a packet describes, by veraPDF's
 *  registration: a schema needs a simple `namespaceURI` and an array
 *  `property`; a property needs a simple `name` and `valueType`. A later
 *  entry for a namespace REPLACES an earlier one. */
export function describedProperties(packet: RdfPacket): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const c = extensionContainer(packet);
  if (c === undefined || c.value.kind !== 'array') return out;
  for (const schema of itemsOf(c.value)) {
    const ns = textOf(childOf(schema, PDFA_SCHEMA_NS, 'namespaceURI'));
    const props = childOf(schema, PDFA_SCHEMA_NS, 'property');
    if (ns === undefined || props === undefined || props.value.kind !== 'array') continue;
    const names = new Set<string>();
    for (const p of itemsOf(props.value)) {
      const name = textOf(childOf(p, PDFA_PROPERTY_NS, 'name'));
      if (name !== undefined && textOf(childOf(p, PDFA_PROPERTY_NS, 'valueType')) !== undefined) names.add(name);
    }
    out.set(ns, names);
  }
  return out;
}

/** Top-level properties neither predefined for `part` nor described — by this
 *  packet, or at parts 2–3 by the catalog's (`main`). */
export function undescribedProperties(packet: RdfPacket, part: PdfaPart, main?: RdfPacket): RdfProperty[] {
  const era = eraOf(part);
  const own = describedProperties(packet);
  const fromMain = part === 1 || main === undefined ? new Map<string, Set<string>>() : describedProperties(main);
  return packet.properties.filter((p) =>
    !(p.ns === PDFA_EXTENSION_NS && p.name === 'schemas')
    && !isPredefinedProperty(p.ns, p.name, era)
    && !own.get(p.ns)?.has(p.name)
    && !fromMain.get(p.ns)?.has(p.name));
}

export const clause = (part: PdfaPart, one: string, twoThree: string) => `ISO 19005-${part} §${part === 1 ? one : twoThree}`;

/** The type names a schema declares in its own `valueType` Seq. A type with
 *  fields registers only when it also states a `namespaceURI`. */
function localTypes(vts: RdfValue | undefined): string[] {
  const out: string[] = [];
  for (const vt of itemsOf(vts)) {
    const name = textOf(childOf(vt, PDFA_TYPE_NS, 'type'));
    if (name === undefined) continue;
    const fields = childOf(vt, PDFA_TYPE_NS, 'field');
    const hasFields = fields !== undefined && fields.value.kind === 'array' && fields.value.items.length > 0;
    if (!hasFields || textOf(childOf(vt, PDFA_TYPE_NS, 'namespaceURI')) !== undefined) out.push(name);
  }
  return out;
}

/** Namespace → the value types its REGISTERED schema declares, the last
 *  registering entry winning as in `describedProperties`. An object packet at
 *  parts 2–3 starts each schema from the catalog packet's container for that
 *  namespace (`extendSchemasDefinitionForPDFA_2_3` passes `oldValidators`), so
 *  a type the catalog declares is known there too (`o6uu.11`). */
function declaredTypes(packet: RdfPacket): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const c = extensionContainer(packet);
  if (c === undefined || c.value.kind !== 'array') return out;
  for (const schema of itemsOf(c.value)) {
    const ns = textOf(childOf(schema, PDFA_SCHEMA_NS, 'namespaceURI'));
    const props = childOf(schema, PDFA_SCHEMA_NS, 'property');
    if (ns === undefined || props === undefined || props.value.kind !== 'array') continue;
    const vts = childOf(schema, PDFA_SCHEMA_NS, 'valueType');
    out.set(ns, vts !== undefined && vts.value.kind === 'array' ? localTypes(vts.value) : []);
  }
  return out;
}

function structureIssues(t: PacketUnderTest, part: PdfaPart, main?: RdfPacket): ValidationIssue[] {
  const c = extensionContainer(t.packet);
  if (c === undefined) return [];
  const out: ValidationIssue[] = [];
  const at = t.object !== undefined ? { object: t.object } : {};
  const structCl = clause(part, '6.7.8', '6.6.2.3.3');
  const issue = (rule: string, cl: string, message: string) => { out.push({ rule, severity: 'error', clause: cl, message, ...at }); };
  // One prefix per namespace: the model keeps the source's FIRST binding,
  // where veraPDF reads each element's own — a stated divergence.
  const prefixOk = (ns: string) => t.packet.prefixes.get(ns) === REQUIRED_PREFIX.get(ns);

  if (!(c.value.kind === 'array' && c.value.form === 'Bag') || !prefixOk(PDFA_EXTENSION_NS))
    issue('XmpExtensionContainer', structCl, 'pdfaExtension:schemas must be an rdf:Bag written with the prefix pdfaExtension.');
  if (c.value.kind !== 'array') return out;

  const undefinedFields = (v: RdfValue, ns: string, what: string) => {
    const allowed = ALLOWED.get(ns)!;
    const bad = fieldsOf(v).filter((f) => f.ns !== ns || !allowed.has(f.name));
    if (bad.length) issue('XmpExtensionUndefinedField', clause(part, '6.7.8', '6.6.2.3.2'),
      `${what} carries fields outside ${REQUIRED_PREFIX.get(ns)}: ${bad.map((f) => `${f.name} (${f.ns})`).join(', ')}.`);
  };
  /** A required simple field; returns its text when it has one. */
  const textField = (v: RdfValue, ns: string, name: string, what: string): string | undefined => {
    const f = childOf(v, ns, name);
    const pre = REQUIRED_PREFIX.get(ns)!;
    if (f === undefined) issue('XmpExtensionField', structCl, `${what} has no ${pre}:${name}.`);
    else if (f.value.kind !== 'simple') issue('XmpExtensionField', structCl, `${what}'s ${pre}:${name} must be a simple value.`);
    else if (!prefixOk(ns)) issue('XmpExtensionField', structCl, `${what}'s ${name} must be written with the prefix ${pre}.`);
    return textOf(f);
  };
  /** An optional Seq field: absent, or ordered and correctly prefixed. */
  const seqField = (v: RdfValue, ns: string, name: string, what: string): RdfProperty | undefined => {
    const f = childOf(v, ns, name);
    if (f === undefined) return undefined;
    const pre = REQUIRED_PREFIX.get(ns)!;
    if (!isOrdered(f.value)) issue('XmpExtensionField', structCl, `${what}'s ${pre}:${name} must be an rdf:Seq.`);
    else if (!prefixOk(ns)) issue('XmpExtensionField', structCl, `${what}'s ${name} must be written with the prefix ${pre}.`);
    return f;
  };
  const checkType = (vt: string | undefined, known: ReadonlySet<string>, what: string) => {
    if (vt !== undefined && !isKnownValueType(vt, known))
      issue('XmpExtensionValueType', structCl, `${what} names value type "${vt}", which is neither predefined nor declared by its schema.`);
  };

  const era = eraOf(part);
  const inherited = part === 1 || main === undefined ? new Map<string, string[]>() : declaredTypes(main);
  c.value.items.forEach((item, i) => {
    const s = item.value;
    const ns = textOf(childOf(s, PDFA_SCHEMA_NS, 'namespaceURI'));
    const what = `Extension schema ${ns ?? `#${i + 1}`}`;
    undefinedFields(s, PDFA_SCHEMA_NS, what);
    for (const n of ['schema', 'namespaceURI', 'prefix']) textField(s, PDFA_SCHEMA_NS, n, what);
    const props = seqField(s, PDFA_SCHEMA_NS, 'property', what);
    const vts = seqField(s, PDFA_SCHEMA_NS, 'valueType', what);
    const registered = ns !== undefined && props !== undefined && props.value.kind === 'array';
    const known = registered
      ? valueTypesFor(era, [...(inherited.get(ns) ?? []), ...localTypes(vts?.value)])
      : valueTypesFor(undefined);

    for (const p of itemsOf(props?.value)) {
      const pw = `Property ${textOf(childOf(p, PDFA_PROPERTY_NS, 'name')) ?? '(unnamed)'} of ${what}`;
      undefinedFields(p, PDFA_PROPERTY_NS, pw);
      textField(p, PDFA_PROPERTY_NS, 'name', pw);
      checkType(textField(p, PDFA_PROPERTY_NS, 'valueType', pw), known, pw);
      const cat = textField(p, PDFA_PROPERTY_NS, 'category', pw);
      if (cat !== undefined && cat !== 'internal' && cat !== 'external')
        issue('XmpExtensionField', structCl, `${pw} has category "${cat}"; it must be internal or external.`);
      textField(p, PDFA_PROPERTY_NS, 'description', pw);
    }
    for (const vt of itemsOf(vts?.value)) {
      const tw = `Value type ${textOf(childOf(vt, PDFA_TYPE_NS, 'type')) ?? '(unnamed)'} of ${what}`;
      undefinedFields(vt, PDFA_TYPE_NS, tw);
      for (const n of ['type', 'namespaceURI', 'prefix', 'description']) textField(vt, PDFA_TYPE_NS, n, tw);
      const fields = seqField(vt, PDFA_TYPE_NS, 'field', tw);
      for (const f of itemsOf(fields?.value)) {
        const fw = `Field ${textOf(childOf(f, PDFA_FIELD_NS, 'name')) ?? '(unnamed)'} of ${tw}`;
        undefinedFields(f, PDFA_FIELD_NS, fw);
        textField(f, PDFA_FIELD_NS, 'name', fw);
        checkType(textField(f, PDFA_FIELD_NS, 'valueType', fw), known, fw);
        textField(f, PDFA_FIELD_NS, 'description', fw);
      }
    }
  });
  return out;
}

/** Every issue for these packets at `part`. */
export function extensionSchemaIssues(packets: readonly PacketUnderTest[], part: PdfaPart): ValidationIssue[] {
  const main = packets.find((t) => t.main)?.packet;
  const out: ValidationIssue[] = [];
  for (const t of packets) {
    for (const p of undescribedProperties(t.packet, part, t.main ? undefined : main)) {
      out.push({
        rule: 'XmpPropertyNotDescribed', severity: 'error', clause: clause(part, '6.7.9', '6.6.2.3.1'),
        message: `XMP property ${t.packet.prefixes.get(p.ns) ?? p.ns}:${p.name} is neither predefined for PDF/A-${part} `
          + 'nor described in pdfaExtension:schemas.',
        ...(t.object !== undefined ? { object: t.object } : {}),
      });
    }
    out.push(...structureIssues(t, part, t.main ? undefined : main));
  }
  return out;
}
