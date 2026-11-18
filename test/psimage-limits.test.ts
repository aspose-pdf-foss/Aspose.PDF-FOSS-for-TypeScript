import { describe, expect, it } from 'vitest';
import { runGraphics } from './helpers/ps-graphics.js';
import { LoadLimits } from '../src/loadlimits.js';
describe('PostScript image bounds', () => {
  it('checks declared pixels before allocating sample buffers', () => {
    expect(() => runGraphics('10000 10000 8 [1 0 0 1 0 0] {} image',
      LoadLimits.defaults.with({ maxImagePixels: 100 })))
      .toThrowError(expect.objectContaining({ limit: 'maxImagePixels', allowed: 100, reached: 100000000 }));
  });
  it('meters empty producers and resource exhaustion escapes stopped', () => {
    expect(() => runGraphics('{ 10000 { 1 1 8 [1 0 0 1 0 0] { () } image } repeat } stopped',
      LoadLimits.defaults.with({ maxPostScriptOperations: 100000 })))
      .toThrowError(expect.objectContaining({ limit: 'maxPostScriptOperations' }));
  });
  it.each(['1 1 8 [1 0 0 1 0 0] { 7 } image', '1 1 3 [1 0 0 1 0 0] <> image'])
  ('refuses invalid requests in %s', source => { expect(() => runGraphics(source)).toThrow(/typecheck|rangecheck/); });
});
