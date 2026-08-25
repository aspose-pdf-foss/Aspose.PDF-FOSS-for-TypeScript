import { describe, it, expect } from 'vitest';
import {
  clampWeight, deriveStyle, familyMatches, matchChain, matchFace, weightFromSubfamily,
} from '../src/fontmatch.js';
import type { FontNames } from '../src/fontnames.js';
import type { FaceRecord } from '../src/fontsource.js';

/** A FaceRecord over hand-written naming fields — the whole point of the pure
 *  split: no temp folder, no sfnt, no Document. `weight` defaults to 400
 *  because that is what an ABSENT OS/2 table yields, which is the case the
 *  corroboration rule exists for. */
export function rec(
  n: Partial<FontNames> & { family: string },
  path = `${n.family}-${n.subfamily ?? 'Regular'}.ttf`,
): FaceRecord {
  return {
    path,
    faceIndex: 0,
    names: {
      family: n.family,
      subfamily: n.subfamily ?? 'Regular',
      typographicFamily: n.typographicFamily,
      typographicSubfamily: n.typographicSubfamily,
      postScriptName: n.postScriptName,
      bold: n.bold ?? false,
      italic: n.italic ?? false,
      weight: n.weight ?? 400,
    },
  };
}

describe('weightFromSubfamily', () => {
  it('reads the nine documented weight words', () => {
    expect(weightFromSubfamily('Thin')).toBe(100);
    expect(weightFromSubfamily('ExtraLight')).toBe(200);
    expect(weightFromSubfamily('Light')).toBe(300);
    expect(weightFromSubfamily('Regular')).toBe(400);
    expect(weightFromSubfamily('Medium')).toBe(500);
    expect(weightFromSubfamily('SemiBold')).toBe(600);
    expect(weightFromSubfamily('Bold')).toBe(700);
    expect(weightFromSubfamily('ExtraBold')).toBe(800);
    expect(weightFromSubfamily('Black')).toBe(900);
  });

  it('prefers the longer word where one contains another', () => {
    // 'ExtraLight' contains 'Light' and 'SemiBold' contains 'Bold', so a
    // first-match scan in the wrong order silently reports 300 and 700 —
    // plausible weights, and both wrong. Order is the whole rule here.
    expect(weightFromSubfamily('Extra Light')).toBe(200);
    expect(weightFromSubfamily('UltraLight')).toBe(200);
    expect(weightFromSubfamily('Demi Bold')).toBe(600);
    expect(weightFromSubfamily('UltraBold')).toBe(800);
  });

  it('reports nothing for a word that names no weight', () => {
    expect(weightFromSubfamily('Condensed')).toBeUndefined();
    expect(weightFromSubfamily('')).toBeUndefined();
  });
});

describe('deriveStyle — weight', () => {
  it('trusts a stated weight that is not the default', () => {
    expect(deriveStyle(rec({ family: 'F', subfamily: 'Light', weight: 300 }).names).weight).toBe(300);
    expect(deriveStyle(rec({ family: 'F', subfamily: 'Bold', weight: 700 }).names).weight).toBe(700);
  });

  it('does NOT re-derive a stated weight from the subfamily name', () => {
    // 'Roboto Condensed Light' at a stated 300 must stay 300. The name is a
    // second opinion nobody asked for once the font made a numeric statement.
    const n = rec({ family: 'F', subfamily: 'Bold', weight: 300 }).names;
    expect(deriveStyle(n).weight).toBe(300);
  });

  it('corroborates a weight of 400 from the macStyle bold bit', () => {
    // 400 is ALSO what an absent OS/2 and a stated 0 produce, so it is the one
    // value that may mean "said nothing". A mis-stated Bold left at 400 is both
    // unreachable at 700 and a rival for the face returned at 400.
    const n = rec({ family: 'F', subfamily: 'Bold', weight: 400, bold: true }).names;
    expect(deriveStyle(n).weight).toBe(700);
  });

  it('corroborates a weight of 400 from the subfamily with the bit clear', () => {
    const n = rec({ family: 'F', subfamily: 'SemiBold', weight: 400 }).names;
    expect(deriveStyle(n).weight).toBe(600);
  });

  it('prefers the typographic subfamily (ID 17) over ID 2', () => {
    // The everyday shape: ID 1 'Roboto Light' / ID 2 'Regular', with the
    // typographic pair saying 'Roboto' / 'Light'. Read ID 2 and every weight of
    // the family derives as 400.
    const n = rec({
      family: 'Roboto Light', subfamily: 'Regular',
      typographicFamily: 'Roboto', typographicSubfamily: 'Light', weight: 400,
    }).names;
    expect(deriveStyle(n).weight).toBe(300);
  });

  it('falls back to 400 when nothing states a weight', () => {
    expect(deriveStyle(rec({ family: 'F' }).names).weight).toBe(400);
  });
});

describe('deriveStyle — slant', () => {
  it('reads the macStyle italic bit', () => {
    expect(deriveStyle(rec({ family: 'F', italic: true }).names).italic).toBe(true);
  });

  it('reads "italic" and "oblique" from the subfamily with the bit clear', () => {
    // head.macStyle has no oblique bit, so a face named Oblique that leaves the
    // italic bit clear is otherwise invisible to an italic request.
    expect(deriveStyle(rec({ family: 'F', subfamily: 'Italic' }).names).italic).toBe(true);
    expect(deriveStyle(rec({ family: 'F', subfamily: 'Oblique' }).names).italic).toBe(true);
    expect(deriveStyle(rec({ family: 'F', subfamily: 'Bold Oblique' }).names).italic).toBe(true);
  });

  it('is upright when neither signal fires', () => {
    expect(deriveStyle(rec({ family: 'F', subfamily: 'Bold' }).names).italic).toBe(false);
  });
});

/** Roboto in six weights, upright, in a deliberately unsorted order so that a
 *  matcher which merely takes the first or last face cannot pass. */
const ROBOTO = [
  rec({ family: 'Roboto', subfamily: 'Medium', weight: 500 }),
  rec({ family: 'Roboto', subfamily: 'Thin', weight: 100 }),
  rec({ family: 'Roboto', subfamily: 'Bold', weight: 700 }),
  rec({ family: 'Roboto', subfamily: 'Regular', weight: 400 }),
  rec({ family: 'Roboto', subfamily: 'Black', weight: 900 }),
  rec({ family: 'Roboto', subfamily: 'Light', weight: 300 }),
];

/** The full 5.2 order for `want`, by asking repeatedly and removing the
 *  winner -- one lucky pick proves nothing about the ORDER. */
function walkOrder(faces: FaceRecord[], want: number): number[] {
  const pool = [...faces];
  const out: number[] = [];
  while (pool.length > 0) {
    const hit = matchFace(pool, 'roboto', { weight: want, italic: false })!;
    out.push(deriveStyle(hit.names).weight);
    pool.splice(pool.indexOf(hit), 1);
  }
  return out;
}

describe('clampWeight', () => {
  it('defaults to 400 and clamps to 1..1000 rather than rejecting', () => {
    // A number in an options bag, not a document we are parsing.
    expect(clampWeight(undefined)).toBe(400);
    expect(clampWeight(700)).toBe(700);
    expect(clampWeight(0)).toBe(1);
    expect(clampWeight(5000)).toBe(1000);
    expect(clampWeight(Number.NaN)).toBe(400);
    expect(clampWeight(612.4)).toBe(612);
  });
});

describe('familyMatches', () => {
  it('matches the typographic family (ID 16) and ID 1 alike', () => {
    const n = rec({ family: 'Foo Semibold', typographicFamily: 'Foo' }).names;
    expect(familyMatches(n, 'foo')).toBe(true);
    expect(familyMatches(n, 'foo semibold')).toBe(true);
    expect(familyMatches(n, 'bar')).toBe(false);
  });
});

describe('matchFace -- the CSS Fonts 4 5.2 weight walk', () => {
  it('walks 400 as: >=want and <=500 asc, then <want desc, then >500 asc', () => {
    expect(walkOrder(ROBOTO, 400)).toEqual([400, 500, 300, 100, 700, 900]);
  });

  it('walks 500 the same way, which leaves only 500 in the first tier', () => {
    expect(walkOrder(ROBOTO, 500)).toEqual([500, 400, 300, 100, 700, 900]);
  });

  it('walks a want below 400 as: <=want desc, then >want asc', () => {
    expect(walkOrder(ROBOTO, 300)).toEqual([300, 100, 400, 500, 700, 900]);
  });

  it('walks a want above 500 as: >=want asc, then <want desc', () => {
    expect(walkOrder(ROBOTO, 600)).toEqual([700, 900, 500, 400, 300, 100]);
    expect(walkOrder(ROBOTO, 900)).toEqual([900, 700, 500, 400, 300, 100]);
  });
});

describe('matchFace -- slant', () => {
  it('OUTRANKS weight: an italic request takes Italic over Bold', () => {
    // The surprising half of 5.2, and the rule most likely to be "corrected"
    // by a later reader. A weight-first matcher returns Bold, which is a
    // perfectly plausible face -- which is why this is asserted alone.
    const faces = [
      rec({ family: 'Alpha', subfamily: 'Regular', weight: 400 }),
      rec({ family: 'Alpha', subfamily: 'Bold', weight: 700 }),
      rec({ family: 'Alpha', subfamily: 'Italic', weight: 400, italic: true }),
    ];
    const hit = matchFace(faces, 'alpha', { weight: 700, italic: true })!;
    expect(hit.names.subfamily).toBe('Italic');
  });

  it('falls back to the wrong slant rather than to nothing', () => {
    const faces = [rec({ family: 'Alpha', subfamily: 'Regular', weight: 400 })];
    expect(matchFace(faces, 'alpha', { weight: 400, italic: true })).toBeDefined();
  });

  it('picks the best weight WITHIN the matching slant', () => {
    // Measured: an obvious fixture here does NOT pin the slant pass. Ask a
    // family of [Regular, Italic, Bold Italic] for { 700, italic } and Bold
    // Italic wins with the slant pass DELETED too, being an exact weight hit
    // either way. The upright face must therefore be a BETTER weight match than
    // any italic one -- Black 900 against a requested 900 -- so that a
    // slant-blind matcher visibly prefers it.
    const faces = [
      rec({ family: 'Alpha', subfamily: 'Regular', weight: 400 }),
      rec({ family: 'Alpha', subfamily: 'Black', weight: 900 }),
      rec({ family: 'Alpha', subfamily: 'Italic', weight: 400, italic: true }),
      rec({ family: 'Alpha', subfamily: 'Bold Italic', weight: 700, italic: true }),
    ];
    const hit = matchFace(faces, 'alpha', { weight: 900, italic: true })!;
    expect(hit.names.subfamily).toBe('Bold Italic');
  });
});

describe('matchFace -- ties and misses', () => {
  it('breaks a tie by index order, which is registration then directory order', () => {
    const faces = [
      rec({ family: 'Alpha', weight: 400 }, 'first.ttf'),
      rec({ family: 'Alpha', weight: 400 }, 'second.ttf'),
    ];
    expect(matchFace(faces, 'alpha', { weight: 400, italic: false })!.path).toBe('first.ttf');
  });

  it('returns undefined only when the family is absent', () => {
    expect(matchFace(ROBOTO, 'nonexistent', { weight: 400, italic: false })).toBeUndefined();
  });
});

describe('matchChain', () => {
  it('stops at the first PRESENT family even when a later one has the exact style', () => {
    // The decision at the top of the design: the chain selects a FAMILY, and
    // style matching then runs inside the winner. Arial exists in Regular only,
    // Liberation Sans has a real Bold, and the answer at weight 700 is Arial
    // Regular. This looks like a bug, so it is asserted directly.
    const faces = [
      rec({ family: 'Arial', subfamily: 'Regular', weight: 400 }),
      rec({ family: 'Liberation Sans', subfamily: 'Regular', weight: 400 }),
      rec({ family: 'Liberation Sans', subfamily: 'Bold', weight: 700 }),
    ];
    const hit = matchChain(faces, ['Arial', 'Liberation Sans'], { weight: 700, italic: false })!;
    expect(hit.names.family).toBe('Arial');
  });

  it('falls to the next family when the first is absent', () => {
    const faces = [rec({ family: 'Liberation Sans', subfamily: 'Bold', weight: 700 })];
    const hit = matchChain(faces, ['Arial', 'Liberation Sans'], { weight: 700, italic: false })!;
    expect(hit.names.family).toBe('Liberation Sans');
  });

  it('trims, lower-cases and skips empty names', () => {
    const faces = [rec({ family: 'Arial', weight: 400 })];
    expect(matchChain(faces, ['', '  ARIAL '], { weight: 400, italic: false })).toBeDefined();
    expect(matchChain(faces, [], { weight: 400, italic: false })).toBeUndefined();
  });
});
