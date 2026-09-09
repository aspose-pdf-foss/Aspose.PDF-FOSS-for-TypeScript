/**
 * `/AcroForm /XFA` decoded to named packets.
 *
 * `/XFA` is either a SINGLE stream holding a whole XDP document, or an ARRAY of
 * alternating name/stream pairs (`config`, `template`, `datasets`, and the
 * `preamble`/`postamble` fragments of the XDP wrapper). This module owns that
 * duality and nothing else does.
 *
 * **Invariant: it takes `resolve` and `inflate` as ARGUMENTS** rather than
 * importing `document.js` -- the seam `colorimage.ts` and `dfont.ts` already
 * use -- so every rule here is drivable from a hand-built dict.
 *
 * **Invariant: it owns the `parseXml` throw boundary.** `parseXml` throws
 * `PdfParseError` and four other callers depend on that strictness, so damage
 * becomes a value HERE rather than by loosening `xml.ts`. A damaged XFA packet
 * must cost the conversion, never the open.
 *
 * **Invariant: a per-packet failure costs that packet alone.** The XDP
 * wrapper's `preamble` and `postamble` are text fragments rather than elements,
 * so they NEVER parse and are skipped on every array-form document -- refusing
 * the whole `/XFA` for them would refuse every such file in existence.
 */
import { isArray, isName, isStream, isString, type PdfDict, type PdfObject } from './types.js';
import { parseXml, type XmlNode } from './xml.js';
import type { Inflate, Resolve } from './colorimage.js';
import { decodePdfText } from './metadata.js';

export interface XfaPacketSet {
  /** Parsed packets by local name. First wins on a duplicate. */
  packets: Map<string, XmlNode>;
  /** Every packet NAME the /XFA declared, in order, parsed or not. This is what
   *  the report's `packets` field carries: it says what the document holds. */
  names: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/** A packet name from a /XFA array entry: a name object or a string. */
function entryName(o: PdfObject): string | undefined {
  if (isName(o)) return o.name;
  if (isString(o)) return decodePdfText(o.bytes);
  return undefined;
}

/** Parse, or say why not. The one place `parseXml`'s throw is caught. */
function parse(bytes: Uint8Array): XmlNode | { reason: string } {
  try {
    return parseXml(bytes);
  } catch (e) {
    return { reason: e instanceof Error ? e.message : 'XML could not be parsed' };
  }
}

export function decodeXfaPackets(
  acro: PdfDict | undefined, resolve: Resolve, inflate: Inflate,
): XfaPacketSet | { reason: string } {
  if (!acro) return { reason: 'the document has no /AcroForm' };
  const xfa = resolve(acro.get('XFA'));

  const packets = new Map<string, XmlNode>();
  const names: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  const add = (name: string, node: XmlNode | { reason: string }): void => {
    names.push(name);
    if ('reason' in node) { skipped.push({ name, reason: node.reason }); return; }
    if (packets.has(name)) {
      skipped.push({ name, reason: `a second '${name}' packet; the first one is used` });
      return;
    }
    packets.set(name, node);
  };

  if (isStream(xfa)) {
    // One stream, one whole XDP. Its packets are the root's own children --
    // xml.ts strips the xfa: prefix, so <xfa:datasets> arrives as `datasets`.
    const root = parse(inflate(xfa));
    if ('reason' in root)
      return { reason: `the /XFA packet could not be parsed: ${root.reason}` };
    for (const c of root.children) add(c.name, c);
    if (packets.size === 0) return { reason: 'the /XFA packet declares no packets' };
    return { packets, names, skipped };
  }

  if (isArray(xfa)) {
    for (let i = 0; i + 1 < xfa.length; i += 2) {
      const name = entryName(resolve(xfa[i]));
      const s = resolve(xfa[i + 1]);
      if (name === undefined) continue;
      if (!isStream(s)) {
        names.push(name);
        skipped.push({ name, reason: 'the /XFA entry is not a stream' });
        continue;
      }
      add(name, parse(inflate(s)));
    }
    if (names.length === 0) return { reason: 'the /XFA array declares no packets' };
    return { packets, names, skipped };
  }

  return {
    reason: xfa === null || xfa === undefined
      ? 'the /AcroForm has no /XFA'
      : '/AcroForm /XFA is neither a stream nor an array',
  };
}
