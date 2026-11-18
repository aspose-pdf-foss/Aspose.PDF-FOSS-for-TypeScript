import { describe, expect, it } from 'vitest';
import { runPsText, psTextBytes } from './helpers/ps-text.js';
import { UnsupportedFeatureError } from '../src/errors.js';
const operators = 'findfont definefont undefinefont scalefont makefont setfont currentfont rootfont selectfont findencoding show ashow widthshow awidthshow kshow cshow xshow yshow xyshow glyphshow stringwidth charpath eocharpath setcharwidth setcachedevice setcachedevice2 eexec findresource defineresource undefineresource resourcestatus resourceforall'.split(' ');
describe('PostScript text inventory', () => {
  it('installs every supported operator in systemdict', () => {
    const { vm } = runPsText(operators.map(n => `systemdict /${n} known`).join(' '));
    expect(vm.stack).toHaveLength(operators.length); expect(vm.stack.every(v => v.kind === 'boolean' && v.value)).toBe(true);
  });
  it.each(['composefont', 'cachestatus', 'setcachelimit', 'setcacheparams', 'setucacheparams', 'ucachestatus'])('explicitly refuses %s', op => {
    const { vm } = runPsText(); expect(() => vm.run(psTextBytes(op))).toThrow(UnsupportedFeatureError);
  });
});
