import type { FontWork } from './fontwork.js';
import type { PsInterpreter } from './psvm.js';
import { PsFault, type PsDictionary, type PsValue } from './psvalue.js';
import type { PsFontProgram, PsProgramGlyph, PsVector } from './psfonttypes.js';
import type { PsPathData, PsBox } from './psstate.js';
import type { Path, Seg } from './pagerender.js';
import { apply, type Matrix } from './text.js';
import { parseSfnt, type GlyphPoint, type SfntFont } from './sfnt.js';
import { Type1Font } from './type1.js';
import { runType1Charstring } from './type1charstring.js';
import { isType1 } from './type1header.js';
import { getStd14Sfnt } from './std14fonts.js';
import { glyphToUnicode, standardEncodingNames, symbolEncodingNames, dingbatsEncodingNames, winAnsiEncodingNames } from './encoding.js';
import { glyphWidth, stdGlyphWidth, type StdFont } from './metrics.js';
import type { DecodeBudget } from './decodebudget.js';
import { PdfParseError, rethrowLimit, UnsupportedFeatureError } from './errors.js';
import { psPathFromSegments } from './pspath.js';

function guarded<T>(action: () => T): T {
  try { return action(); }
  catch (caught) { rethrowLimit(caught); if (caught instanceof PdfParseError || caught instanceof RangeError) throw new PsFault('invalidfont'); throw caught; }
}
// Font machinery has privileged read access, never a capability to change source access.
function valid(value: PsValue): void {
  if ('body' in value && !value.body.valid) throw new PsFault('invalidrestore');
}
function entries(vm: PsInterpreter, dict: PsDictionary): readonly [PsValue, PsValue][] {
  valid(dict); vm.budget.items(dict.body.entries.length); vm.budget.work(dict.body.entries.length, 'font dictionary');
  return dict.body.entries;
}
function get(vm: PsInterpreter, dict: PsDictionary, key: string): PsValue | undefined {
  return entries(vm, dict).find(([k]) => k.kind === 'name' && k.text === key)?.[1];
}
function numbers(vm: PsInterpreter, value: PsValue, counts: readonly number[]): number[] {
  valid(value);
  if (value.kind !== 'array' || !counts.includes(value.length)) throw new PsFault('invalidfont');
  vm.budget.allocate(64 + value.length * 16, 'font numbers'); vm.budget.work(value.length);
  return value.body.values.slice(value.offset, value.offset + value.length).map(v => {
    if ((v.kind !== 'integer' && v.kind !== 'real') || !Number.isFinite(v.value)) throw new PsFault('invalidfont');
    return v.value;
  });
}
function string(vm: PsInterpreter, value: PsValue): Uint8Array {
  valid(value); if (value.kind !== 'string') throw new PsFault('invalidfont');
  vm.budget.limits.enforce('maxObjectBytes', value.length, 'font string');
  vm.budget.allocate(64 + value.length, 'font string snapshot'); vm.budget.work(value.length);
  return value.body.bytes.slice(value.offset, value.offset + value.length);
}
function dictionary(value: PsValue | undefined): PsDictionary {
  if (value?.kind !== 'dictionary') throw new PsFault('invalidfont'); valid(value); return value;
}
function glyphResult(vm: PsInterpreter, name: string, advance: PsVector, sidebearing: PsVector, segments: Path): PsProgramGlyph {
  vm.budget.allocate(192, 'font glyph'); vm.budget.work(segments.length, 'font bounds');
  const box: PsBox = [Infinity, Infinity, -Infinity, -Infinity];
  const point = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new PsFault('invalidfont');
    box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
  };
  for (const s of segments) if (s.op !== 'Z') { point(s.x, s.y); if (s.op === 'C') { point(s.x1, s.y1); point(s.x2, s.y2); } }
  return { name, advance, sidebearing, path: psPathFromSegments(segments), box: box[0] === Infinity ? [0, 0, 0, 0] : box, unicode: glyphToUnicode(name) };
}

/** Exact quadratic conversion, retaining the cyclic TrueType implied-point rules. */
export function quadraticPsPath(contours: readonly (readonly GlyphPoint[])[], matrix: Matrix, work: FontWork): PsPathData {
  const path: Path = [];
  const emit = (segment: Seg): void => { work.items(path.length + 1, 'glyph segments'); work.allocate(64, 'glyph segment'); work.work(); path.push(segment); };
  const mid = (a: GlyphPoint, b: GlyphPoint): GlyphPoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
  for (const contour of contours) {
    work.work(contour.length, 'quadratic contour'); if (!contour.length) continue;
    const first = contour[0]!, last = contour[contour.length - 1]!;
    const start = first.on ? first : last.on ? last : mid(last, first);
    const p0 = apply(matrix, start.x, start.y); emit({ op: 'M', x: p0[0], y: p0[1] });
    let current = start;
    const begin = first.on ? 1 : 0, end = last.on && !first.on ? contour.length - 1 : contour.length;
    for (let i = begin; i < end; i++) {
      const pt = contour[i]!;
      if (pt.on) { const p = apply(matrix, pt.x, pt.y); emit({ op: 'L', x: p[0], y: p[1] }); current = pt; }
      else {
        const next = i + 1 < end ? contour[i + 1]! : start;
        const target = next.on ? next : mid(pt, next);
        const a = apply(matrix, current.x + (pt.x - current.x) * 2 / 3, current.y + (pt.y - current.y) * 2 / 3);
        const b = apply(matrix, target.x + (pt.x - target.x) * 2 / 3, target.y + (pt.y - target.y) * 2 / 3);
        const p = apply(matrix, target.x, target.y);
        emit({ op: 'C', x1: a[0], y1: a[1], x2: b[0], y2: b[1], x: p[0], y: p[1] });
        current = target; if (next.on) i++;
      }
    }
    emit({ op: 'Z' });
  }
  return psPathFromSegments(path);
}

function sfntProgram(vm: PsInterpreter, font: SfntFont, names: Map<string, number>, scale: number, unicodeNames = false): PsFontProgram {
  vm.budget.allocate(128 + names.size * 16, 'sfnt program names');
  return { names: [...names.keys()], glyph: requested => guarded(() => {
    vm.budget.work(1 + requested.length, 'font glyph lookup');
    const unicode = unicodeNames ? glyphToUnicode(requested) : undefined;
    const selected = names.get(requested) ?? (unicode ? font.cmap.get(unicode.codePointAt(0)!) : undefined);
    const name = selected === undefined ? '.notdef' : requested, gid = selected ?? names.get('.notdef') ?? 0;
    font.glyphData(gid); // validates even when the glyph has no contour
    const path = quadraticPsPath(font.glyphOutline(gid), [scale, 0, 0, scale, 0, 0], vm.budget);
    return glyphResult(vm, name, [font.advanceWidth(gid) * scale, 0], [0, 0], path.segments);
  }) };
}
function trueType(vm: PsInterpreter, bytes: Uint8Array): SfntFont {
  if (!(bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)
    && !(bytes[0] === 116 && bytes[1] === 114 && bytes[2] === 117 && bytes[3] === 101))
    throw new UnsupportedFeatureError('PostScript requires a TrueType sfnt font');
  const font = parseSfnt(bytes, 0, vm.budget.limits, { work: vm.budget, strict: true });
  if (font.outlines !== 'glyf') throw new UnsupportedFeatureError('PostScript requires TrueType outlines'); return font;
}
function decrypted(vm: PsInterpreter, data: Uint8Array, lenIV: number, decode: DecodeBudget): Uint8Array {
  if (lenIV > data.length) throw new PsFault('invalidfont');
  if (lenIV === -1) return data;
  const length = data.length - lenIV; decode.check(length, data.length, undefined, 'Type 1 charstring');
  vm.budget.allocate(length, 'decrypted charstring'); vm.budget.work(data.length, 'charstring decryption');
  const out = new Uint8Array(length); let r = 4330;
  for (let i = 0; i < data.length; i++) { const c = data[i]!, p = c ^ (r >> 8); r = ((c + r) * 52845 + 22719) & 65535; if (i >= lenIV) out[i - lenIV] = p; }
  decode.chargeBytes(length); return out;
}
export function compilePsProgram(vm: PsInterpreter, dict: PsDictionary, decode: DecodeBudget): PsFontProgram {
  return guarded(() => {
    for (const key of ['CDevProc', 'GlyphDirectory', 'BuildGlyph', 'BuildChar', 'Blend', 'BlendAxisTypes'])
      if (get(vm, dict, key)) throw new UnsupportedFeatureError(`PostScript font ${key} is unsupported`);
    const type = get(vm, dict, 'FontType'), chars = dictionary(get(vm, dict, 'CharStrings'));
    let program: PsFontProgram;
    if (type?.kind === 'integer' && type.value === 42) {
      const sfnts = get(vm, dict, 'sfnts');
      if (sfnts?.kind !== 'array') throw new PsFault('invalidfont'); valid(sfnts);
      vm.budget.items(sfnts.length); vm.budget.allocate(64 + sfnts.length * 16, 'sfnts chunks');
      const chunks: Uint8Array[] = []; let size = 0;
      for (let i = 0; i < sfnts.length; i++) { const chunk = string(vm, sfnts.body.values[sfnts.offset + i]!); const length = chunk.length - (chunk.length % 2); size += length; chunks.push(chunk.subarray(0, length)); }
      vm.budget.limits.enforce('maxObjectBytes', size, 'sfnts'); vm.budget.allocate(size, 'sfnts assembly'); vm.budget.work(size);
      const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
      const font = trueType(vm, bytes), names = new Map<string, number>();
      for (const [k, v] of entries(vm, chars)) {
        if (v.kind === 'array') throw new UnsupportedFeatureError('Type 42 procedure CharStrings are unsupported');
        if (k.kind !== 'name' || v.kind !== 'integer' || v.value < 0 || v.value >= font.numGlyphs) throw new PsFault('invalidfont');
        vm.budget.allocate(64 + k.text.length * 2, 'Type 42 glyph name'); names.set(k.text, v.value);
      }
      program = sfntProgram(vm, font, names, 1 / font.unitsPerEm);
    } else if (type?.kind === 'integer' && type.value === 1) {
      const priv = dictionary(get(vm, dict, 'Private')), iv = get(vm, priv, 'lenIV');
      const lenIV = iv === undefined ? 4 : iv.kind === 'integer' ? iv.value : -2;
      if (lenIV < -1) throw new PsFault('invalidfont');
      const subrs: Uint8Array[] = [], sub = get(vm, priv, 'Subrs');
      if (sub) {
        if (sub.kind !== 'array') throw new PsFault('invalidfont'); valid(sub); vm.budget.items(sub.length); vm.budget.allocate(64 + sub.length * 16, 'Type 1 subrs');
        for (let i = 0; i < sub.length; i++) { const s = sub.body.values[sub.offset + i]!; vm.budget.work(); if (s.kind === 'null') { subrs.push(new Uint8Array(0)); continue; } subrs.push(decrypted(vm, string(vm, s), lenIV, decode)); }
      }
      const codes = new Map<string, Uint8Array>();
      for (const [k, v] of entries(vm, chars)) {
        if (v.kind === 'array') throw new UnsupportedFeatureError('Type 1 procedure CharStrings are unsupported');
        if (k.kind !== 'name') throw new PsFault('invalidfont'); vm.budget.allocate(64 + k.text.length * 2, 'Type 1 glyph name');
        codes.set(k.text, decrypted(vm, string(vm, v), lenIV, decode));
      }
      vm.budget.allocate(64 + codes.size * 16, 'Type 1 names');
      program = { names: [...codes.keys()], glyph: requested => guarded(() => {
        vm.budget.work(1, 'Type 1 glyph lookup'); const n = codes.has(requested) ? requested : '.notdef', code = codes.get(n);
        if (!code) return glyphResult(vm, n, [0, 0], [0, 0], []);
        const g = runType1Charstring(code, { subrs, work: vm.budget, strict: true, limits: vm.budget.limits,
          seacGlyph: c => codes.get(standardEncodingNames[c] ?? '.notdef') });
        return glyphResult(vm, n, [g.width, g.widthY ?? 0], [g.sbx, g.sby], g.path);
      }) };
    } else throw new UnsupportedFeatureError('Unsupported PostScript font program type');
    return metricsPsProgram(vm, dict, program);
  });
}
/** Shared Metrics snapshots, also used by redefined builtin and supplied faces. */
export function metricsPsProgram(vm: PsInterpreter, dict: PsDictionary, program: PsFontProgram): PsFontProgram {
  return guarded(() => {
    const rawMetrics = get(vm, dict, 'Metrics'); if (!rawMetrics) return program;
    const overrides = new Map<string, number[]>();
    for (const [k, v] of entries(vm, dictionary(rawMetrics))) {
      if (k.kind !== 'name') throw new PsFault('invalidfont');
      const m = v.kind === 'integer' || v.kind === 'real' ? [v.value] : numbers(vm, v, [2, 4]);
      if (!m.every(Number.isFinite)) throw new PsFault('invalidfont'); vm.budget.allocate(64 + m.length * 16, 'font Metrics'); overrides.set(k.text, m);
    }
    const original = program;
    return { names: original.names, glyph: n => {
      const g = original.glyph(n), m = overrides.get(g.name); if (!m) return g;
      const side: PsVector = m.length === 1 ? g.sidebearing : [m[0]!, m.length === 4 ? m[1]! : 0];
      const advance: PsVector = m.length === 4 ? [m[2]!, m[3]!] : [m[m.length - 1]!, 0];
      const dx = side[0] - g.sidebearing[0], dy = side[1] - g.sidebearing[1];
      vm.budget.allocate(g.path.segments.length * 64, 'Metrics outline'); vm.budget.work(g.path.segments.length);
      const path = g.path.segments.map((s): Seg => s.op === 'Z' ? s : s.op === 'C'
        ? { op: 'C', x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy, x: s.x + dx, y: s.y + dy }
        : { op: s.op, x: s.x + dx, y: s.y + dy });
      return glyphResult(vm, g.name, advance, side, path);
    } };
  });
}
export function suppliedPsProgram(vm: PsInterpreter, bytes: Uint8Array, decode: DecodeBudget): PsFontProgram {
  return guarded(() => {
    vm.budget.limits.enforce('maxObjectBytes', bytes.length, 'supplied font'); vm.budget.allocate(bytes.length, 'supplied font snapshot');
    vm.budget.work(bytes.length); bytes = new Uint8Array(bytes);
    if (!isType1(bytes)) {
      if (bytes.length < 12) throw new PsFault('invalidfont');
      const font = trueType(vm, bytes), names = new Map<string, number>();
      vm.budget.allocate(64 + font.numGlyphs * 96, 'supplied glyph names'); vm.budget.work(font.numGlyphs);
      const post = font.postNames(); for (let gid = 0; gid < font.numGlyphs; gid++) { const n = post?.[gid]; if (n) names.set(n, gid); }
      names.set('.notdef', 0); return sfntProgram(vm, font, names, 1 / font.unitsPerEm, true);
    }
    // Type 1 decryption cannot expand the supplied bytes; reserve the full decode before parsing.
    decode.check(bytes.length, bytes.length, undefined, 'Type 1 program');
    const font = new Type1Font(bytes, vm.budget.limits, { work: vm.budget, strict: true, decode });
    vm.budget.allocate(64 + font.numGlyphs * 16, 'supplied Type 1 names');
    const names = Array.from({ length: font.numGlyphs }, (_, i) => font.glyphName(i)!);
    const ownEncoding = font.builtinEncodingNames();
    const encoding = ownEncoding ? Array.from({ length: 256 }, (_, i) => ownEncoding.get(i) ?? '.notdef') : standardPsEncoding('Courier');
    return { names, encoding, glyph: requested => guarded(() => {
      vm.budget.work(1, 'supplied Type 1 glyph'); const n = font.gidForName(requested) === undefined ? '.notdef' : requested, gid = font.gidForName(n);
      return glyphResult(vm, n, gid === undefined ? [0, 0] : font.glyphAdvance(gid), gid === undefined ? [0, 0] : font.glyphSidebearing(gid), gid === undefined ? [] : font.glyphPath(gid));
    }) };
  });
}
export function standardPsEncoding(face: StdFont): readonly string[] {
  return face === 'Symbol' ? symbolEncodingNames : face === 'ZapfDingbats' ? dingbatsEncodingNames : standardEncodingNames.map(n => n ?? '.notdef');
}
export function standardPsWidth(face: StdFont, n: string): number {
  if (face === 'Symbol' || face === 'ZapfDingbats') { const code = standardPsEncoding(face).indexOf(n); return code < 0 || n === '.notdef' ? 0 : glyphWidth(face, code); }
  return stdGlyphWidth(face, n);
}
export function standardPsProgram(vm: PsInterpreter, face: StdFont, decode: DecodeBudget): PsFontProgram {
  let program: PsFontProgram | undefined;
  return { names: standardPsEncoding(face), glyph: requested => guarded(() => {
    if (!program) {
      const font = getStd14Sfnt(face, { limits: vm.budget.limits, work: vm.budget, decode }); if (!font) throw new PsFault('invalidfont');
      const names = new Map<string, number>(); vm.budget.allocate(64 + font.numGlyphs * 96, 'standard glyph names'); vm.budget.work(font.numGlyphs);
      const allowed = face === 'Symbol' || face === 'ZapfDingbats' ? standardPsEncoding(face)
        : [...standardEncodingNames, ...winAnsiEncodingNames, 'minus', 'breve', 'dotaccent', 'ring', 'hungarumlaut', 'ogonek', 'caron'];
      vm.budget.allocate(64 + allowed.length * 16, 'standard name lookup'); vm.budget.work(allowed.length);
      const allowedSet = new Set(allowed);
      const post = font.postNames(); if (post) for (let i = 0; i < post.length; i++) if (post[i] && allowedSet.has(post[i]!)) names.set(post[i]!, i);
      for (const n of allowed) { if (!n || names.has(n)) continue; const u = glyphToUnicode(n); const gid = u ? font.cmap.get(u.codePointAt(0)!) : undefined; if (gid !== undefined) names.set(n, gid); }
      program = sfntProgram(vm, font, names, 1000 / font.unitsPerEm);
    }
    const g = program.glyph(requested); g.advance = [standardPsWidth(face, g.name), 0]; return g;
  }) };
}
