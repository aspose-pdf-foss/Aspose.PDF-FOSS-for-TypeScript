import type { RdfPacket, RdfValue } from './xmprdf.js';
import { langMatches } from './langmatch.js';
import { isoInstant } from './pdfdate.js';

/** One XMP property value, read through the XMP value types (`o6uu.4`).
 *
 *  A view over the `xmprdf.ts` model, which already holds every value —
 *  simple values, URIs, Alt/Seq/Bag arrays, structs and qualifiers. Every
 *  converter is LENIENT: a value that does not read as the type asked for is
 *  `undefined`, never a throw, the posture `GetXmp` takes for a packet a
 *  producer wrote. Read-only; writing is `o6uu.8`. */
export class XmpValue {
  constructor(readonly raw: RdfValue) {}

  /** The text of a simple, non-URI value. For a language alternative, the
   *  item whose tag equals `lang` (case-insensitive), else the first whose tag
   *  matches `lang` as an RFC 4647 range, else `x-default`, else the first. */
  asText(lang?: string): string | undefined {
    const r = this.raw;
    if (r.kind === 'simple') return r.uri ? undefined : r.value;
    if (r.kind !== 'array' || r.form !== 'Alt' || r.items.length === 0) return undefined;
    const tagOf = (i: number) => r.items[i].lang ?? '';
    let pick = -1;
    if (lang !== undefined) {
      pick = r.items.findIndex((_, i) => tagOf(i).toLowerCase() === lang.toLowerCase());
      if (pick < 0) pick = r.items.findIndex((_, i) => langMatches(tagOf(i), lang));
    }
    if (pick < 0) pick = r.items.findIndex((_, i) => tagOf(i).toLowerCase() === 'x-default');
    if (pick < 0) pick = 0;
    const item = r.items[pick].value;
    return item.kind === 'simple' && !item.uri ? item.value : undefined;
  }

  /** An XMP date: the ISO text as written beside the instant it names. A time
   *  with no zone designator is read as UTC. */
  asDate(): { iso: string; date: Date } | undefined {
    const t = this.scalar();
    if (t === undefined) return undefined;
    const ms = isoInstant(t);
    return ms === undefined ? undefined : { iso: t, date: new Date(ms) };
  }

  /** XMP spells a Boolean `True` / `False`; case is not significant here. */
  asBool(): boolean | undefined {
    const t = this.scalar();
    if (t === undefined) return undefined;
    if (/^true$/i.test(t)) return true;
    if (/^false$/i.test(t)) return false;
    return undefined;
  }

  asInt(): number | undefined {
    const t = this.scalar();
    if (t === undefined || !/^[+-]?\d+$/.test(t)) return undefined;
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : undefined;
  }

  /** A decimal real; no exponent, `NaN` or `Infinity` — those are
   *  JavaScript's spellings, not XMP's. */
  asReal(): number | undefined {
    const t = this.scalar();
    if (t === undefined || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return undefined;
    return Number(t);
  }

  /** A URI value — written `rdf:resource`, not a string that looks like one. */
  asUri(): string | undefined {
    return this.raw.kind === 'simple' && this.raw.uri ? this.raw.value : undefined;
  }

  /** The items of a Seq, Bag or Alt. */
  asArray(): XmpValue[] | undefined {
    return this.raw.kind === 'array' ? this.raw.items.map((i) => new XmpValue(i.value)) : undefined;
  }

  private scalar(): string | undefined {
    return this.raw.kind === 'simple' && !this.raw.uri ? this.raw.value : undefined;
  }
}

/** The top-level property `(namespaceUri, name)` of `packet`, or `undefined`. */
export function findXmpValue(packet: RdfPacket, namespaceUri: string, name: string): XmpValue | undefined {
  const p = packet.properties.find((q) => q.ns === namespaceUri && q.name === name);
  return p === undefined ? undefined : new XmpValue(p.value);
}
