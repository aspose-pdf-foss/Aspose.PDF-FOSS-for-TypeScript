import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PsInterpreter } from '../src/psvm.js';
import type { PsValue } from '../src/psvalue.js';

const cases = JSON.parse(readFileSync(new URL('./fixtures/postscript-core/language-cases.json', import.meta.url), 'utf8')) as {
  id: string; page: number; source: string; stack: unknown[];
}[];
function observed(value: PsValue): unknown {
  if ('value' in value) return value.value;
  if (value.kind === 'string') return String.fromCharCode(...value.body.bytes.subarray(value.offset, value.offset + value.length));
  if (value.kind === 'name') return { name: value.text, executable: value.executable };
  throw new Error(`unexpected fixture result ${value.kind}`);
}
describe('Adobe literal examples and derived language cases (see PROVENANCE)', () => {
  it.each(cases)('$id (PLRM p$page)', example => {
    const vm = new PsInterpreter(); vm.run(new TextEncoder().encode(example.source));
    expect(vm.stack.map(observed)).toEqual(example.stack);
  });
});
