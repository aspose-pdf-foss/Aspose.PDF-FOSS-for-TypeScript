// Builds a Macintosh resource fork around N sfnt payloads — the .dfont
// container. The layout is transcribed from Inside Macintosh: More Macintosh
// Toolbox, and src/dfont.ts reads it back. NOTE THE HAZARD, recorded in the
// design and in PROVENANCE.md: this builder and that reader share one reading
// of the format, so the suite proves they agree, NOT that either matches what
// Apple writes. There is no real .dfont in test/fixtures/.

function u32b(v: number): Uint8Array {
  return Uint8Array.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}
function u16b(v: number): Uint8Array { return Uint8Array.from([(v >> 8) & 0xff, v & 0xff]); }
function u24b(v: number): Uint8Array {
  return Uint8Array.from([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
}
function tag4(s: string): Uint8Array {
  return Uint8Array.from([0, 1, 2, 3].map((i) => s.charCodeAt(i) & 0xff));
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The 28-byte map prologue: header copy, next-map handle, file ref,
 *  attributes, and the two list offsets. */
const MAP_PROLOGUE = 28;

export interface DfontSpec {
  /** sfnt payloads, in the order they become faces. */
  faces: Uint8Array[];
  /** Types written BEFORE the sfnt type — a real suitcase carries `FOND`, and
   *  often `NFNT` or `POST`, in the same map. Putting them first is what makes
   *  a positional reader return the wrong resource. */
  otherTypes?: { tag: string; resources: Uint8Array[] }[];
  /** Padding before the data area. Default 256, which is what Apple writes;
   *  a non-zero default is deliberate, so no offset is incidentally zero. */
  dataOffset?: number;
  /** Write zeros where the map's copy of the header goes. Default false.
   *  Nothing enforces that field, and src/dfont.ts must not depend on it. */
  zeroHeaderCopy?: boolean;
}

export function buildDfont(spec: DfontSpec): Uint8Array {
  const dataOffset = spec.dataOffset ?? 256;
  const types = [...(spec.otherTypes ?? []), { tag: 'sfnt', resources: spec.faces }];

  // Data area: each resource is a u32 length then its payload. A reference
  // entry holds the offset of that LENGTH, relative to the data area.
  const dataParts: Uint8Array[] = [];
  const resOffsets: number[][] = [];
  let dataLength = 0;
  for (const t of types) {
    const offs: number[] = [];
    for (const r of t.resources) {
      offs.push(dataLength);
      dataParts.push(u32b(r.length), r);
      dataLength += 4 + r.length;
    }
    resOffsets.push(offs);
  }

  // Type list: a count, one 8-byte entry per type, then the reference lists.
  // BOTH counts are stored MINUS ONE.
  const numTypes = types.length;
  const entries: Uint8Array[] = [u16b(numTypes - 1)];
  const refLists: Uint8Array[] = [];
  let refAt = 2 + numTypes * 8;              // from the TYPE LIST start
  types.forEach((t, ti) => {
    entries.push(tag4(t.tag), u16b(t.resources.length - 1), u16b(refAt));
    for (let i = 0; i < t.resources.length; i++) {
      refLists.push(
        u16b(128 + i),                       // resource id
        u16b(0xffff),                        // no name
        Uint8Array.from([0]),                // attributes
        u24b(resOffsets[ti][i]),
        u32b(0),                             // reserved handle
      );
    }
    refAt += t.resources.length * 12;
  });
  const typeList = concat([...entries, ...refLists]);

  const mapLength = MAP_PROLOGUE + typeList.length;   // empty name list
  const mapOffset = dataOffset + dataLength;
  const header = concat([u32b(dataOffset), u32b(mapOffset), u32b(dataLength), u32b(mapLength)]);

  const map = concat([
    spec.zeroHeaderCopy ? new Uint8Array(16) : header,
    u32b(0), u16b(0), u16b(0),
    u16b(MAP_PROLOGUE),                      // type list offset, from map start
    u16b(mapLength),                         // name list: empty, so at the end
    typeList,
  ]);

  const out = new Uint8Array(mapOffset + mapLength);
  out.set(header, 0);
  let p = dataOffset;
  for (const part of dataParts) { out.set(part, p); p += part.length; }
  out.set(map, mapOffset);
  return out;
}
