import { PsInterpreter } from '../../src/psvm.js';
import { installPsGraphics } from '../../src/psgraphics.js';
import type { LoadLimits } from '../../src/loadlimits.js';

export function runGraphics(source: string, limits?: LoadLimits) {
  const vm = new PsInterpreter({ limits });
  const graphics = installPsGraphics(vm);
  vm.run(new TextEncoder().encode(source));
  return { vm, graphics };
}
