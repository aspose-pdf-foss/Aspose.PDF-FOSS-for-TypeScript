import type { PsInterpreter } from './psvm.js';
import type { PsGraphics } from './psgraphics.js';
import type { PsFontDefinition, PsProgramGlyph } from './psfonttypes.js';
import { name, type PdfDict, type PdfObject, type PdfStream, isArray, isDict, isStream, isName, isString } from './types.js';
import { IDENTITY, type Matrix } from './text.js';
import type { PsBudget } from './psbudget.js';
import type { PsBox } from './psstate.js';

export interface PsPdfGlyph { font: PdfDict; code: number; fontMatrix: Matrix; path?: import('./psstate.js').PsPathData; box?: PsBox }
export interface PsGlyphPaint { content: Uint8Array; resources: PdfDict; colored: boolean }
interface Entry { glyph: PsProgramGlyph; paint?: PsGlyphPaint; result: PsPdfGlyph }
interface Bank { font: PdfDict; chars: PdfDict; entries: Entry[]; widths: number[]; differences: PdfObject[]; box: PsBox }
const stream = (raw: Uint8Array, dict: PdfDict = new Map()): PdfStream => ({ kind: 'stream', raw, dict });

function equalBytes(a: Uint8Array, b: Uint8Array, budget: PsBudget): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) { budget.work(); if (a[i] !== b[i]) return false; } return true;
}
function equalPdf(a: PdfObject, b: PdfObject, budget: PsBudget, depth = 0): boolean {
  budget.work(); budget.depth(depth, 'glyph resource comparison'); if (a === b) return true;
  if (isStream(a) && isStream(b)) return equalBytes(a.raw, b.raw, budget) && equalPdf(a.dict, b.dict, budget, depth + 1);
  if (isName(a) && isName(b)) { budget.work(a.name.length); return a.name === b.name; }
  if (isString(a) && isString(b)) return equalBytes(a.bytes, b.bytes, budget);
  if (isArray(a) && isArray(b)) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!equalPdf(a[i]!, b[i]!, budget, depth + 1)) return false; return true; }
  if (isDict(a) && isDict(b)) { if (a.size !== b.size) return false; for (const [key, v] of a) { budget.work(key.length); const other = b.get(key); if (other === undefined || !equalPdf(v, other, budget, depth + 1)) return false; } return true; }
  return false;
}
function references(value: PdfObject, target: PdfDict, budget: PsBudget, seen = new Set<PdfObject>(), depth = 0): boolean {
  budget.work(); budget.depth(depth, 'glyph resource dependency');
  if (value === target) return true;
  if (seen.has(value)) return false;
  budget.allocate(16, 'glyph resource dependency'); seen.add(value);
  if (isStream(value)) return references(value.dict, target, budget, seen, depth + 1);
  if (isDict(value) || isArray(value)) for (const child of value.values()) if (references(child, target, budget, seen, depth + 1)) return true;
  return false;
}
function sameGlyph(a: PsProgramGlyph, b: PsProgramGlyph, budget: PsBudget): boolean {
  budget.work(a.name.length + 10 + a.path.segments.length, 'glyph comparison');
  if (a.name !== b.name || a.unicode !== b.unicode || !a.advance.every((v, i) => v === b.advance[i]) || !a.sidebearing.every((v, i) => v === b.sidebearing[i])
    || !a.box.every((v, i) => v === b.box[i]) || a.path.segments.length !== b.path.segments.length) return false;
  for (let i = 0; i < a.path.segments.length; i++) {
    const x = a.path.segments[i]!, y = b.path.segments[i]!; if (x.op !== y.op) return false;
    if (x.op !== 'Z' && y.op !== 'Z' && (x.x !== y.x || x.y !== y.y)) return false;
    if (x.op === 'C' && y.op === 'C' && (x.x1 !== y.x1 || x.y1 !== y.y1 || x.x2 !== y.x2 || x.y2 !== y.y2)) return false;
  } return true;
}
function unicodeMap(entries: readonly Entry[], budget: PsBudget): PdfStream {
  let text = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /PSUnicode def /CMapType 2 def 1 begincodespacerange <00> <ff> endcodespacerange\n';
  budget.allocate(1024, 'glyph Unicode header');
  for (let i = 0; i < entries.length; i++) {
    budget.work(); const u = entries[i]!.glyph.unicode; if (u === undefined) continue;
    budget.allocate(128 + u.length * 16, 'glyph Unicode mapping'); budget.work(u.length);
    let hex = ''; for (let j = 0; j < u.length; j++) hex += u.charCodeAt(j).toString(16).padStart(4, '0');
    text += `1 beginbfchar <${i.toString(16).padStart(2, '0')}> <${hex}> endbfchar\n`;
  }
  text += 'endcmap CMapName currentdict /CMap defineresource pop end end'; budget.allocate(text.length * 3 + 128, 'glyph Unicode stream'); budget.work(text.length);
  budget.limits.enforce('maxObjectBytes', text.length, 'glyph Unicode'); return stream(new TextEncoder().encode(text));
}
export class PsFontPdfBank {
  private readonly banks = new WeakMap<object, Bank[]>();
  constructor(private readonly vm: PsInterpreter, private readonly graphics: PsGraphics) {}
  glyph(font: PsFontDefinition, glyph: PsProgramGlyph, paint?: PsGlyphPaint): PsPdfGlyph {
    const budget = this.vm.budget, groups = this.banks.get(font.identity.body) ?? [];
    for (const bank of groups) for (const entry of bank.entries) {
      budget.work(); if (!sameGlyph(entry.glyph, glyph, budget) || !!entry.paint !== !!paint) continue;
      if (entry.paint && paint && (entry.paint.colored !== paint.colored || !equalBytes(entry.paint.content, paint.content, budget) || !equalPdf(entry.paint.resources, paint.resources, budget))) continue;
      return entry.result;
    }
    let bank = groups.at(-1); const fresh = !bank || bank.entries.length === 256 || !!paint && references(paint.resources, bank.font, budget);
    budget.allocate(1024 + glyph.name.length * 2 + glyph.path.segments.length * 64, 'PDF glyph bank entry'); budget.items(groups.length + (fresh ? 1 : 0), 'font banks');
    if (fresh) {
      const chars: PdfDict = new Map(), widths: number[] = [], differences: PdfObject[] = [0], box: PsBox = [0, 0, 0, 0];
      const dictionary: PdfDict = new Map<string, PdfObject>([['Type', name('Font')], ['Subtype', name(font.standard ? 'Type1' : 'Type3')],
        ['FirstChar', 0], ['LastChar', 0], ['Widths', widths], ['Encoding', new Map<string, PdfObject>([['Type', name('Encoding')], ['Differences', differences]])]]);
      if (font.standard) dictionary.set('BaseFont', name(font.standard));
      else { dictionary.set('FontMatrix', [...IDENTITY]); dictionary.set('FontBBox', box); dictionary.set('CharProcs', chars); dictionary.set('Resources', new Map()); }
      bank = { font: dictionary, chars, entries: [], widths, differences, box };
    }
    const target = bank!, code = target.entries.length, result: PsPdfGlyph = { font: target.font, code, fontMatrix: font.standard ? [.001, 0, 0, .001, 0, 0] : [...IDENTITY], path: glyph.path, box: glyph.box };
    const entry: Entry = { glyph: { ...glyph, advance: [...glyph.advance], sidebearing: [...glyph.sidebearing], box: [...glyph.box], path: { segments: glyph.path.segments.map(s => ({ ...s })) } }, paint, result };
    let charproc: PdfStream | undefined;
    let paintedForm: PdfStream | undefined;
    if (!font.standard) {
      const writer = this.graphics.outputWriter(glyph.box, !paint?.colored);
      writer.emit(paint?.colored ? 'd0' : 'd1', paint?.colored ? [glyph.advance[0], 0] : [glyph.advance[0], 0, ...glyph.box]);
      if (paint) {
        budget.allocate(512 + paint.content.length, 'glyph paint form'); budget.work(paint.content.length, 'glyph content copy');
        paintedForm = stream(paint.content.slice(), new Map<string, PdfObject>([['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', [...glyph.box]], ['Resources', paint.resources]]));
        writer.emit('Do', [name(`P${code}`)]); charproc = stream(writer.finish().content);
      } else {
        if (font.paintType === 2) writer.emit('w', [font.strokeWidth]);
        writer.writePath(glyph.path); writer.emit(font.paintType === 2 ? 'S' : 'f');
        charproc = stream(writer.finish().content);
      }
    }
    // Prepare the new CMap and all potentially failing work before assigning a code.
    budget.allocate(64 + (code + 1) * 16, 'glyph mapping snapshot'); budget.work(code + 1);
    const mapping = unicodeMap([...target.entries, entry], budget);
    if (fresh) { groups.push(target); this.banks.set(font.identity.body, groups); }
    target.entries.push(entry); target.widths.push(glyph.advance[0]); target.differences.push(name(font.standard ? glyph.name : `g${code}`));
    if (charproc) target.chars.set(`g${code}`, charproc);
    if (paintedForm) {
      const resources = target.font.get('Resources') as PdfDict;
      let forms = resources.get('XObject') as PdfDict | undefined;
      if (!forms) { forms = new Map(); resources.set('XObject', forms); }
      forms.set(`P${code}`, paintedForm);
    }
    target.font.set('LastChar', code); target.font.set('ToUnicode', mapping);
    target.box[0] = Math.min(target.box[0], glyph.box[0]); target.box[1] = Math.min(target.box[1], glyph.box[1]);
    target.box[2] = Math.max(target.box[2], glyph.box[2]); target.box[3] = Math.max(target.box[3], glyph.box[3]);
    return result;
  }
}
