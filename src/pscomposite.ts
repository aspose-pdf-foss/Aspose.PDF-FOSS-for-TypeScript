import type { PsFonts } from './psfont.js';
import type { PsCharacter } from './psfonttypes.js';
import type { PsFontDefinition } from './psfonttypes.js';
import { canRead, PsFault, type PsDictionary, type PsString, type PsValue } from './psvalue.js';
import { mul } from './text.js';
export interface PsCharacterCursor { next(): PsCharacter | undefined; visitRoots(visit: (value: PsValue) => void): void }
export function psCharacters(fonts: PsFonts, root: PsDictionary, text: PsString): PsCharacterCursor {
  if (!text.body.valid) throw new PsFault('invalidrestore'); if (!canRead(text)) throw new PsFault('invalidaccess');
  const vm = fonts.vm; vm.budget.allocate(128, 'character cursor'); let position = 0;
  const selected = new Map<PsDictionary['body'], number>();
  const read = (): number => { if (position >= text.length) throw new PsFault('rangecheck'); const b = vm.memory.get(text, position++); return b.kind === 'integer' ? b.value : 0; };
  const descendant = (font: PsFontDefinition, selector: number): PsFontDefinition => {
    const index = font.encoding[selector]; if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= font.composite!.descendants.length) throw new PsFault('rangecheck');
    return fonts.definition(font.composite!.descendants[index]!);
  };
  return { visitRoots: visit => { visit(root); visit(text); }, next: () => {
    const initial = fonts.definition(root); if (position === text.length) return undefined;
    let start = initial, prefix: PsFontDefinition[] = [], seed: number | undefined;
    for (;;) {
      vm.budget.allocate(256, 'composite mapping frames'); const chain = prefix.slice(), modal: number[] = [];
      for (let i = 0; i < chain.length; i++) if (chain[i]!.composite?.mapType === 3) modal.push(i);
      const firstNew = chain.length;
      let composites = 0; for (const f of chain) if (f.composite) composites++;
      const push = (font: PsFontDefinition): void => {
        vm.budget.work(chain.length + 1); if (chain.some(f => f.dictionary.body === font.dictionary.body)) throw new PsFault('invalidfont');
        if (font.composite) composites++;
        vm.budget.depth(composites, 'composite mapping'); if (composites > 5) throw new PsFault('limitcheck');
        vm.budget.allocate(32, 'composite mapping frame'); chain.push(font);
      };
      let font = start; push(font);
      while (font.composite?.mapType === 3) {
        modal.push(chain.length - 1); font = descendant(font, selected.get(font.dictionary.body) ?? 0); push(font);
      }
      const code0 = seed ?? read(), hadSeed = seed !== undefined; seed = undefined;
      const escape = initial.composite?.mapType === 3 ? initial.composite.escape : undefined;
      let nearest = modal.length - 1;
      if (code0 === escape && nearest >= 0 && (!hadSeed || modal[nearest]! >= firstNew)) {
        let selector = read();
        while (selector === escape && nearest > 0) { nearest--; selector = read(); }
        const index = modal[nearest]!, owner = chain[index]!;
        // Re-encountered modal subtrees begin at descendant zero.
        for (const body of selected.keys()) {
          let ancestor = false; for (let i = 0; i < index; i++) { vm.budget.work(); if (chain[i]!.dictionary.body === body) ancestor = true; }
          if (!ancestor) selected.delete(body);
        }
        const repeatedRoot = selector === escape; selected.set(owner.dictionary.body, repeatedRoot ? 0 : selector);
        start = descendant(owner, repeatedRoot ? 0 : selector); prefix = chain.slice(0, index + 1);
        if (repeatedRoot) seed = escape;
        continue;
      }
      let code = code0, matchCode = code0;
      while (font.composite) {
        if (font.composite.mapType !== 2) throw new PsFault('invalidfont');
        const selector = code; font = descendant(font, selector); code = read(); matchCode = selector * 256 + code; push(font);
      }
      const mapped = font.encoding[code]; vm.budget.work(1, 'font encoding lookup');
      const parent = chain.length > 1 ? chain[chain.length - 2] : undefined;
      return { font, root, code, matchCode, name: typeof mapped === 'string' ? mapped : '.notdef', matrix: parent ? mul(font.matrix, parent.matrix) : font.matrix };
    }
  } };
}
