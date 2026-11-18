import type { PsInterpreter, PsInvocation } from './psvm.js';
import type { PsGraphics } from './psgraphics.js';
import { name, integer, real, boolean, canRead, canWrite, PsFault, type PsValue, type PsName, type PsString, type PsDictionary, type PsArray } from './psvalue.js';
import type { PsCharacter, PsFontDefinition, PsFontProgram } from './psfonttypes.js';
import { standardPsEncoding, standardPsProgram, compilePsProgram, suppliedPsProgram, metricsPsProgram } from './psfontprogram.js';
import { standardEncodingNames, winAnsiEncodingNames } from './encoding.js';
import type { StdFont } from './metrics.js';
import { mul, IDENTITY, type Matrix } from './text.js';
import { readPsMatrix } from './psmatrix.js';
import { isType1, readType1Header } from './type1header.js';
import { UnsupportedFeatureError } from './errors.js';
import type { PsBox } from './psstate.js';

export interface PsFontOptions { fonts?: readonly { name: string; bytes: Uint8Array }[] }
const STANDARD: readonly StdFont[] = ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Symbol', 'ZapfDingbats'];
const installed = new WeakMap<PsInterpreter, PsFonts>();
type Registry = ReturnType<PsInterpreter['memory']['readonlyRegistry']>;

export class PsFonts {
  private readonly definitions = new WeakMap<PsDictionary['body'], PsFontDefinition>();
  private readonly lineage = new WeakMap<PsDictionary['body'], { standard?: StdFont; program: PsFontProgram }>();
  private readonly global: Registry;
  private readonly local: Registry;
  private readonly globalEnc: Registry;
  private readonly localEnc: Registry;
  private context?: { character: PsCharacter; selected: PsDictionary; parent?: PsFonts['context'] };
  constructor(readonly vm: PsInterpreter, readonly graphics: PsGraphics, options: PsFontOptions) {
    const memory = vm.memory, allocation = memory.currentGlobal;
    memory.currentGlobal = true;
    try {
      this.global = memory.readonlyRegistry(); this.globalEnc = memory.readonlyRegistry();
      const latin = winAnsiEncodingNames.slice();
      for (let i = 0; i < 144; i++) latin[i] = i < 128 ? standardEncodingNames[i] : undefined;
      latin[45] = 'minus';
      const accents = ['dotlessi', 'grave', 'acute', 'circumflex', 'tilde', 'macron', 'breve', 'dotaccent', 'dieresis', undefined, 'ring', 'cedilla', undefined, 'hungarumlaut', 'ogonek', 'caron'];
      for (let i = 0; i < accents.length; i++) latin[144 + i] = accents[i];
      for (const [key, vector] of [['StandardEncoding', standardEncodingNames], ['ISOLatin1Encoding', latin]] as const) {
        const value = this.encodingArray(vector.map(n => n ?? '.notdef')); this.globalEnc.put(name(key), value); vm.registerStandardValue(key, value);
      }
      for (const face of STANDARD) {
        const dict = memory.dictionary(), chars = memory.dictionary();
        const program = standardPsProgram(vm, face, graphics.decode); this.lineage.set(chars.body, { standard: face, program });
        this.putShape(dict, face, 1, [.001, 0, 0, .001, 0, 0], [-300, -300, 1400, 1400], this.encodingArray(standardPsEncoding(face)));
        memory.put(dict, name('CharStrings'), memory.restrictAccess(chars, 'readonly'));
        this.define(name(face), dict);
      }
      for (const supplied of options.fonts ?? []) {
        vm.budget.work(supplied.bytes.length, 'host font metadata'); vm.budget.allocate(supplied.bytes.length * 4 + 128, 'host font metadata');
        const program = suppliedPsProgram(vm, supplied.bytes, graphics.decode), type1 = isType1(supplied.bytes);
        const header = type1 ? readType1Header(supplied.bytes) : undefined;
        const matrix: Matrix = type1 ? header!.matrix ?? [1 / header!.unitsPerEm, 0, 0, 1 / header!.unitsPerEm, 0, 0] : [...IDENTITY];
        const dict = memory.dictionary(), chars = memory.dictionary(); this.lineage.set(chars.body, { program });
        this.putShape(dict, supplied.name, type1 ? 1 : 42, matrix, header?.bbox ?? [0, 0, 1, 1], this.encodingArray(program.encoding ?? standardPsEncoding('Courier')));
        memory.put(dict, name('CharStrings'), memory.restrictAccess(chars, 'readonly')); this.define(name(supplied.name), dict);
      }
    } finally { memory.currentGlobal = allocation; }
    // Local overlays are fixed roots of the dynamic system bindings.
    memory.currentGlobal = false;
    try { this.local = memory.readonlyRegistry(this.global.dictionary); this.localEnc = memory.readonlyRegistry(this.globalEnc.dictionary); }
    finally { memory.currentGlobal = allocation; }
    vm.registerStandardBinding('FontDirectory', () => this.fontRegistry().dictionary, [this.local.dictionary, this.global.dictionary]);
    vm.registerStandardValue('GlobalFontDirectory', this.global.dictionary);
    vm.addSaveParticipant({ prepareSave: () => {
      const context = this.context;
      return { visitRoots: visit => { visit(this.localEnc.dictionary); this.visitContext(context, visit); }, restore: () => { this.context = context; } };
    } });
    this.install();
    graphics.state.font = this.derive(this.find(name('Courier')), [12, 0, 0, 12, 0, 0]);
  }
  private fontRegistry(): Registry { return this.vm.memory.currentGlobal ? this.global : this.local ?? this.global; }
  private encRegistry(): Registry { return this.vm.memory.currentGlobal ? this.globalEnc : this.localEnc ?? this.globalEnc; }
  private key(key: PsValue): PsName {
    if (key.kind === 'name') return key;
    if (key.kind !== 'string') throw new PsFault('typecheck');
    return name(this.text(key));
  }
  private text(value: PsString): string {
    if (!value.body.valid) throw new PsFault('invalidrestore'); if (!canRead(value)) throw new PsFault('invalidaccess');
    this.vm.budget.allocate(64 + value.length * 2, 'font key'); this.vm.budget.work(value.length);
    let result = ''; for (let i = 0; i < value.length; i++) result += String.fromCharCode(value.body.bytes[value.offset + i]!); return result;
  }
  private encodingArray(vector: readonly string[]): PsArray {
    const m = this.vm.memory; this.vm.budget.allocate(vector.length * 16, 'font encoding operands');
    return m.restrictAccess(m.arrayFrom(vector.map(n => m.name(n))), 'readonly');
  }
  private putShape(dict: PsDictionary, fontName: string, type: number, matrix: Matrix, box: PsBox, encoding: PsArray): void {
    const m = this.vm.memory;
    for (const [k, v] of [['FontName', m.name(fontName)], ['FontType', integer(type)], ['FontMatrix', m.arrayFrom(matrix.map(real))],
      ['FontBBox', m.arrayFrom(box.map(real))], ['Encoding', encoding]] as const) m.put(dict, name(k), v);
  }
  find(key: PsName | PsString): PsDictionary {
    const result = this.vm.memory.lookup(this.fontRegistry().dictionary, this.key(key));
    if (result?.kind !== 'dictionary') throw new PsFault('invalidfont'); this.definition(result); return result;
  }
  definition(font: PsDictionary): PsFontDefinition {
    if (!font.body.valid) throw new PsFault('invalidrestore');
    const known = this.definitions.get(font.body);
    if (!known || !known.identity.body.valid || this.vm.memory.get(font, name('FID')) !== known.identity) throw new PsFault('invalidfont');
    return known;
  }
  current(): PsFontDefinition { const font = this.graphics.state.font; if (!font) throw new PsFault('invalidfont'); return this.definition(font); }
  root(): PsDictionary { return this.context && this.graphics.state.font === this.context.selected ? this.context.character.root : this.current().dictionary; }
  define(key: PsValue, dict: PsDictionary): PsDictionary {
    const vm = this.vm, m = vm.memory, normalized = this.key(key);
    if (!dict.body.valid) throw new PsFault('invalidrestore'); if (!canWrite(dict)) throw new PsFault('invalidaccess');
    if (m.lookup(dict, name('FID'))) throw new PsFault('invalidfont');
    const field = (key: string): PsValue | undefined => m.lookup(dict, name(key));
    const t = field('FontType'); if (t?.kind !== 'integer' || ![0, 1, 3, 42].includes(t.value)) throw new UnsupportedFeatureError('Unsupported PostScript FontType');
    const type = t.value as 0 | 1 | 3 | 42;
    for (const key of ['CDevProc', 'GlyphDirectory', 'CIDFontType', 'WMode']) {
      const v = field(key); if (v && !(key === 'WMode' && v.kind === 'integer' && v.value === 0)) throw new UnsupportedFeatureError(`PostScript font ${key} is unsupported`);
    }
    const fm = field('FontMatrix'), bb = field('FontBBox') ?? (type === 0 ? m.arrayFrom([0, 0, 0, 0].map(integer)) : undefined), enc = field('Encoding');
    if (!fm || bb?.kind !== 'array' || bb.length !== 4 || enc?.kind !== 'array') throw new PsFault('invalidfont');
    const matrix = readPsMatrix(vm, fm);
    const box = Array.from({ length: 4 }, (_, i) => { const n = m.get(bb, i); if (n.kind !== 'integer' && n.kind !== 'real') throw new PsFault('invalidfont'); return n.value; }) as PsBox;
    vm.budget.items(enc.length); vm.budget.allocate(64 + enc.length * 16, 'compiled font encoding');
    const encoding: (string | number)[] = [];
    for (let i = 0; i < enc.length; i++) { vm.budget.work(); const v = m.get(enc, i); if (type === 0 && v.kind === 'integer') encoding.push(v.value); else if (type !== 0 && v.kind === 'name') encoding.push(v.text); else throw new PsFault('invalidfont'); }
    const p = field('PaintType'), sw = field('StrokeWidth');
    const paintType = p === undefined ? 0 : p.kind === 'integer' && (p.value === 0 || p.value === 2) ? p.value : -1;
    if (paintType < 0 || sw && sw.kind !== 'integer' && sw.kind !== 'real') throw new PsFault('invalidfont');
    let program: PsFontProgram | undefined, standard: StdFont | undefined, builder: PsFontDefinition['builder'], composite: PsFontDefinition['composite'];
    let derivedVector: PsArray | undefined;
    if (type === 1 || type === 42) {
      for (const k of ['BuildGlyph', 'BuildChar', 'Blend', 'BlendAxisTypes']) if (field(k)) throw new UnsupportedFeatureError(`PostScript font ${k} is unsupported`);
      const chars = field('CharStrings'), inherited = chars?.kind === 'dictionary' && this.lineage.get(chars.body);
      if (inherited) { program = metricsPsProgram(vm, dict, inherited.program); standard = field('Metrics') || paintType === 2 ? undefined : inherited.standard; }
      else program = compilePsProgram(vm, dict, this.graphics.decode);
    } else if (type === 3) {
      const bg = field('BuildGlyph'), bc = field('BuildChar'), proc = bg ?? bc;
      if (proc?.kind !== 'array' || !proc.executable) throw new PsFault('invalidfont'); m.checkExecutable(proc); builder = { procedure: proc, byName: bg !== undefined };
    } else {
      const map = field('FMapType'), deps = field('FDepVector'), esc = field('EscChar');
      if (map?.kind !== 'integer' || (map.value !== 2 && map.value !== 3)) throw new UnsupportedFeatureError('Unsupported PostScript FMapType');
      if (deps?.kind !== 'array') throw new PsFault('invalidfont');
      const escape = esc === undefined ? 255 : esc.kind === 'integer' ? esc.value : -1; if (escape < 0 || escape > 255) throw new PsFault('invalidfont');
      vm.budget.items(deps.length); vm.budget.allocate(64 + deps.length * 16, 'font descendants');
      const descendants: PsDictionary[] = [];
      for (let i = 0; i < deps.length; i++) { vm.budget.work(); const d = m.get(deps, i); if (d.kind !== 'dictionary') throw new PsFault('invalidfont'); this.definition(d); descendants.push(d); }
      for (const index of encoding) if (typeof index !== 'number' || index < 0 || index >= descendants.length) throw new PsFault('invalidfont');
      composite = { mapType: map.value, escape, descendants };
      this.validateComposite(composite);
      if (!matrix.every((v, i) => v === IDENTITY[i])) {
        composite = { ...composite, descendants: descendants.map(d => this.definition(d).type === 0 ? this.derive(d, matrix) : d) };
        derivedVector = m.restrictAccess(m.arrayFrom(composite.descendants), 'readonly');
      }
    }
    vm.budget.allocate(384, 'compiled font'); const identity = m.fontId();
    const definition: PsFontDefinition = { dictionary: dict, identity, type, matrix, box, encoding, paintType: paintType as 0 | 2, strokeWidth: sw && (sw.kind === 'integer' || sw.kind === 'real') ? sw.value : 0, standard, program, builder, composite };
    vm.budget.allocate(dict.body.entries.length * 64, 'font publication rollback');
    const before = dict.body.entries.slice(), capacity = dict.body.capacity, access = dict.body.access; let published = false;
    try {
      m.put(dict, name('FID'), identity); if (derivedVector) m.put(dict, name('FDepVector'), derivedVector); m.restrictAccess(dict, 'readonly');
      this.fontRegistry().put(normalized, dict); this.definitions.set(dict.body, definition); published = true;
    } finally { if (!published) { dict.body.entries = before; dict.body.capacity = capacity; dict.body.access = access; } }
    return dict;
  }
  derive(font: PsDictionary, by: Matrix): PsDictionary {
    const original = this.definition(font), m = this.vm.memory, dict = m.dictionary();
    for (const [key, value] of m.entries(font)) if (key.kind !== 'name' || key.text !== 'FID') m.put(dict, key, value);
    const matrix = mul(original.matrix, by); if (!matrix.every(Number.isFinite)) throw new PsFault('undefinedresult');
    let composite = original.composite;
    if (composite) {
      this.validateComposite(composite);
      this.vm.budget.allocate(64 + composite.descendants.length * 16, 'derived descendants');
      composite = { ...composite, descendants: composite.descendants.map(d => this.definition(d).type === 0 ? this.derive(d, by) : d) };
      m.put(dict, name('FDepVector'), m.restrictAccess(m.arrayFrom(composite.descendants), 'readonly'));
    }
    m.put(dict, name('FontMatrix'), m.restrictAccess(m.arrayFrom(matrix.map(real)), 'readonly'));
    const identity = m.fontId(); m.put(dict, name('FID'), identity); m.restrictAccess(dict, 'readonly');
    this.vm.budget.allocate(384, 'derived font descriptor'); this.definitions.set(dict.body, { ...original, dictionary: dict, identity, matrix, composite }); return dict;
  }
  private validateComposite(composite: NonNullable<PsFontDefinition['composite']>, depth = 1, active = new Set<PsDictionary['body']>()): void {
    this.vm.budget.depth(depth, 'composite fonts'); if (depth > 5) throw new PsFault('limitcheck');
    for (const child of composite.descendants) {
      this.vm.budget.work(); if (active.has(child.body)) throw new PsFault('invalidfont'); const definition = this.definition(child);
      if (definition.composite) {
        if (composite.mapType === 2 && definition.composite.mapType === 3) throw new PsFault('invalidfont');
        this.vm.budget.allocate(32, 'composite validation'); active.add(child.body); this.validateComposite(definition.composite, depth + 1, active); active.delete(child.body);
      }
    }
  }
  private visitContext(context: PsFonts['context'], visit: (value: PsValue) => void): void {
    for (let c = context; c; c = c.parent) { this.vm.budget.work(); visit(c.character.root); visit(c.character.font.dictionary); }
  }
  visitRoots(visit: (value: PsValue) => void): void { visit(this.local.dictionary); visit(this.global.dictionary); visit(this.localEnc.dictionary); visit(this.globalEnc.dictionary); this.visitContext(this.context, visit); }
  withCharacter(character: PsCharacter, scope: PsInvocation): PsInvocation {
    const parent = this.context, selected = this.graphics.state.font; this.vm.budget.allocate(96 + scope.roots.length * 16, 'character font scope');
    // Composite callbacks see the effective, fully derived leaf font.
    const leaf = character.matrix.every((v, i) => v === character.font.matrix[i]) ? character.font.dictionary
      : this.deriveEffective(character.font, character.matrix);
    this.context = { character, selected: leaf, parent }; this.graphics.state.font = leaf;
    let active = true; const cleanup = (): void => { if (active) { this.context = parent; this.graphics.state.font = selected; active = false; } };
    return { roots: [character.root, character.font.dictionary, leaf, ...(selected ? [selected] : []), ...scope.roots],
      complete: () => { cleanup(); scope.complete(); }, unwind: () => { cleanup(); scope.unwind(); } };
  }
  private deriveEffective(font: PsFontDefinition, matrix: Matrix): PsDictionary {
    const derived = this.derive(font.dictionary, IDENTITY), old = this.definition(derived);
    // This dictionary is host-owned; replace its matrix through a fresh derivation.
    const m = this.vm.memory, copy = m.dictionary(); for (const [k, v] of m.entries(derived)) if (k.kind !== 'name' || k.text !== 'FID' && k.text !== 'FontMatrix') m.put(copy, k, v);
    m.put(copy, name('FontMatrix'), m.restrictAccess(m.arrayFrom(matrix.map(real)), 'readonly')); const identity = m.fontId(); m.put(copy, name('FID'), identity); m.restrictAccess(copy, 'readonly');
    this.definitions.set(copy.body, { ...old, dictionary: copy, identity, matrix: [...matrix] }); return copy;
  }
  private resource(category: PsValue): Registry {
    if (category.kind !== 'name') throw new PsFault('typecheck');
    if (category.text === 'Font') return this.fontRegistry(); if (category.text === 'Encoding') return this.encRegistry();
    throw new UnsupportedFeatureError(`PostScript resource ${category.text} is unsupported`);
  }
  private install(): void {
    const vm = this.vm, m = vm.memory, op = (key: string, fn: () => void): void => vm.registerStandardOperator(key, fn);
    op('findfont', () => { const key = this.key(vm.peek()); vm.replace(1, this.find(key)); });
    op('definefont', () => vm.replace(2, this.define(vm.peek(1), vm.typed('dictionary'))));
    op('undefinefont', () => { this.fontRegistry().remove(this.key(vm.peek())); vm.replace(1); });
    op('currentfont', () => vm.push(this.current().dictionary)); op('rootfont', () => vm.push(this.root()));
    op('setfont', () => { const f = vm.typed('dictionary'); this.definition(f); vm.replace(1); this.graphics.state.font = f; });
    op('scalefont', () => { const scale = vm.number().value; vm.replace(2, this.derive(vm.typed('dictionary', 1), [scale, 0, 0, scale, 0, 0])); });
    op('makefont', () => vm.replace(2, this.derive(vm.typed('dictionary', 1), readPsMatrix(vm, vm.peek()))));
    op('selectfont', () => { const by = vm.peek().kind === 'array' ? readPsMatrix(vm, vm.peek()) : (() => { const s = vm.number().value; return [s, 0, 0, s, 0, 0] as Matrix; })(); const f = this.derive(this.find(this.key(vm.peek(1))), by); vm.replace(2); this.graphics.state.font = f; });
    op('findencoding', () => { const e = m.lookup(this.encRegistry().dictionary, this.key(vm.peek())); if (!e) throw new PsFault('undefinedresource'); vm.replace(1, e); });
    op('findresource', () => { const r = this.resource(vm.peek()), key = this.key(vm.peek(1)), value = m.lookup(r.dictionary, key); if (!value) throw new PsFault('undefinedresource'); vm.replace(2, value); });
    op('resourcestatus', () => { const r = this.resource(vm.peek()), value = m.lookup(r.dictionary, this.key(vm.peek(1))); vm.replace(2, ...(value ? [integer(0), integer(0), boolean(true)] : [boolean(false)])); });
    op('defineresource', () => { const category = vm.peek(), r = this.resource(category), key = this.key(vm.peek(2)), value = vm.peek(1);
      if (category.kind === 'name' && category.text === 'Font') { if (value.kind !== 'dictionary') throw new PsFault('typecheck'); vm.replace(3, this.define(key, value)); }
      else { if (value.kind !== 'array') throw new PsFault('typecheck'); for (let i = 0; i < value.length; i++) if (m.get(value, i).kind !== 'name') throw new PsFault('typecheck'); r.put(key, value); vm.replace(3, value); }
    });
    op('undefineresource', () => { this.resource(vm.peek()).remove(this.key(vm.peek(1))); vm.replace(2); });
    op('resourceforall', () => {
      const r = this.resource(vm.peek()), scratch = vm.typed('string', 1), proc = vm.procedure(2), template = vm.typed('string', 3);
      if (!scratch.body.valid || !template.body.valid) throw new PsFault('invalidrestore'); if (!canWrite(scratch) || !canRead(template)) throw new PsFault('invalidaccess');
      const pattern = this.text(template), keys = m.entries(r.dictionary).map(([k]) => k); let index = 0;
      vm.budget.allocate(64 + keys.length * 16, 'resource enumeration'); vm.replace(4);
      vm.scheduleLoop(() => {
        while (index < keys.length) { vm.budget.work(); const k = keys[index++]!; if (k.kind !== 'name' || !glob(pattern, k.text, vm)) continue;
          if (k.text.length > scratch.length) throw new PsFault('rangecheck');
          for (let i = 0; i < k.text.length; i++) m.put(scratch, i, integer(k.text.charCodeAt(i)));
          vm.push(m.interval(scratch, 0, k.text.length)); vm.execute(proc); return true;
        } return false;
      }, [scratch, template, proc, ...keys]);
    });
    for (const key of ['composefont', 'cachestatus', 'setcachelimit', 'setcacheparams', 'setucacheparams', 'ucachestatus']) op(key, () => { throw new UnsupportedFeatureError(`PostScript ${key} is unsupported`); });
  }
}
function glob(pattern: string, value: string, vm: PsInterpreter): boolean {
  let p = 0, v = 0, star = -1, saved = 0;
  while (v < value.length) {
    vm.budget.work(); const c = pattern[p];
    if (c === '*') { star = p++; saved = v; }
    else if (c === '[') {
      let i = p + 1, matches = false;
      for (; i < pattern.length && pattern[i] !== ']'; i++) {
        vm.budget.work();
        if (pattern[i + 1] === '-' && pattern[i + 2] !== undefined && pattern[i + 2] !== ']') {
          matches ||= value[v]! >= pattern[i]! && value[v]! <= pattern[i + 2]!; i += 2;
        } else matches ||= pattern[i] === value[v];
      }
      if (matches && pattern[i] === ']') { p = i + 1; v++; }
      else if (star >= 0) { p = star + 1; v = ++saved; }
      else return false;
    }
    else if (c === '?' || c === value[v]) { p++; v++; }
    else if (c === '\\' && pattern[p + 1] === value[v]) { p += 2; v++; }
    else if (star >= 0) { p = star + 1; v = ++saved; }
    else return false;
  }
  while (pattern[p] === '*') { vm.budget.work(); p++; } return p === pattern.length;
}
export function installPsFonts(vm: PsInterpreter, graphics: PsGraphics, options: PsFontOptions = {}): PsFonts {
  vm.assertStandardInstallation(); if (graphics.vm !== vm || installed.has(vm)) throw new PsFault('invalidaccess');
  const fonts = new PsFonts(vm, graphics, options); installed.set(vm, fonts); return fonts;
}
