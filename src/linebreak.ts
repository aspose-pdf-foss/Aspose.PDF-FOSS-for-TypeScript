import { LB, EA, lineBreak, combiningClass, eastAsianWidth, quoteClass } from './unicode-data.js';

export const LBRK = { PROHIBITED: 0, ALLOWED: 1, MANDATORY: 2 } as const;

const N = 48; // number of LB classes
const P = 1;  // pair-table cell: no break (×)
const D = 0;  // pair-table cell: break allowed (÷) — LB31 default
const DOTTED = 0x25cc; // ◌ DOTTED CIRCLE — the LB28a base placeholder (class AL)

/** LB1: resolve ambiguous/unknown/surrogate and CJ/SA to concrete classes. */
function resolve(cp: number): number {
  const c = lineBreak(cp);
  switch (c) {
    case LB.AI: case LB.SG: case LB.XX: return LB.AL;
    case LB.SA: return combiningClass(cp) ? LB.CM : LB.AL;
    case LB.CJ: return LB.NS;
    default: return c;
  }
}

function eaWide(cp: number): boolean {
  const w = eastAsianWidth(cp);
  return w === EA.F || w === EA.W || w === EA.H;
}

// Adjacent (no intervening space) pair table, indexed [before][after]. Built by
// applying rules from LOWEST priority to HIGHEST; a higher-priority rule
// overwrites. Space/ZW/mandatory/CM/quote/EAW rules are handled in the loop, so
// LB30 (needs East-Asian width) and LB15a/b (need Pi/Pf) are NOT in the table.
const PAIR: Uint8Array = (() => {
  const t = new Uint8Array(N * N).fill(D);
  const S = (a: number, b: number, v: number) => { t[a * N + b] = v; };
  const set2 = (as: number[], bs: number[], v: number) => { for (const a of as) for (const b of bs) S(a, b, v); };
  const each = (fn: (a: number, b: number) => void) => { for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) fn(a, b); };

  const AL = [LB.AL, LB.HL];
  const HANG = [LB.JL, LB.JV, LB.JT, LB.H2, LB.H3];

  // LB30b: EB × EM
  S(LB.EB, LB.EM, P);
  // LB29: IS × (AL|HL)
  set2([LB.IS], AL, P);
  // LB28a (class-expressible parts): AP × (AK|AS) ; (AK|AS) × (VF|VI)
  set2([LB.AP], [LB.AK, LB.AS], P);
  set2([LB.AK, LB.AS], [LB.VF, LB.VI], P);
  // LB28: (AL|HL) × (AL|HL)
  set2(AL, AL, P);
  // LB27: (JL|JV|JT|H2|H3) × PO ; PR × (JL|JV|JT|H2|H3)
  set2(HANG, [LB.PO], P);
  set2([LB.PR], HANG, P);
  // LB26: JL × (JL|JV|H2|H3) ; (JV|H2) × (JV|JT) ; (JT|H3) × JT
  set2([LB.JL], [LB.JL, LB.JV, LB.H2, LB.H3], P);
  set2([LB.JV, LB.H2], [LB.JV, LB.JT], P);
  set2([LB.JT, LB.H3], [LB.JT], P);
  // LB25 context-free numeric pairs. (HY/SY × NU, the OP-prefix, and the
  // CL/CP-closing cases are context-sensitive and handled by the numeric scan.)
  S(LB.IS, LB.NU, P);                         // IS × NU
  S(LB.NU, LB.NU, P);                         // NU × NU
  set2([LB.PO, LB.PR], [LB.NU], P);           // PO/PR × NU
  set2([LB.NU], [LB.PO, LB.PR], P);           // NU × PO/PR
  // LB24: (PR|PO) × (AL|HL) ; (AL|HL) × (PR|PO)
  set2([LB.PR, LB.PO], AL, P);
  set2(AL, [LB.PR, LB.PO], P);
  // LB23a: PR × (ID|EB|EM) ; (ID|EB|EM) × PO
  set2([LB.PR], [LB.ID, LB.EB, LB.EM], P);
  set2([LB.ID, LB.EB, LB.EM], [LB.PO], P);
  // LB23: (AL|HL) × NU ; NU × (AL|HL)
  set2(AL, [LB.NU], P);
  set2([LB.NU], AL, P);
  // LB22: × IN
  each((a, b) => { if (b === LB.IN) S(a, b, P); });
  // LB21: × BA ; × HY ; × NS ; BB ×
  each((a, b) => { if (b === LB.BA || b === LB.HY || b === LB.NS) S(a, b, P); });
  each((a, b) => { if (a === LB.BB) S(a, b, P); });
  // LB21b: SY × HL
  S(LB.SY, LB.HL, P);
  // LB20: ÷ CB ; CB ÷
  each((a, b) => { if (a === LB.CB || b === LB.CB) S(a, b, D); });
  // LB19: × QU ; QU ×
  each((a, b) => { if (a === LB.QU || b === LB.QU) S(a, b, P); });
  // LB16: (CL|CP) × NS (adjacent)
  set2([LB.CL, LB.CP], [LB.NS], P);
  // LB17: B2 × B2 (adjacent)
  S(LB.B2, LB.B2, P);
  // LB14: OP × (anything)
  each((a, b) => { if (a === LB.OP) S(a, b, P); });
  // LB13: × CL ; × CP ; × EX ; × SY ; × IS
  each((a, b) => { if (b === LB.CL || b === LB.CP || b === LB.EX || b === LB.SY || b === LB.IS) S(a, b, P); });
  // LB12: GL ×
  each((a, b) => { if (a === LB.GL) S(a, b, P); });
  // LB12a: [^SP BA HY] × GL
  each((a, b) => { if (b === LB.GL && a !== LB.BA && a !== LB.HY && a !== LB.SP) S(a, b, P); });
  // LB11: × WJ ; WJ ×
  each((a, b) => { if (a === LB.WJ || b === LB.WJ) S(a, b, P); });
  return t;
})();

/** UAX #14 default break opportunities. result[i] classifies the boundary
 *  before codes[i]; result[0] is always PROHIBITED (LB2). Pure; never throws. */
export function lineBreakOpportunities(codes: number[]): Uint8Array {
  const n = codes.length;
  const out = new Uint8Array(n); // 0 = PROHIBITED by default (LB2 at index 0)
  if (n === 0) return out;

  const raw = codes.map(resolve);
  const cls = raw.slice();
  const attach = new Array<boolean>(n).fill(false); // LB9: CM/ZWJ folded into base
  if (raw[0] === LB.CM || raw[0] === LB.ZWJ) cls[0] = LB.AL; // LB10: leading CM → AL
  for (let i = 1; i < n; i++) {
    if (raw[i] === LB.CM || raw[i] === LB.ZWJ) {
      const base = cls[i - 1];
      const breaksBase = base === LB.BK || base === LB.CR || base === LB.LF || base === LB.NL || base === LB.SP || base === LB.ZW;
      if (breaksBase) cls[i] = LB.AL;             // LB10: standalone CM → AL
      else { cls[i] = base; attach[i] = true; }   // LB9: attach to base
    }
  }

  // LB25 numeric sequences: (PR|PO)? (OP|HY)? NU (NU|SY|IS)* (CL|CP)? (PO|PR)?.
  // Mark every interior boundary of a matched run as prohibited.
  const lb25 = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    let p = i;
    if (cls[p] === LB.PR || cls[p] === LB.PO) p++;
    if (cls[p] === LB.OP || cls[p] === LB.HY) p++;
    if (cls[p] !== LB.NU) continue;              // no numeric core → not a number
    p++;
    while (p < n && (cls[p] === LB.NU || cls[p] === LB.SY || cls[p] === LB.IS)) p++;
    if (p < n && (cls[p] === LB.CL || cls[p] === LB.CP)) p++;
    if (p < n && (cls[p] === LB.PO || cls[p] === LB.PR)) p++;
    for (let k = i + 1; k < p; k++) lb25[k] = true; // interior boundaries: no break
    i = p - 1;                                    // skip past this number
  }

  const akGroup = (i: number) => cls[i] === LB.AK || cls[i] === LB.AS || codes[i] === DOTTED;
  // LB20a: (sot|BK|CR|LF|NL|SP|ZW|CB|GL) (HY|U+2010) × AL — no break after a
  // line-initial or post-space hyphen. The hyphen unit is a HY (or U+2010) base
  // plus any attached combining marks (LB9).
  const lb20aHyphen = (i: number): boolean => {
    let h = i - 1;
    while (h > 0 && attach[h]) h--;                    // back to the hyphen base
    if (!(cls[h] === LB.HY || codes[h] === 0x2010)) return false;
    if (h === 0) return true;                          // sot before the hyphen
    const x = cls[h - 1];
    return x === LB.BK || x === LB.CR || x === LB.LF || x === LB.NL
      || x === LB.SP || x === LB.ZW || x === LB.CB || x === LB.GL;
  };
  const openCtx = (x: number) => x === LB.BK || x === LB.CR || x === LB.LF || x === LB.NL
    || x === LB.OP || x === LB.QU || x === LB.GL || x === LB.SP || x === LB.ZW;
  // LB15a: a Pi-QU (with valid left context) that we are currently "inside".
  const isOpenQu = (i: number) => raw[i] === LB.QU && quoteClass(codes[i]) === 1
    && (i === 0 || openCtx(cls[i - 1]));
  // LB15b close-context: the class after a Pf-QU that suppresses a break before it.
  const closeCtx = (x: number) => x === LB.SP || x === LB.GL || x === LB.WJ || x === LB.CL
    || x === LB.QU || x === LB.CP || x === LB.EX || x === LB.IS || x === LB.SY
    || x === LB.BK || x === LB.CR || x === LB.LF || x === LB.NL || x === LB.ZW;

  let b = cls[0];        // class of the last non-space, significant char
  let bIdx = 0;          // code index of `b` (for East-Asian width)
  let sp = cls[0] === LB.SP;  // a SP has intervened since `b` (incl. leading SP)
  let zw = cls[0] === LB.ZW;   // last significant char was ZW (LB8: ZW SP* ÷)
  let riRun = cls[0] === LB.RI ? 1 : 0;
  let openQu = isOpenQu(0);

  for (let i = 1; i < n; i++) {
    const c = cls[i];
    const prev = cls[i - 1];

    // LB4/LB5/LB6 — mandatory breaks. (A SP right after the break is leading
    // whitespace on the new line: record it so the next boundary sees LB18.)
    if (prev === LB.BK || prev === LB.LF || prev === LB.NL) { out[i] = LBRK.MANDATORY; b = c; bIdx = i; sp = c === LB.SP; zw = false; riRun = c === LB.RI ? 1 : 0; openQu = isOpenQu(i); continue; }
    if (prev === LB.CR) { out[i] = c === LB.LF ? LBRK.PROHIBITED : LBRK.MANDATORY; b = c; bIdx = i; sp = c === LB.SP; zw = false; riRun = c === LB.RI ? 1 : 0; openQu = isOpenQu(i); continue; }
    if (c === LB.BK || c === LB.CR || c === LB.LF || c === LB.NL) { out[i] = LBRK.PROHIBITED; b = c; bIdx = i; sp = false; zw = false; riRun = 0; openQu = false; continue; } // LB6

    // LB7 — no break before SP / ZW (keep openQu/zw state across spaces).
    if (c === LB.SP) { out[i] = LBRK.PROHIBITED; sp = true; continue; }
    if (c === LB.ZW) { out[i] = LBRK.PROHIBITED; b = c; bIdx = i; sp = false; zw = true; riRun = 0; openQu = false; continue; }
    // LB8 — break after ZW (even across spaces).
    if (zw) { out[i] = LBRK.ALLOWED; b = c; bIdx = i; sp = false; zw = false; riRun = c === LB.RI ? 1 : 0; openQu = isOpenQu(i); continue; }
    // LB9 — CM/ZWJ attaching to base: no break before it. The CM is part of the
    // base unit, so `openQu` (an open Pi-quote base) carries through unchanged.
    if (attach[i] && !sp) { out[i] = LBRK.PROHIBITED; b = c; bIdx = i; continue; }
    // LB8a — no break after ZWJ.
    if (raw[i - 1] === LB.ZWJ) { out[i] = LBRK.PROHIBITED; b = c; bIdx = i; sp = false; riRun = c === LB.RI ? 1 : 0; openQu = isOpenQu(i); continue; }

    let brk: number;
    // LB15b — no break before a Pf-QU followed by a close context (or eot).
    if (raw[i] === LB.QU && quoteClass(codes[i]) === 2 && (i + 1 >= n || closeCtx(cls[i + 1]))) {
      brk = LBRK.PROHIBITED;
    } else if (openQu) {
      brk = LBRK.PROHIBITED;                                                     // LB15a
    } else if (sp) {
      if (b === LB.OP) brk = LBRK.PROHIBITED;                                    // LB14
      else if ((b === LB.CL || b === LB.CP) && c === LB.NS) brk = LBRK.PROHIBITED; // LB16
      else if (b === LB.B2 && c === LB.B2) brk = LBRK.PROHIBITED;                // LB17
      else if (c === LB.WJ) brk = LBRK.PROHIBITED;                               // LB11
      else if (c === LB.CL || c === LB.CP || c === LB.EX || c === LB.SY || c === LB.IS) brk = LBRK.PROHIBITED; // LB13
      else brk = LBRK.ALLOWED;                                                   // LB18
    } else if ((b === LB.AL || b === LB.HL || b === LB.NU) && c === LB.OP && !eaWide(codes[i])) {
      brk = LBRK.PROHIBITED;                                                     // LB30
    } else if (b === LB.CP && (c === LB.AL || c === LB.HL || c === LB.NU) && !eaWide(codes[bIdx])) {
      brk = LBRK.PROHIBITED;                                                     // LB30
    } else if (lb25[i]) {
      brk = LBRK.PROHIBITED;                                                     // LB25 numeric run
    } else if (c === LB.AL && lb20aHyphen(i)) {
      brk = LBRK.PROHIBITED;                                                     // LB20a
    } else if (b === LB.RI && c === LB.RI) {
      brk = riRun % 2 === 1 ? LBRK.PROHIBITED : LBRK.ALLOWED;                    // LB30a
    } else if (cls[i - 1] === LB.VI && i >= 2 && akGroup(i - 2) && (cls[i] === LB.AK || codes[i] === DOTTED)) {
      brk = LBRK.PROHIBITED;                                                     // LB28a: (AK|◌|AS) VI × (AK|◌)
    } else if (akGroup(i) && i + 1 < n && akGroup(i - 1) && cls[i + 1] === LB.VF) {
      brk = LBRK.PROHIBITED;                                                     // LB28a: (AK|◌|AS) × (AK|◌|AS) VF
    } else if (cls[i - 1] === LB.AP && akGroup(i)) {
      brk = LBRK.PROHIBITED;                                                     // LB28a: AP × (AK|◌|AS)
    } else if (akGroup(i - 1) && (c === LB.VF || c === LB.VI)) {
      brk = LBRK.PROHIBITED;                                                     // LB28a: (AK|◌|AS) × (VF|VI)
    } else {
      brk = PAIR[b * N + c] === P ? LBRK.PROHIBITED : LBRK.ALLOWED;
    }

    out[i] = brk;
    riRun = c === LB.RI ? riRun + 1 : 0;
    b = c;
    bIdx = i;
    sp = false;
    openQu = isOpenQu(i);
  }
  return out;
}
