import { describe, it, expect } from 'vitest';
import { decodeXfaPackets, type XfaPacketSet } from '../src/xfapacket.js';
import type { PdfDict, PdfObject, PdfStream } from '../src/types.js';

const stream = (s: string): PdfStream => ({
  kind: 'stream', dict: new Map(), raw: new TextEncoder().encode(s),
});
const resolve = (o: PdfObject | undefined): PdfObject => (o ?? null) as PdfObject;
const inflate = (s: PdfStream): Uint8Array => s.raw;
const acroWith = (xfa: PdfObject): PdfDict =>
  new Map<string, PdfObject>([['Fields', []], ['XFA', xfa]]);
const ok = (r: XfaPacketSet | { reason: string }): XfaPacketSet => {
  expect(r).not.toHaveProperty('reason');
  return r as XfaPacketSet;
};

const TEMPLATE = '<template><subform name="f"/></template>';
const DATASETS = '<xfa:datasets><xfa:data><f/></xfa:data></xfa:datasets>';

describe('decodeXfaPackets: the two /XFA shapes', () => {
  // Shape 1: one stream holding a whole XDP. Its packets are the root's own
  // children, keyed by local name -- xml.ts strips the xfa: prefix.
  it('splits a single XDP stream into its child packets', () => {
    const set = ok(decodeXfaPackets(
      acroWith(stream(`<xdp:xdp>${TEMPLATE}${DATASETS}</xdp:xdp>`)), resolve, inflate,
    ));
    expect(set.names).toEqual(['template', 'datasets']);
    expect(set.packets.get('template')!.children[0].attrs.get('name')).toBe('f');
    expect(set.packets.has('datasets')).toBe(true);
  });

  // Shape 2: an array of alternating name/stream pairs, each stream a single
  // well-formed element.
  it('reads the alternating name/stream array', () => {
    const set = ok(decodeXfaPackets(acroWith([
      { kind: 'name', name: 'template' }, stream(TEMPLATE),
      { kind: 'name', name: 'datasets' }, stream(DATASETS),
    ] as PdfObject), resolve, inflate));
    expect(set.names).toEqual(['template', 'datasets']);
    expect(set.packets.size).toBe(2);
  });

  it('accepts a PdfString name as well as a PdfName', () => {
    const set = ok(decodeXfaPackets(acroWith([
      { kind: 'string', bytes: new TextEncoder().encode('template') }, stream(TEMPLATE),
    ] as PdfObject), resolve, inflate));
    expect(set.names).toEqual(['template']);
  });
});

describe('decodeXfaPackets: damage is a value', () => {
  // The XDP wrapper's preamble/postamble are text fragments, not elements.
  // parseXml throws on them; a per-packet failure must cost that packet only,
  // or every array-form document in existence is refused.
  it('skips an unparseable packet by name and keeps the rest', () => {
    const set = ok(decodeXfaPackets(acroWith([
      { kind: 'name', name: 'preamble' }, stream('<?xml version="1.0"?><xdp:xdp>'),
      { kind: 'name', name: 'template' }, stream(TEMPLATE),
      { kind: 'name', name: 'postamble' }, stream('</xdp:xdp>'),
    ] as PdfObject), resolve, inflate));
    expect(set.packets.has('template')).toBe(true);
    expect(set.names).toEqual(['preamble', 'template', 'postamble']);
    expect(set.skipped.map((s) => s.name).sort()).toEqual(['postamble', 'preamble']);
  });

  it('refuses the whole /XFA when the single stream will not parse', () => {
    const r = decodeXfaPackets(acroWith(stream('<xdp:xdp>')), resolve, inflate);
    expect(r).toHaveProperty('reason');
    expect((r as { reason: string }).reason).toMatch(/XFA/i);
  });

  it('refuses an absent /AcroForm, an absent /XFA and an /XFA of the wrong type', () => {
    expect(decodeXfaPackets(undefined, resolve, inflate)).toHaveProperty('reason');
    expect(decodeXfaPackets(new Map([['Fields', []]]), resolve, inflate))
      .toHaveProperty('reason');
    expect(decodeXfaPackets(acroWith(42), resolve, inflate)).toHaveProperty('reason');
  });

  it('skips an array entry whose stream is missing rather than shifting the pairs', () => {
    const set = ok(decodeXfaPackets(acroWith([
      { kind: 'name', name: 'config' }, { kind: 'name', name: 'notAStream' },
      { kind: 'name', name: 'template' }, stream(TEMPLATE),
    ] as PdfObject), resolve, inflate));
    expect(set.packets.has('template')).toBe(true);
    expect(set.skipped.some((s) => s.name === 'config')).toBe(true);
  });

  // A document with two `template` packets has already contradicted itself.
  // Taking the later one would make the answer depend on array order.
  it('takes the FIRST of two packets sharing a name and reports the second', () => {
    const set = ok(decodeXfaPackets(acroWith([
      { kind: 'name', name: 'template' }, stream(TEMPLATE),
      { kind: 'name', name: 'template' }, stream('<template><subform name="g"/></template>'),
    ] as PdfObject), resolve, inflate));
    expect(set.packets.get('template')!.children[0].attrs.get('name')).toBe('f');
    expect(set.skipped).toHaveLength(1);
  });

  it('routes every stream through inflate, never through raw', () => {
    let asked = 0;
    const counting = (s: PdfStream): Uint8Array => { asked += 1; return s.raw; };
    decodeXfaPackets(acroWith(stream(`<xdp:xdp>${TEMPLATE}</xdp:xdp>`)), resolve, counting);
    expect(asked).toBe(1);
  });
});
