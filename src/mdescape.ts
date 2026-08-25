/** Markdown escaping, shared by every producer of Markdown text.
 *
 *  Its own module because `tablemodel.ts` needs the cell escaper and is a leaf —
 *  importing `mdexport.ts` would close a cycle (mdexport → docmodel →
 *  tablemodel). The same split `fieldstyle.ts`, `choiceopt.ts` and
 *  `bordersides.ts` already make.
 *
 *  **Invariant:** correctness is defined against our own parser, never against a
 *  hand-written character list: `parseMarkdown(escapeX(s))` must yield text
 *  equal to `s`. Under-escaping turns body text into markup; over-escaping
 *  litters the output with backslashes. Both are visible to a round trip;
 *  neither is visible to a list of characters someone thought of. */

/** Characters that are structural wherever an inline run is parsed. */
const INLINE_SPECIAL = /[\\`*_[\]<&~]/g;

/** The block escaper's set: the above plus `|`.
 *
 *  A lone pipe is not structural without a delimiter row, so this rule is
 *  defensive rather than load-bearing — but it is what `escapeMarkdown` has
 *  always done, and moving the function must not move any existing caller's
 *  output. `escapeTableCell` reaches `|` by its own route, where it IS
 *  load-bearing. */
const BLOCK_SPECIAL = /[\\`*_[\]<&~|]/g;

/** The inline set alone. Correct anywhere an inline run is parsed. */
export function escapeMarkdownInline(text: string): string {
  return text.replace(INLINE_SPECIAL, (c) => `\\${c}`);
}

/** Escape one line: the inline set everywhere, plus the block openers that are
 *  structural only at a line's start. CommonMark allows a backslash escape
 *  before any ASCII punctuation, so every case here has the same spelling. */
function escapeLine(line: string): string {
  let out = line.replace(BLOCK_SPECIAL, (c) => `\\${c}`);
  // Up to three leading spaces still open a block; four make it indented code,
  // which the callers below never emit.
  out = out.replace(/^(\s{0,3})([#>+=-])/, '$1\\$2');
  out = out.replace(/^(\s{0,3})(\d{1,9})([.)])/, '$1$2\\$3');
  return out;
}

/** Escape text so it survives a Markdown round trip as literal text, in a
 *  BLOCK context — where a line's first character can open a construct. */
export function escapeMarkdown(text: string): string {
  return text.split('\n').map(escapeLine).join('\n');
}

/** Escape text for a GFM table cell.
 *
 *  The inline set plus `|`, and deliberately NOT the block openers: a cell's
 *  content is parsed as inline only, so `#`, `>`, `-` and `1.` cannot open
 *  anything there. Escaping them would be correct but needless noise — a cell
 *  reading `3.5` would ship as `3\.5`. `|` is the opposite case: structural
 *  inside a cell and nowhere else. */
export function escapeTableCell(text: string): string {
  return escapeMarkdownInline(text).replace(/\|/g, '\\|');
}

/** A link destination, ready to sit inside the parentheses of `[text](...)`.
 *
 *  CommonMark offers two forms and they fail on opposite inputs: the bare form
 *  cannot hold whitespace and needs its parentheses balanced, while the pointy
 *  form cannot hold an unescaped `<` or `>`. Emitting the bare form always is
 *  how a destination with a space in it silently truncates the link at the
 *  space; emitting the pointy form always is how one containing `>` does.
 *
 *  So: pointy whenever the destination holds whitespace or a parenthesis (the
 *  bare form's two hazards), bare otherwise — and the chosen form's own
 *  metacharacters are backslash-escaped either way. A bare `\` is escaped in
 *  both, since it would otherwise consume the character after it. */
export function escapeLinkDestination(uri: string): string {
  if (/[\s()]/.test(uri)) return `<${uri.replace(/[\\<>]/g, (c) => `\\${c}`)}>`;
  return uri.replace(/[\\<>]/g, (c) => `\\${c}`);
}

/** Wrap already-escaped text in the delimiters its style calls for.
 *
 *  Takes ESCAPED text and never escapes its own delimiters — that split is what
 *  makes this safe: `escapeMarkdown`/`escapeMarkdownInline` already escape `*`
 *  and `_`, so an emitted delimiter can never collide with a literal asterisk
 *  the document contained.
 *
 *  `*` rather than `_`, because `_` does not emphasize intraword and PDF text
 *  runs split mid-word constantly.
 *
 *  Sub/superscript has no CommonMark spelling, so it is raw `<sub>`/`<sup>` —
 *  the precedent `Table.toMarkdown` sets by emitting `<br>` for a cell newline,
 *  under the rule that what the grammar cannot express is reported rather than
 *  dropped. It nests OUTSIDE the emphasis so the `*` delimiters stay adjacent
 *  to the text, which is what CommonMark's flanking rules look at.
 *
 *  **Invariant:** surrounding whitespace is hoisted outside the delimiters. A
 *  closing `**` preceded by whitespace is not a closer, so `** bold **` renders
 *  its asterisks literally instead of emphasizing — the same move
 *  `mdexport.ts`'s link case already makes for `[the docs ](url)`.
 *
 *  **Invariant:** correctness is defined against our own parser, as everything
 *  else in this module is: `parseMarkdown(emphasizeMarkdown(escape(s), style))`
 *  must yield `s` carrying that emphasis. */
export function emphasizeMarkdown(
  escaped: string,
  style: { bold?: boolean; italic?: boolean; script?: 'sub' | 'super' },
): string {
  const marks = style.bold && style.italic ? '***' : style.bold ? '**' : style.italic ? '*' : '';
  if (!marks && !style.script) return escaped;
  // An all-whitespace run has nothing to emphasize, and wrapping it would emit
  // delimiters that cannot close.
  const [, lead, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(escaped)!;
  if (!core) return escaped;
  let out = `${marks}${core}${marks}`;
  if (style.script) out = `<${style.script === 'super' ? 'sup' : 'sub'}>${out}</${style.script === 'super' ? 'sup' : 'sub'}>`;
  return `${lead}${out}${tail}`;
}
