// A real face given vertical-writing tables it does not have (g0ky.10): a GSUB
// table whose one feature -- `vert` or `vrt2`, under a script of our choosing --
// substitutes glyph for glyph, and `vhea`/`vmtx` stating one advance height and
// top side bearing for every glyph. No vendored face carries a vertical
// feature, and these tables are small enough to write from the OpenType spec.

const u16 = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff];
const i16 = (v: number): number[] => u16(v & 0xffff);
const u32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

/** GSUB 1.0: one script (`script`, default LangSys only) listing every
 *  feature, each feature `tag` with one SingleSubst format 2 lookup of its
 *  own mapping each `[from, to]`. */
export function buildVertGsub(features: { tag: string; pairs: [number, number][] }[], script = 'kana'): Uint8Array {
  const tag4 = (t: string): number[] => [...t].map((c) => c.charCodeAt(0));
  const lookups = features.map(({ pairs }) => {
    const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
    // SingleSubst format 2: format, coverageOffset, glyphCount, substitutes[]; then Coverage format 1.
    const coverage = [...u16(1), ...u16(sorted.length), ...sorted.flatMap(([f]) => u16(f))];
    const subst = [...u16(2), ...u16(6 + sorted.length * 2), ...u16(sorted.length), ...sorted.flatMap(([, t]) => u16(t)), ...coverage];
    return [...u16(1), ...u16(0), ...u16(1), ...u16(8), ...subst];              // type, flag, count, offset
  });
  const lookupList: number[] = [...u16(lookups.length)];
  let at = 2 + lookups.length * 2;
  for (const l of lookups) { lookupList.push(...u16(at)); at += l.length; }
  for (const l of lookups) lookupList.push(...l);
  const featureList: number[] = [...u16(features.length)];
  const fBase = 2 + features.length * 6;
  features.forEach((f, i) => featureList.push(...tag4(f.tag), ...u16(fBase + i * 6)));
  features.forEach((_, i) => featureList.push(...u16(0), ...u16(1), ...u16(i)));  // params, count, lookup i
  const langSys = [...u16(0), ...u16(0xffff), ...u16(features.length), ...features.flatMap((_, i) => u16(i))];
  const scriptTable = [...u16(4), ...u16(0), ...langSys];                         // defaultLangSys at 4, no LangSys records
  const scriptList = [...u16(1), ...tag4(script), ...u16(8), ...scriptTable];
  const sOff = 10, fOff = sOff + scriptList.length, lOff = fOff + featureList.length;
  return Uint8Array.from([...u32(0x00010000), ...u16(sOff), ...u16(fOff), ...u16(lOff), ...scriptList, ...featureList, ...lookupList]);
}

/** `vhea` 1.1 and a `vmtx` giving every one of `numGlyphs` glyphs `advance` and
 *  `tsb`, except the advance heights `overrides` states per glyph. */
export function buildVerticalMetrics(numGlyphs: number, advance: number, tsb: number, overrides: Record<number, number> = {}): { vhea: Uint8Array; vmtx: Uint8Array } {
  const vhea = Uint8Array.from([
    ...u32(0x00011000), ...i16(880), ...i16(-120), ...i16(0), ...u16(advance),
    ...i16(tsb), ...i16(0), ...i16(advance), ...i16(1), ...i16(0), ...i16(0),
    ...i16(0), ...i16(0), ...i16(0), ...i16(0), ...i16(0), ...u16(numGlyphs),
  ]);
  const vmtx = Uint8Array.from(Array.from({ length: numGlyphs }, (_, g) => [...u16(overrides[g] ?? advance), ...i16(tsb)]).flat());
  return { vhea, vmtx };
}

/** `ttf` with `tables` added, replacing any table of the same tag. */
export function withTables(ttf: Uint8Array, tables: Record<string, Uint8Array>): Uint8Array {
  const v = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
  const n = v.getUint16(4);
  const all: { tag: string; data: Uint8Array }[] = [];
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(...ttf.subarray(rec, rec + 4));
    if (tag in tables) continue;
    const off = v.getUint32(rec + 8), len = v.getUint32(rec + 12);
    all.push({ tag, data: ttf.subarray(off, off + len) });
  }
  for (const [tag, data] of Object.entries(tables)) all.push({ tag, data });
  all.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  // Chunks, copied once: spreading a whole font into an array overflows the stack.
  let offset = 12 + all.length * 16;
  const dir: number[] = [];
  const body: Uint8Array[] = [];
  for (const t of all) {
    dir.push(...[...t.tag].map((c) => c.charCodeAt(0)), ...u32(0), ...u32(offset), ...u32(t.data.length));
    const padded = new Uint8Array(t.data.length + ((4 - (t.data.length % 4)) % 4));
    padded.set(t.data);
    body.push(padded);
    offset += padded.length;
  }
  const head = Uint8Array.from([...u32(v.getUint32(0)), ...u16(all.length), ...u16(0), ...u16(0), ...u16(0), ...dir]);
  return new Uint8Array(Buffer.concat([head, ...body]));
}
