// c3t7.9 — search the text an annotation CARRIES (/Contents, /T, /Subj), as
// opposed to the text it DRAWS, which is Page.SearchAnnotations (c3t7.6).
//
// Two different features wearing one name; the last test here is what stops
// them quietly collapsing into each other.
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';
import { buildAnnotTextPdf } from './helpers/build-annot-text-pdf.js';
import type { PdfObject } from '../src/types.js';

/** A PDF text string for a key the model exposes no setter for. */
const str = (s: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(s) });

/** One page, one note carrying all three text entries. */
function noteDoc(): Document {
  const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (page) Tj ET']));
  const note = doc.Pages[0].AddTextNote({
    rect: [60, 90, 80, 110], contents: 'body secret', author: 'Ada Lovelace',
  });
  note.Dict.set('Subj', str('Review subject'));
  return doc;
}

describe('Page.SearchAnnotationText', () => {
  it('finds text in /Contents and names the entry', () => {
    const hits = noteDoc().Pages[0].SearchAnnotationText('body secret');
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe('Contents');
    expect(hits[0].value).toBe('body secret');
    expect(hits[0].text).toBe('body secret');
  });

  it('finds text in /T, which a /Contents-only search would miss', () => {
    // The reason this earns an API: test/redact-annots.test.ts already treats
    // an author name as a secret redaction must remove, so a search that
    // reported "not found" for it would contradict the same document's redact.
    const hits = noteDoc().Pages[0].SearchAnnotationText('Lovelace');
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe('T');
    expect(hits[0].value).toBe('Ada Lovelace');
  });

  it('finds text in /Subj', () => {
    const hits = noteDoc().Pages[0].SearchAnnotationText('subject');
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe('Subj');
  });

  it('reports every entry that matches, in Contents/T/Subj order', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (x) Tj ET']));
    const n = doc.Pages[0].AddTextNote({ rect: [60, 90, 80, 110], contents: 'zed', author: 'zed' });
    n.Dict.set('Subj', str('zed'));
    expect(doc.Pages[0].SearchAnnotationText('zed').map((h) => h.key))
      .toEqual(['Contents', 'T', 'Subj']);
  });

  it('applies a RegExp globally within one value', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (x) Tj ET']));
    doc.Pages[0].AddTextNote({ rect: [60, 90, 80, 110], contents: 'a1 b2 c3' });
    const hits = doc.Pages[0].SearchAnnotationText(/[a-c]\d/);
    expect(hits.map((h) => h.text)).toEqual(['a1', 'b2', 'c3']);
    expect(hits.every((h) => h.key === 'Contents')).toBe(true);
  });

  it('searches a HIDDEN annotation, unlike SearchAnnotations', () => {
    // The deliberate divergence. SearchAnnotations filters through
    // isAnnotVisible because it reports what a render DRAWS; this reports what
    // the file CARRIES, and a hidden annotation's text is still in the bytes —
    // and is still what redaction removes.
    const doc = noteDoc();
    doc.Pages[0].Annotations[0].Flags = 2;   // Hidden
    expect(doc.Pages[0].SearchAnnotationText('body secret')).toHaveLength(1);
  });

  it('returns [] for a page with no annotations', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (x) Tj ET']));
    expect(doc.Pages[0].SearchAnnotationText('anything')).toHaveLength(0);
  });

  it('does not search page content', () => {
    expect(noteDoc().Pages[0].SearchAnnotationText('page')).toHaveLength(0);
  });

  it('carries no geometry — a hit must not be feedable to Redact', () => {
    // (a)'s only available geometry is the whole /Rect, which is exactly the
    // shape the c3t7.6 design refused: redacting it burns a box over whatever
    // else sits under the annotation.
    const hit = noteDoc().Pages[0].SearchAnnotationText('body secret')[0];
    expect(Object.keys(hit).sort()).toEqual(['annot', 'key', 'text', 'value']);
  });

  // The two features must not collapse into each other: one reads the /AP, the
  // other reads the dict, and a /FreeText can say different things in each.
  it('is disjoint from SearchAnnotations, in both directions', () => {
    const doc = Document.Open(buildAnnotTextPdf());
    const page = doc.Pages[0];
    // Object 6 is the /FreeText whose appearance draws "bravo".
    const freeText = page.Annotations.find((a) => a.Subtype === 'FreeText')!;
    freeText.Contents = 'carried';

    expect(page.SearchAnnotations('bravo')).toHaveLength(1);
    expect(page.SearchAnnotationText('bravo')).toHaveLength(0);

    expect(page.SearchAnnotationText('carried')).toHaveLength(1);
    expect(page.SearchAnnotations('carried')).toHaveLength(0);
  });
});

describe('Page.SearchAnnotationText — /RC rich content (k2k5)', () => {
  /** A note whose /RC carries markup, in the string shape a producer writes. */
  function rcDoc(markup: string): Document {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (page) Tj ET']));
    // /Contents is deliberately a string sharing NO substring with any query
    // below: it is searched too, so 'plain body' would answer a query for
    // 'body' (and for the 'a' in 'plain') and be mistaken for an /RC hit.
    const note = doc.Pages[0].AddTextNote({ rect: [60, 90, 80, 110], contents: 'zzz' });
    note.Dict.set('RC', str(markup));
    return doc;
  }

  it('searches the TEXT of /RC, not its markup', () => {
    // The defect this closes: the entry holds an XHTML fragment, so a query for
    // the words a reader sees found nothing.
    const hits = rcDoc('<body><p>the report</p></body>').Pages[0]
      .SearchAnnotationText('the report');
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe('RC');
    expect(hits[0].text).toBe('the report');
  });

  it('does not match a tag name', () => {
    // The other half of the same defect: raw markup made every query for `p`,
    // `body` or `span` a hit on the syntax.
    expect(rcDoc('<body><p>the report</p></body>').Pages[0]
      .SearchAnnotationText('body')).toHaveLength(0);
  });

  it('does not join two blocks into a word that was never written', () => {
    expect(rcDoc('<p>a</p><p>b</p>').Pages[0].SearchAnnotationText('ab')).toHaveLength(0);
    expect(rcDoc('<p>a</p><p>b</p>').Pages[0].SearchAnnotationText('a')).toHaveLength(1);
  });

  it('reports the REDUCED text as the match value, not the markup', () => {
    // `text` is a slice of `value`, so a markup `value` would index a string
    // the caller never saw and the offsets would be meaningless.
    const hits = rcDoc('<body><p>the report</p></body>').Pages[0]
      .SearchAnnotationText('report');
    expect(hits[0].value).toBe('the report');
    expect(hits[0].value).not.toContain('<');
  });

  it('reads the stream shape as well as the string shape', () => {
    // /RC carries the same string-or-stream duality a field's /RV does, and
    // Acrobat writes a stream for anything sizeable.
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (page) Tj ET']));
    const note = doc.Pages[0].AddTextNote({ rect: [60, 90, 80, 110], contents: 'zzz' });
    const markup = '<body><p>streamed richness</p></body>';
    note.Dict.set('RC', {
      kind: 'stream',
      dict: new Map<string, PdfObject>([['Length', markup.length]]),
      raw: new TextEncoder().encode(markup),
    });
    expect(doc.Pages[0].SearchAnnotationText('streamed richness')).toHaveLength(1);
  });

  it('skips a malformed /RC instead of throwing out of the search', () => {
    // A real producer's /RC is not guaranteed well formed, and one bad entry
    // must not cost the whole page its search.
    const doc = rcDoc('<p>unclosed');
    expect(() => doc.Pages[0].SearchAnnotationText('unclosed')).not.toThrow();
    expect(doc.Pages[0].SearchAnnotationText('unclosed')).toHaveLength(0);
    // ...and the OTHER entries on that same annotation still search.
    expect(doc.Pages[0].SearchAnnotationText('zzz')).toHaveLength(1);
  });

  it('leaves the stored /RC markup untouched', () => {
    // Reading it as text must not rewrite it: xfdfannot.ts round-trips /RC
    // verbatim into XFDF contents-richtext.
    const doc = rcDoc('<body><p>the report</p></body>');
    doc.Pages[0].SearchAnnotationText('report');
    const rc = doc.Pages[0].Annotations[0].Dict.get('RC') as { bytes: Uint8Array };
    expect(new TextDecoder().decode(rc.bytes)).toBe('<body><p>the report</p></body>');
  });
});
