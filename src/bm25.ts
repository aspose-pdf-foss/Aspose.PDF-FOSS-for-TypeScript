/** Okapi BM25 over in-memory strings (`3ywf.4`), so `Ask` can choose which
 *  parts of a long document to send without a model call.
 *
 *  A pure leaf. Words come from `Intl.Segmenter`, which segments CJK, Thai and
 *  Cyrillic correctly with no dictionary of ours — zero dependencies.
 *
 *  **Invariant:** no stemming and no stop-word list. IDF already discounts a
 *  word every passage contains, and a per-language list is a judgement this
 *  library would then have to maintain. IDF uses the `+1` inside the log, so a
 *  term in every passage scores small but never negative. */

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' });

/** Lowercased word-like segments of `s`. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const seg of SEGMENTER.segment(s.toLowerCase())) if (seg.isWordLike) out.push(seg.segment);
  return out;
}

/** Every document's BM25 score against `query`, highest first, ties by index. */
export function rankBm25(docs: string[], query: string, k1 = 1.2, b = 0.75): { index: number; score: number }[] {
  const toks = docs.map(tokenize);
  const n = docs.length;
  const avg = toks.reduce((s, t) => s + t.length, 0) / Math.max(1, n) || 1;
  const df = new Map<string, number>();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const terms = [...new Set(tokenize(query))];
  const scored = toks.map((t, index) => {
    const tf = new Map<string, number>();
    for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1);
    let score = 0;
    for (const w of terms) {
      const f = tf.get(w);
      if (!f) continue;
      const d = df.get(w)!;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / avg));
    }
    return { index, score };
  });
  return scored.sort((x, y) => y.score - x.score || x.index - y.index);
}
