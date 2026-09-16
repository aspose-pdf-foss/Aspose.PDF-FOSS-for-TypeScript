import { describe, it, expect } from 'vitest';
import { uaClause } from '../src/uarule.js';

describe('uaClause', () => {
  it('cites the clause number of the part being validated', () => {
    // The same test is numbered differently in the two standards, so a widened
    // rule that keeps citing one part reports the right defect against the
    // wrong document — pdfavalidate.ts's `partClause` rule, for its reason.
    expect(uaClause(1, { 1: '7.1', 2: '8.2.1' })).toBe('ISO 14289-1 §7.1');
    expect(uaClause(2, { 1: '7.1', 2: '8.2.1' })).toBe('ISO 14289-2 §8.2.1');
  });

  it('renders a part that states no clause as undefined rather than throwing', () => {
    // Every part-2-only rule passes `{ 2: ... }` alone, so the part-1 arm is
    // routinely absent. It must not throw — a validator that throws on a rule
    // it cannot cite takes down the whole report.
    expect(uaClause(1, { 2: '8.9.2.2' })).toBe('ISO 14289-1 §undefined');
  });
});
