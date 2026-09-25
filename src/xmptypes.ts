import type { RdfValue } from './xmprdf.js';
import {
  STRUCT_TYPES_2004, STRUCT_TYPES_2005, SIMPLE_PATTERNS_2004, SIMPLE_PATTERNS_2005,
} from './xmpschemadata.js';
import { simplifyValueType, type XmpEra } from './xmpschemas.js';

/** XMP value-type validation (`o6uu.10`): veraPDF's `ValidatorsContainer` with
 *  closed-choice checking OFF, which is how its validator runs. A pure leaf over
 *  the `xmprdf.ts` model and the generated tables; it never throws.
 *
 *  veraPDF's `isSimple` is `kind === 'simple'` (a URI included, qualifiers
 *  ignored); a struct's children are its `fields`. */

const PDFA_TYPE = 'http://www.aiim.org/pdfa/ns/type#';
const PDFA_FIELD = 'http://www.aiim.org/pdfa/ns/field#';
const ARRAYS = [['bag', 'Bag'], ['seq', 'Seq'], ['alt', 'Alt']] as const;

type Validator =
  | { kind: 'pattern'; re: RegExp }
  | { kind: 'date' } | { kind: 'langalt' } | { kind: 'simple' }
  | { kind: 'struct'; ns: string; fields: ReadonlyMap<string, string> };

/** A Java regex as a whole-value JavaScript one: `matches()` is anchored, and
 *  a leading `(?s)` is the `s` flag. */
function compile(src: string): RegExp {
  const dotAll = src.startsWith('(?s)');
  return new RegExp(`^(?:${dotAll ? src.slice(4) : src})$`, dotAll ? 's' : '');
}

const TEXT: Validator = { kind: 'pattern', re: compile('(?s)(^.*$)') };

function eraValidators(era: XmpEra): Map<string, Validator> {
  const out = new Map<string, Validator>([
    ['date', { kind: 'date' }], ['lang alt', { kind: 'langalt' }],
    ['uri', { kind: 'simple' }], ['url', { kind: 'simple' }], ['xpath', { kind: 'simple' }],
  ]);
  for (const [name, src] of Object.entries(era === '2004' ? SIMPLE_PATTERNS_2004 : SIMPLE_PATTERNS_2005))
    out.set(name, { kind: 'pattern', re: compile(src) });
  for (const [name, t] of Object.entries(era === '2004' ? STRUCT_TYPES_2004 : STRUCT_TYPES_2005))
    out.set(name, { kind: 'struct', ns: t.ns, fields: new Map(Object.entries(t.fields)) });
  return out;
}

const simpleText = (v: RdfValue | undefined): string | undefined => (v?.kind === 'simple' ? v.value : undefined);
const field = (v: RdfValue, ns: string, name: string): RdfValue | undefined =>
  v.kind === 'struct' ? v.fields.find((f) => f.ns === ns && f.name === name)?.value : undefined;

export class XmpTypeRegistry {
  private static readonly cache = new Map<XmpEra, XmpTypeRegistry>();
  private constructor(private readonly validators: ReadonlyMap<string, Validator>) {}

  /** The container a registered schema starts from in `era`. */
  static forEra(era: XmpEra): XmpTypeRegistry {
    let r = XmpTypeRegistry.cache.get(era);
    if (r === undefined) { r = new XmpTypeRegistry(eraValidators(era)); XmpTypeRegistry.cache.set(era, r); }
    return r;
  }

  /** A COPY extended by a schema's `pdfaSchema:valueType` array
   *  (`ValidatorsContainerCreator.registerTypeNode`): a type with fields and a
   *  namespace is a struct type, one with no fields is Text. */
  extend(valueTypes: RdfValue | undefined): XmpTypeRegistry {
    const out = new Map(this.validators);
    if (valueTypes?.kind === 'array') {
      for (const { value: vt } of valueTypes.items) {
        const name = simpleText(field(vt, PDFA_TYPE, 'type'));
        if (name === undefined) continue;
        const ns = simpleText(field(vt, PDFA_TYPE, 'namespaceURI'));
        const fieldsNode = field(vt, PDFA_TYPE, 'field');
        const fields = new Map<string, string>();
        if (fieldsNode?.kind === 'array') {
          for (const { value: f } of fieldsNode.items) {
            const n = simpleText(field(f, PDFA_FIELD, 'name'));
            const t = simpleText(field(f, PDFA_FIELD, 'valueType'));
            if (n !== undefined && t !== undefined) fields.set(n, t);
          }
        }
        if (fields.size === 0) out.set(simplifyValueType(name), TEXT);
        else if (ns !== undefined) out.set(simplifyValueType(name), { kind: 'struct', ns, fields });
      }
    }
    return new XmpTypeRegistry(out);
  }

  /** Every simplified type name this registry validates. */
  knownTypes(): string[] { return [...this.validators.keys()]; }

  /** veraPDF's `isKnownType`: simplify, peel array prefixes, look up. */
  isKnownType(type: string): boolean {
    let t = simplifyValueType(type);
    for (let peeled = true; peeled;) {
      peeled = false;
      for (const [a] of ARRAYS) if (t.startsWith(`${a} `)) { t = t.slice(a.length + 1); peeled = true; break; }
    }
    return this.validators.has(t);
  }

  /** veraPDF's `ValidatorsContainer.validate`. */
  validate(value: RdfValue, typeName: string): boolean {
    const type = simplifyValueType(typeName);
    if (type === 'any') return true;
    for (const [a, form] of ARRAYS) {
      if (type.startsWith(`${a} `)) {
        if (value.kind !== 'array' || value.form !== form) return false;
        const item = type.slice(a.length + 1);
        return value.items.every((i) => this.validate(i.value, item));
      }
    }
    const v = this.validators.get(type);
    return v !== undefined && this.check(value, v);
  }

  private check(value: RdfValue, v: Validator): boolean {
    switch (v.kind) {
      case 'pattern': return value.kind === 'simple' && v.re.test(value.value);
      case 'date': return value.kind === 'simple' && isXmpDate(value.value);
      case 'simple': return value.kind === 'simple';
      case 'langalt':
        return value.kind === 'array' && value.form === 'Alt'
          && (value.items.length === 0 || value.items.some((i) => i.lang !== undefined));
      case 'struct':
        return value.kind === 'struct' && value.fields.every((f) =>
          f.ns === v.ns && v.fields.has(f.name) && this.validate(f.value, v.fields.get(f.name)!));
    }
  }
}

/** XMPCore's `ISO8601Converter.parse`, as a predicate. Its `gatherInt` CLAMPS a
 *  number to its range rather than refusing it, so only the SHAPE can fail —
 *  `2024-13-40` is a valid date there, and so is the empty string. */
export function isXmpDate(s: string): boolean {
  if (s.length === 0) return true;
  let pos = 0;
  const has = () => pos < s.length;
  const ch = () => (pos < s.length ? s[pos] : '');
  const digits = (): boolean => { const start = pos; while (ch() >= '0' && ch() <= '9') pos++; return pos > start; };
  const isTz = (c: string) => c === 'Z' || c === '+' || c === '-';
  if (s[0] === '-') pos++;
  if (!digits()) return false;                                      // year
  if (has() && ch() !== '-') return false;
  if (!has()) return true;
  pos++;
  if (!digits()) return false;                                      // month
  if (has() && ch() !== '-') return false;
  if (!has()) return true;
  pos++;
  if (!digits()) return false;                                      // day
  if (has() && ch() !== 'T') return false;
  if (!has()) return true;
  pos++;
  if (!digits()) return false;                                      // hour
  if (!has()) return true;
  if (ch() === ':') {
    pos++;
    if (!digits()) return false;                                    // minute
    if (has() && ch() !== ':' && !isTz(ch())) return false;
  }
  if (!has()) return true;
  if (ch() === ':') {
    pos++;
    if (!digits()) return false;                                    // seconds
    if (has() && ch() !== '.' && !isTz(ch())) return false;
    if (ch() === '.') {
      pos++;
      if (!digits()) return false;                                  // fraction
      if (has() && !isTz(ch())) return false;
    }
  } else if (!isTz(ch())) return false;
  if (!has()) return true;
  if (ch() === 'Z') pos++;
  else {
    pos++;                                                          // + or -
    if (!digits()) return false;                                    // tz hour
    if (has()) {
      if (ch() !== ':') return false;
      pos++;
      if (!digits()) return false;                                  // tz minute
    }
  }
  return !has();
}
