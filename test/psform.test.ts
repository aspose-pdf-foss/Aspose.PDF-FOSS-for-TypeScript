import { describe, expect, it } from 'vitest';
import { runGraphics } from './helpers/ps-graphics.js';
import { Document } from '../src/document.js';
import { appendPsPages } from '../src/pspdf.js';
import { extractPaths } from '../src/paths.js';
import { parseContentStream } from '../src/content.js';
import { PsInterpreter } from '../src/psvm.js';
import { installPsGraphics } from '../src/psgraphics.js';
import { name } from '../src/types.js';
const form = '<< /FormType 1 /BBox [0 0 10 10] /Matrix [2 0 0 3 4 5] /PaintProc { pop 0 0 20 20 rectfill } >>';
describe('PostScript forms', () => {
  it.each(['grestore', 'grestoreall'])('keeps the transformed capture boundary after %s', restore => {
    const { vm } = runGraphics(form.replace('0 0 20 20 rectfill',
      restore + ' matrix currentmatrix aload pop clippath pathbbox') + ' execform');
    expect(vm.stack.slice(0, 6)).toMatchObject([
      { value: 2 }, { value: 0 }, { value: 0 }, { value: 3 }, { value: 4 }, { value: 5 },
    ]);
    expect(vm.stack).toHaveLength(10);
    [0, 0, 10, 10].forEach((value, i) => {
      const coordinate = vm.stack[i + 6]!;
      expect('value' in coordinate && coordinate.value).toBeCloseTo(value, 10);
    });
  });
  it('saves and reopens a form with matrix, BBox and its own resources', () => {
    const { graphics } = runGraphics(`${form} execform showpage`);
    const doc = Document.New(); appendPsPages(doc, graphics.finish());
    const reopened = Document.Open(doc.Save());
    const path = extractPaths(reopened, reopened.Pages[0]!).find(path => path.fill)!;
    [4, 5, 44, 65].forEach((value, i) => expect(path.bbox[i]).toBeCloseTo(value, 10));
    expect(parseContentStream(reopened.Pages[0]!.Contents).some(op => op.operator === 'Do')).toBe(true);
  });
  it('restores parent graphics and output after an escaped stop', () => {
    const { vm, graphics } = runGraphics('3 4 translate { << /FormType 1 /BBox [0 0 10 10] '
      + '/Matrix [1 0 0 1 0 0] /PaintProc { pop 0 0 10 10 rectfill stop } >> execform } stopped '
      + 'matrix currentmatrix 4 get 0 0 1 1 rectfill showpage');
    expect(vm.stack).toMatchObject([{ value: true }, { value: 3 }]);
    expect(parseContentStream(graphics.finish()[0]!.content).filter(op => op.operator === 'Do')).toHaveLength(0);
    expect(parseContentStream(graphics.finish()[0]!.content).filter(op => op.operator === 'f')).toHaveLength(1);
  });
  it('lets a returning error handler complete a form', () => {
    expect(runGraphics('errordict /undefined { pop } put ' + form.replace('pop 0', 'pop missing 0')
      + ' execform showpage').graphics.finish()).toHaveLength(1);
  });
  it.each(['showpage', 'copypage', 'erasepage', '<< /PageSize [50 50] >> setpagedevice', 'nulldevice'])
  ('refuses %s during capture', operation => {
    expect(() => runGraphics(form.replace('0 0 20 20 rectfill', operation) + ' execform')).toThrow(/unsupported/i);
  });
  it('can run again after terminal capture failure', () => {
    const vm = new PsInterpreter(); const graphics = installPsGraphics(vm);
    expect(() => vm.run(new TextEncoder().encode(form.replace('0 0 20 20 rectfill', 'missing') + ' execform'))).toThrow(/undefined/);
    vm.run(new TextEncoder().encode('0 0 1 1 rectfill showpage'));
    expect(graphics.finish()).toHaveLength(1);
  });
  it('owns host-added resources for future font capture hooks', () => {
    const vm = new PsInterpreter(); const graphics = installPsGraphics(vm);
    vm.registerOperator('fontProbe', () => {
      graphics.writer.resource('Font', new Map([['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Helvetica')]]));
    });
    vm.run(new TextEncoder().encode(form.replace('0 0 20 20 rectfill', 'fontProbe') + ' execform showpage'));
    const doc = Document.New(); appendPsPages(doc, graphics.finish());
    expect(() => Document.Open(doc.Save())).not.toThrow();
  });
  it('abandons captured marks on quit and supports a later run', () => {
    const vm = new PsInterpreter(); const graphics = installPsGraphics(vm);
    vm.run(new TextEncoder().encode(form.replace('rectfill', 'rectfill quit') + ' execform'));
    vm.run(new TextEncoder().encode('showpage'));
    expect(parseContentStream(graphics.finish()[0]!.content)).toHaveLength(0);
  });
});
