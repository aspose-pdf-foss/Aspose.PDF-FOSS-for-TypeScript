import {
  PREDEFINED_2004, PREDEFINED_2005, BASE_VALUE_TYPES, VALUE_TYPES_2004, VALUE_TYPES_2005,
} from './xmpschemadata.js';

/** The XMP properties and value types PDF/A treats as predefined (`o6uu.6`),
 *  over veraPDF's tables as `gen:xmpschemas` extracts them. A leaf.
 *
 *  Part 1 is XMP 2004 and parts 2–3 are XMP 2005; ISO 19005-4 has no such
 *  rule. The value-type rules are veraPDF's `getSimplifiedType` and
 *  `isKnownType` transcribed — note the three TIERS of known types: an
 *  unregistered schema (no `namespaceURI` or no `property` array) sees only
 *  `new ValidatorsContainer()`'s base set, a registered one sees its era's set
 *  plus the types its own `valueType` Seq declares. */

export type XmpEra = '2004' | '2005';

const index = (t: Readonly<Record<string, readonly string[]>>) =>
  new Map(Object.entries(t).map(([ns, names]) => [ns, new Set(names)] as const));
const PREDEFINED = { '2004': index(PREDEFINED_2004), '2005': index(PREDEFINED_2005) } as const;
const TYPES = { '2004': VALUE_TYPES_2004, '2005': VALUE_TYPES_2005 } as const;
const ARRAYS = ['bag', 'seq', 'alt'] as const;

export const eraOf = (part: 1 | 2 | 3): XmpEra => (part === 1 ? '2004' : '2005');

/** Is `(ns, name)` predefined for `era`? Keyed by PROPERTY, not namespace: a
 *  known namespace does not excuse an unknown property in it. */
export function isPredefinedProperty(ns: string, name: string, era: XmpEra): boolean {
  return PREDEFINED[era].get(ns)?.has(name) ?? false;
}

/** veraPDF's `getSimplifiedType`: lowercase, drop "open/closed choice of",
 *  treat a bare array name as an array of Text. */
export function simplifyValueType(type: string): string {
  let res = type.toLowerCase().replace(/(open |closed )?(choice |choice$)(of )?/g, '').trim();
  if (res === '') return 'text';
  if (res.endsWith('lang alt')) return res;
  for (const a of ARRAYS) if (res.endsWith(a)) { res += ' text'; break; }
  return res;
}

/** The type names a schema may use: `era` undefined is the base container. */
export function valueTypesFor(era: XmpEra | undefined, local: Iterable<string> = []): Set<string> {
  if (era === undefined) return new Set(BASE_VALUE_TYPES);
  const out = new Set(TYPES[era]);
  for (const t of local) out.add(simplifyValueType(t));
  return out;
}

/** veraPDF's `isKnownType`: simplify, then peel `bag `/`seq `/`alt ` prefixes. */
export function isKnownValueType(type: string, known: ReadonlySet<string>): boolean {
  let t = simplifyValueType(type);
  for (let peeled = true; peeled;) {
    peeled = false;
    for (const a of ARRAYS) if (t.startsWith(`${a} `)) { t = t.slice(a.length + 1); peeled = true; break; }
  }
  return known.has(t);
}
