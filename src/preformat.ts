/** Preformatted text: the rule that lets indentation survive being drawn.
 *
 *  Invariant: a LEAF importing NOTHING. It lives here rather than in
 *  flowblock.ts because two stacks need it and flowblock.ts imports
 *  pagecontent.js and serialize.js — PDF object modules — so cssinline.ts
 *  cannot reach it there without giving up its purity. A second copy of the
 *  rule is the hazard CLAUDE.md names repeatedly; this is colornames.ts's
 *  move.
 *
 *  Invariant: the substitution is U+00A0 and it exists because layoutRuns
 *  COLLAPSES runs of spaces (`a  b` lays out as `a b`), which is fatal to
 *  indentation. U+00A0 costs nothing: `winAnsi[0xA0]` is U+00A0,
 *  WinAnsiEncoding names that code `/space` (Annex D Table D.2's documented
 *  duplicate), and its AFM advance is identical — 278 in Helvetica, 600 in
 *  Courier. Each source line then becomes one unbreakable unit and an
 *  over-wide line falls through the existing UAX #14 path.
 *
 *  Invariant: a SINGLE interior space is left alone. It is an ordinary word
 *  separator and must stay breakable, or a long preformatted line could never
 *  wrap at all. Only a leading run, or a run of two or more, is protected. */

/** The no-break space the substitution below uses. */
export const NBSP = '\u00a0';

/** Expand `line`'s tabs to `tabWidth` columns. A tab expands directly to
 *  no-break spaces: it is indentation by intent, and the run rule below would
 *  otherwise leave a one-column tab unprotected. */
export function expandTabs(line: string, tabWidth: number): string {
  let out = '';
  let col = 0;
  for (const ch of line) {
    if (ch === '\t') {
      const n = tabWidth - (col % tabWidth);
      out += NBSP.repeat(n);
      col += n;
      continue;
    }
    out += ch;
    col++;
  }
  return out;
}

/** Turn source text into text the wrapping engine will not destroy: expand tabs,
 *  then substitute U+00A0 for the spaces — and ONLY the spaces — it would
 *  otherwise eat.
 *
 *  **Invariant:** this substitution happens here, once, and nothing downstream
 *  knows about it. `layoutRuns` skips a line's LEADING spaces outright and
 *  COLLAPSES any run of two or more to one (`a  b` lays out as `a b`), both
 *  fatal to code; adding a preserve-spaces mode to the one wrapping engine would
 *  put every existing caller's byte-identity at risk. U+00A0 costs nothing
 *  instead: `winAnsi[0xA0]` is U+00A0, WinAnsiEncoding names that code /space
 *  (32000-1 Annex D Table D.2's documented duplicate), and its AFM advance is
 *  identical to /space's — so the block measures exactly as the same text with
 *  real spaces would.
 *
 *  **A single interior space is left alone**, which is the whole reason the rule
 *  is selective rather than blanket. The engine does not touch it, and a reader
 *  who copies a code block out of the PDF gets real spaces in `return 1;` rather
 *  than no-break ones that a whitespace-sensitive language may reject. The cost
 *  is that an over-wide line breaks at a space rather than at a UAX #14
 *  opportunity, which for code reads better than the alternative. */
export function preformat(text: string, tabWidth: number): string {
  return text.split('\n').map((raw) => {
    const line = expandTabs(raw, tabWidth);
    let out = '';
    let i = 0;
    while (i < line.length) {
      if (line[i] !== ' ') { out += line[i]; i++; continue; }
      let j = i;
      while (j < line.length && line[j] === ' ') j++;
      const len = j - i;
      out += i === 0 || len >= 2 ? NBSP.repeat(len) : ' ';
      i = j;
    }
    return out;
  }).join('\n');
}
