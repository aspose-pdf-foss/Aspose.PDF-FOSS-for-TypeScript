import { describe, it, expect } from 'vitest';
import { sha1 } from '../src/crypto.js';
import { permissionsToP, permissionsFromP } from '../src/encrypt.js';
import { createHash } from 'node:crypto';

describe('PubSec helpers', () => {
  it('sha1 matches node crypto', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const expected = new Uint8Array(createHash('sha1').update(data).digest());
    expect([...sha1(data)]).toEqual([...expected]);
  });

  it('permissionsFromP inverts permissionsToP', () => {
    const perms = { printing: false, copying: false, modifying: true };
    const P = permissionsToP(perms);
    const back = permissionsFromP(P);
    expect(back.printing).toBe(false);
    expect(back.copying).toBe(false);
    expect(back.modifying).toBe(true);
    expect(back.annotating).toBe(true);   // defaulted-allowed bit stays set
  });
});
