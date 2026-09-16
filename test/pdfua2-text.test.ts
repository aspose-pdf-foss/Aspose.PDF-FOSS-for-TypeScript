import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildUaMiscPdf, type UaMiscSpec } from './helpers/build-ua-misc-pdf.js';

/** Rule ids reported for this document at `part`. */
const ids = (spec: UaMiscSpec, part: 1 | 2): string[] =>
  Document.Open(buildUaMiscPdf(spec)).ValidatePdfUa(part).Issues.map((i) => i.rule);

/** A rule must report at part 2 AND be silent at part 1. A single-part
 *  assertion provably cannot tell a rule that correctly went quiet from one
 *  that was never wired up. */
function expectPair(spec: UaMiscSpec, rule: string): void {
  expect(ids(spec, 2), `${rule} at part 2`).toContain(rule);
  expect(ids(spec, 1), `${rule} at part 1`).not.toContain(rule);
}

describe('PDF/UA-2 8.4.3-1: PUA needs a replacement', () => {
  it('reports a glyph mapping to the BMP private use area', () => {
    expectPair({ puaText: true }, 'PuaWithoutReplacement');
  });

  it('is silent for ordinary text', () => {
    expect(ids({}, 2)).not.toContain('PuaWithoutReplacement');
  });

  it('is EXCUSED by /ActualText on the enclosing BDC', () => {
    expect(ids({ puaText: true, mcProps: { ActualText: 'phone' } }, 2))
      .not.toContain('PuaWithoutReplacement');
  });

  it('is EXCUSED by /Alt on the enclosing BDC', () => {
    expect(ids({ puaText: true, mcProps: { Alt: 'phone' } }, 2))
      .not.toContain('PuaWithoutReplacement');
  });

  it('is EXCUSED by /Alt on the glyph OWN structure element', () => {
    expect(ids({ puaText: true, tagged: true, altOn: 'self' }, 2))
      .not.toContain('PuaWithoutReplacement');
  });

  it('is NOT excused by /Alt on a GRANDPARENT element', () => {
    // containsStringKey reads structureElement.getKey(key) DIRECTLY -- not up
    // the ancestor chain. The obvious reading of "an Alt covers its subtree" is
    // wrong here, and this case is the only thing that pins it.
    expectPair({ puaText: true, tagged: true, altOn: 'grandparent' },
      'PuaWithoutReplacement');
  });

  it('EXEMPTS an artifact, which is not real content', () => {
    expect(ids({ puaText: true, artifact: true }, 2))
      .not.toContain('PuaWithoutReplacement');
  });

  it('reaches the SUPPLEMENTARY planes, not just the BMP', () => {
    expectPair({ puaCodePoint: 0xf0001 }, 'PuaWithoutReplacement');
    expectPair({ puaCodePoint: 0x100001 }, 'PuaWithoutReplacement');
  });
});

describe('PDF/UA-2 8.4.3-2/-3 and 8.6-1: PUA in strings', () => {
  it('-2 reports PUA in an /ActualText', () => {
    expectPair({ tagged: true, actualTextValue: 'phone ' }, 'ActualTextPua');
  });

  it('-3 reports PUA in an /Alt', () => {
    expectPair({ tagged: true, altValue: 'phone ' }, 'AltPua');
  });

  it('-2 and -3 are silent for ordinary text', () => {
    const out = ids({ tagged: true, altValue: 'phone', actualTextValue: 'phone' }, 2);
    expect(out).not.toContain('AltPua');
    expect(out).not.toContain('ActualTextPua');
  });

  it('8.6-1 reports PUA in a human-readable string', () => {
    expectPair({ title: 'Report ' }, 'TextStringPua');
  });

  it('8.6-1 reaches the SUPPLEMENTARY planes, not just the BMP', () => {
    // PUAHelper holds THREE ranges. A single-range check passes every
    // supplementary PUA codepoint silently.
    expectPair({ title: 'Report \u{F0001}' }, 'TextStringPua');
    expectPair({ title: 'Report \u{100001}' }, 'TextStringPua');
  });

  it('8.6-1 is silent just OUTSIDE each range', () => {
    // The bounds end at FFFD, not FFFF -- the last two of each plane are
    // noncharacters and are deliberately outside the private use area.
    // F900 is the first code point ABOVE E000..F8FF; EFFFF the last BELOW
    // F0000; and FFFFE / 10FFFE are the noncharacters just above each
    // supplementary bound, which is exactly why those bounds end at FFFD.
    for (const s of ['\u{F900}', '\u{EFFFF}', '\u{FFFFE}', '\u{10FFFE}']) {
      expect(ids({ title: `Report ${s}` }, 2), JSON.stringify(s))
        .not.toContain('TextStringPua');
    }
  });

  it('8.6-1 is silent for ordinary metadata', () => {
    expect(ids({ title: 'Report' }, 2)).not.toContain('TextStringPua');
  });
});

describe('PDF/UA-2 8.4.4: natural language', () => {
  it('-1 reports a catalog with no /Lang', () => {
    expectPair({ lang: null }, 'CatalogLangMissing');
  });

  it('-1 is silent for a stated /Lang', () => {
    expect(ids({ lang: 'en-US' }, 2)).not.toContain('CatalogLangMissing');
  });

  it('-1 accepts an EMPTY /Lang, which 8.4.4-2 catches instead', () => {
    // The profile's prose says "non-empty"; its TEST is containsLang == true
    // alone. Implementing the prose would report one defect twice, and would
    // disagree with what veraPDF says about this file. The pair gives the
    // prose's answer and neither rule alone does.
    expect(ids({ lang: '' }, 2)).not.toContain('CatalogLangMissing');
    expect(ids({ lang: '' }, 2)).toContain('LangSyntax');
  });

  it('-2 reports a /Lang failing the profile regex', () => {
    for (const bad of ['en_US', '1en', 'toolongsubtag9', 'en-', '-en']) {
      expect(ids({ lang: bad }, 2), bad).toContain('LangSyntax');
    }
  });

  it('-2 accepts the forms the regex admits', () => {
    for (const ok of ['en', 'en-US', 'zh-Hant-TW', 'x', 'abcdefgh-12345678']) {
      expect(ids({ lang: ok }, 2), ok).not.toContain('LangSyntax');
    }
  });

  it('-2 is SILENT at part 1 for a tag it rejects at part 2', () => {
    expect(ids({ lang: 'en_US' }, 1)).not.toContain('LangSyntax');
  });

  it('-2 reaches a /Lang on a structure ELEMENT', () => {
    expectPair({ tagged: true, elementLang: 'en_US' }, 'LangSyntax');
  });

  it('-2 reaches a /Lang on a BDC property list', () => {
    expectPair({ bdcLang: 'en_US' }, 'LangSyntax');
  });
});

describe('8.4.4-1 resolves through the EXISTING /Lang conversion pass', () => {
  it('is not left unresolved when opts.lang is supplied', () => {
    // Every other rule in q7hc.4.4 lands in `unresolved`, and this one does not
    // -- because pdfuaconvert.ts has set the catalog /Lang since PDF/UA-1. No
    // new pass was added for it; the assertion is here so the difference reads
    // as a fact about the converter rather than an accident.
    const doc = Document.Open(buildUaMiscPdf({ lang: null }));
    const report = doc.ConvertToPdfUa({ part: 2, title: 'T', lang: 'en-US' });
    expect(report.unresolved.map((i) => i.rule)).not.toContain('CatalogLangMissing');
  });
});
