// c3t7.7 — sub/superscript on the TAGGED path.
//
// styledRuns works from ONE MCID's glyphs and derives style from the font
// alone. markScriptLevel cannot be applied there: script is measured against
// the LINE's dominant size and baseline, and a /Span around a footnote marker
// contains nothing but the marker, so its own size would be the dominant one
// and the detection would correctly refuse to mark anything. The classification
// is therefore done per PAGE and looked up per glyph.
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { StructElement } from '../src/struct.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';
import { unzip, textOf } from './helpers/unzip.js';
import type { StructTextNode } from '../src/struct.js';

// "Footnote" at 10pt on baseline 200, a 6pt "1" raised to 204, then "follows"
// back on 200. Size ratio 0.6 (under SCRIPT_MAX_SIZE_RATIO 0.85) and a 4pt
// shift (over SCRIPT_MIN_SHIFT_EM * 10 = 1), with the baselines 4pt apart so
// markScriptLevel's max(2, 0.5*max(size)) = 5pt tolerance keeps them one line.
const FOOTNOTE = 'BT /F1 10 Tf 50 200 Td (Footnote) Tj ET '
  + 'BT /F1 6 Tf 90 204 Td (1) Tj ET '
  + 'BT /F1 10 Tf 97 200 Td (follows) Tj ET';

/** The page above, tagged as P > [text, Span > text, text]. The Span holds the
 *  marker and NOTHING else — the shape the issue says defeats a naive port. */
function taggedFootnote(): Document {
  const doc = Document.Open(buildMultiStreamPage([FOOTNOTE]));
  const page = doc.Pages[0];
  const frags = page.GetTextFragments();
  const quadOf = (t: string) => frags.find((f) => f.text === t)!.quad;

  const p = doc.CreateStructTree().Append('P');
  p.MarkContent(page, quadOf('Footnote'));
  p.Append('Span').MarkContent(page, quadOf('1'));
  p.MarkContent(page, quadOf('follows'));
  return doc;
}

/** Every text node under the tree, depth first. */
function textNodes(el: StructElement): StructTextNode[] {
  const out: StructTextNode[] = [];
  for (const n of el.Nodes) {
    if (n instanceof StructElement) out.push(...textNodes(n));
    else out.push(n);
  }
  return out;
}

const allNodes = (doc: Document) =>
  doc.GetStructTree()!.Children.flatMap((c) => textNodes(c));

describe('StructTextNode script', () => {
  it('marks a /Span holding nothing but the marker', () => {
    // The load-bearing case. The Span's own MCID contains one 6pt glyph, so a
    // per-MCID classification has no larger text to measure against and marks
    // nothing at all.
    const marked = allNodes(taggedFootnote()).filter((n) => n.script);
    expect(marked).toHaveLength(1);
    expect(marked[0].text).toBe('1');
    expect(marked[0].script).toBe('super');
  });

  it('leaves the body runs unmarked', () => {
    const nodes = allNodes(taggedFootnote());
    const body = nodes.filter((n) => n.text !== '1');
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((n) => n.script === undefined)).toBe(true);
  });

  it('agrees with the untagged path on the same page', () => {
    // One owner for the rule: the tagged answer must be the answer
    // markScriptLevel already gives through GetTextFragments.
    const doc = taggedFootnote();
    const frag = doc.Pages[0].GetTextFragments().find((f) => f.text === '1')!;
    expect(frag.script).toBe('super');
    expect(allNodes(doc).find((n) => n.text === '1')!.script).toBe(frag.script);
  });

  it('survives a save/open round trip', () => {
    const re = Document.Open(taggedFootnote().Save());
    expect(allNodes(re).find((n) => n.text === '1')!.script).toBe('super');
  });

  it('reaches the DOCX export as w:vertAlign', () => {
    // c3t7.4 built this half for the untagged path; the tagged one had no
    // script to give it until now. ToDocx returns a deflated ZIP, so the part
    // has to be inflated — decoding the archive bytes as text finds nothing.
    const doc = taggedFootnote();
    const xml = textOf(unzip(doc.ToDocx()), 'word/document.xml');
    expect(xml).toContain('<w:vertAlign w:val="superscript"/>');
  });
});
