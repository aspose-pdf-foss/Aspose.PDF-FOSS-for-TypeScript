import type { MdAlign, MdBlock, MdDocument, MdInline } from '../../src/mdast.js';
import { filterDisallowedHtml } from '../../src/mdgfm.js';

/** Render a CommonMark AST to the HTML the official spec suite expects.
 *
 *  TEST-ONLY. This exists so that conformance is measurable: the suite's
 *  expectations are HTML, so there is no way to run the 652 cases without a
 *  renderer. HTML is NOT a supported output of this library and nothing in
 *  src/ may import this file.
 *
 *  It is also blind to everything the rendering collapses — list tightness
 *  above all, which drives paragraph spacing in Flow. test/markdown-ast.test.ts
 *  covers that gap.
 *
 *  Output is built through `cr()`, which appends a newline only when the buffer
 *  does not already end in one. That is not cosmetic: in a TIGHT list item a
 *  paragraph contributes its inlines bare and with no line of its own, while
 *  every other block still begins on a fresh line — `<li>a</li>` but
 *  `<li>\n<pre>...`. A renderer that inlines the whole item gets a dozen cases
 *  wrong and looks like a parser bug. */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** Escape text or an attribute value. Exactly these four, as cmark does. */
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESCAPES[c]);
}

/** ASCII characters a URL destination keeps verbatim, matching cmark's
 *  HREF_SAFE table. `%` is among them, which is what stops an existing %20
 *  from being re-encoded into %2520. `&` and `'` are entity-escaped instead
 *  and are handled before this set is consulted. */
const HREF_SAFE = new Set('-_.+!*(),%#@?=;:/$~abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');

const pct = (b: number): string => `%${b.toString(16).toUpperCase().padStart(2, '0')}`;

/** Percent-encode a link destination, then escape it for an attribute. The AST
 *  stores destinations unencoded, so all of this lives here. */
function escapeHref(dest: string): string {
  let out = '';
  for (let i = 0; i < dest.length; i++) {
    const ch = dest[i];
    if (ch === '&') { out += '&amp;'; continue; }
    if (ch === "'") { out += '&#x27;'; continue; }
    const cp = dest.codePointAt(i)!;
    if (cp < 0x80) {
      out += HREF_SAFE.has(ch) ? ch : pct(cp);
      continue;
    }
    // Non-ASCII encodes as its UTF-8 bytes; step past a surrogate pair.
    const s = String.fromCodePoint(cp);
    for (const b of new TextEncoder().encode(s)) out += pct(b);
    i += s.length - 1;
  }
  return out;
}

/** The concatenated text of an inline subtree, for an image's alt attribute. */
function plainText(nodes: MdInline[]): string {
  let out = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text': out += n.value; break;
      case 'code': out += n.value; break;
      case 'softbreak': out += '\n'; break;
      case 'linebreak': out += '\n'; break;
      case 'html_inline': break;
      default: out += plainText(n.children); break;
    }
  }
  return out;
}

class Renderer {
  buf = '';
  /** Seeded to '\n' so the very first cr() is a no-op. */
  lastOut = '\n';
  /** The enclosing table's column alignments, which a row needs by index. */
  align: (MdAlign | null)[] = [];
  /** Apply GFM's disallowed-raw-HTML filter, which is a render-time transform. */
  gfm = false;

  lit(s: string): void {
    if (s === '') return;
    this.buf += s;
    this.lastOut = s;
  }

  cr(): void {
    if (this.lastOut !== '\n') this.lit('\n');
  }

  inline(n: MdInline): void {
    switch (n.type) {
      case 'text': this.lit(esc(n.value)); break;
      case 'softbreak': this.lit('\n'); break;
      case 'linebreak': this.lit('<br />'); this.cr(); break;
      case 'code': this.lit(`<code>${esc(n.value)}</code>`); break;
      case 'html_inline': this.lit(this.gfm ? filterDisallowedHtml(n.literal) : n.literal); break;
      case 'emph': this.lit('<em>'); this.inlines(n.children); this.lit('</em>'); break;
      case 'strong': this.lit('<strong>'); this.inlines(n.children); this.lit('</strong>'); break;
      case 'strikethrough': this.lit('<del>'); this.inlines(n.children); this.lit('</del>'); break;
      case 'link': {
        const title = n.title === '' ? '' : ` title="${esc(n.title)}"`;
        this.lit(`<a href="${escapeHref(n.destination)}"${title}>`);
        this.inlines(n.children);
        this.lit('</a>');
        break;
      }
      case 'image': {
        const title = n.title === '' ? '' : ` title="${esc(n.title)}"`;
        this.lit(`<img src="${escapeHref(n.destination)}" alt="${esc(plainText(n.children))}"${title} />`);
        break;
      }
    }
  }

  inlines(nodes: MdInline[]): void {
    for (const n of nodes) this.inline(n);
  }

  /** `tight` is the enclosing list's tightness, which only a paragraph reads. */
  block(n: MdBlock, tight: boolean): void {
    switch (n.type) {
      case 'document':
        this.blocks(n.children, false);
        break;
      case 'paragraph':
        if (tight) { this.inlines(n.children); break; }
        this.cr();
        this.lit('<p>');
        this.inlines(n.children);
        this.lit('</p>');
        this.cr();
        break;
      case 'heading':
        this.cr();
        this.lit(`<h${n.level}>`);
        this.inlines(n.children);
        this.lit(`</h${n.level}>`);
        this.cr();
        break;
      case 'thematic_break':
        this.cr();
        this.lit('<hr />');
        this.cr();
        break;
      case 'code_block': {
        const lang = n.info.split(/[ \t]/, 1)[0];
        const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
        this.cr();
        this.lit(`<pre><code${cls}>${esc(n.literal)}</code></pre>`);
        this.cr();
        break;
      }
      case 'html_block': {
        const literal = this.gfm ? filterDisallowedHtml(n.literal) : n.literal;
        this.cr();
        this.lit(literal.replace(/\n$/, ''));
        this.cr();
        break;
      }
      case 'block_quote':
        this.cr();
        this.lit('<blockquote>');
        this.cr();
        this.blocks(n.children, false);
        this.cr();
        this.lit('</blockquote>');
        this.cr();
        break;
      case 'list': {
        const tag = n.ordered ? 'ol' : 'ul';
        const start = n.ordered && n.start !== 1 ? ` start="${n.start}"` : '';
        this.cr();
        this.lit(`<${tag}${start}>`);
        this.cr();
        for (const item of n.children) this.block(item, n.tight);
        this.cr();
        this.lit(`</${tag}>`);
        this.cr();
        break;
      }
      case 'table': {
        this.align = n.align;
        this.cr();
        this.lit('<table>');
        this.cr();
        const [head, ...body] = n.children;
        if (head !== undefined) {
          this.lit('<thead>');
          this.cr();
          this.block(head, tight);
          this.lit('</thead>');
          this.cr();
        }
        // No rows in the body means no <tbody> at all.
        if (body.length > 0) {
          this.lit('<tbody>');
          this.cr();
          for (const row of body) this.block(row, tight);
          this.lit('</tbody>');
          this.cr();
        }
        this.lit('</table>');
        this.cr();
        break;
      }
      case 'table_row': {
        this.lit('<tr>');
        this.cr();
        const tag = n.header ? 'th' : 'td';
        for (let i = 0; i < n.children.length; i++) {
          const a = this.align[i] ?? undefined;
          this.lit(`<${tag}${a === undefined ? '' : ` align="${a}"`}>`);
          this.inlines(n.children[i].children);
          this.lit(`</${tag}>`);
          this.cr();
        }
        this.lit('</tr>');
        this.cr();
        break;
      }
      case 'table_cell':
        // Rendered by its row, which needs the column index for the alignment.
        break;
      case 'item':
        this.cr();
        this.lit('<li>');
        // The space is the one that followed the marker. The parser drops it as
        // insignificant leading whitespace — the AST cannot carry it, since a
        // leaf's staged text is trimmed before inline parsing — so the oracle
        // puts it back, exactly as it puts back percent-encoding.
        if (n.checked !== undefined) {
          this.lit(`<input ${n.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `);
        }
        this.blocks(n.children, tight);
        this.lit('</li>');
        this.cr();
        break;
    }
  }

  blocks(nodes: MdBlock[], tight: boolean): void {
    for (const n of nodes) this.block(n, tight);
  }
}

export interface RenderOptions {
  /** Apply GFM's disallowed-raw-HTML filter, which the spec defines as a
   *  rendering transform and which therefore lives here rather than in the
   *  tree. */
  gfm?: boolean;
}

export function renderHtml(doc: MdDocument, options?: RenderOptions): string {
  const r = new Renderer();
  r.gfm = options?.gfm === true;
  r.block(doc, false);
  return r.buf;
}
