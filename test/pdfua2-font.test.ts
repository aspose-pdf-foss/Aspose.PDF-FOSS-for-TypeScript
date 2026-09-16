import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildFontPdf, type FontPdfSpec } from './helpers/build-font-pdf.js';

/** Rule ids reported for this document at `part`. */
const ids = (spec: FontPdfSpec, part: 1 | 2): string[] =>
  Document.Open(buildFontPdf(spec)).ValidatePdfUa(part).Issues.map((i) => i.rule);

/** A rule must report at part 2 AND be silent at part 1. A single-part
 *  assertion provably cannot tell a rule that correctly went quiet from one
 *  that was never wired up. */
function expectPair(spec: FontPdfSpec, rule: string): void {
  expect(ids(spec, 2), `${rule} at part 2`).toContain(rule);
  expect(ids(spec, 1), `${rule} at part 1`).not.toContain(rule);
}

describe('PDF/UA-2 8.4.5.5.1-1: fonts must be embedded', () => {
  it('reports a simple font with no font program', () => {
    expectPair({ embed: false, text: 'A' }, 'FontNotEmbedded');
  });

  it('is silent for an embedded font', () => {
    expect(ids({ embed: true, text: 'A' }, 2)).not.toContain('FontNotEmbedded');
  });

  it('EXEMPTS text drawn in render mode 3', () => {
    // The OCR-layer exemption. A fixture that draws its text invisibly measures
    // nothing for any other glyph rule, which is why only this case uses it.
    expect(ids({ embed: false, text: 'A', mode: 3 }, 2)).not.toContain('FontNotEmbedded');
  });

  it('EXEMPTS Type3, which the profile names explicitly', () => {
    // Its glyphs are content streams, so there is no program to embed.
    expect(ids({ embed: false, text: 'A', subtype: 'Type3' }, 2))
      .not.toContain('FontNotEmbedded');
  });

  it('EXEMPTS Type0, whose DESCENDANT 8.4.5.3.2 covers instead', () => {
    expect(ids({ type0: { encoding: 'Identity-H', embed: false }, text: 'A' }, 2))
      .not.toContain('FontNotEmbedded');
  });
});

describe('PDF/UA-2 8.4.5.7: TrueType encodings', () => {
  it('-3 reports a SYMBOLIC TrueType that states an /Encoding', () => {
    expectPair(
      { embed: true, text: 'A', symbolic: true, encoding: 'WinAnsiEncoding', cmaps: [{ plat: 3, enc: 0 }] },
      'TrueTypeSymbolicEncoding',
    );
  });

  it('-3 is silent for a symbolic TrueType with no /Encoding', () => {
    expect(ids({ embed: true, text: 'A', symbolic: true, cmaps: [{ plat: 3, enc: 0 }] }, 2))
      .not.toContain('TrueTypeSymbolicEncoding');
  });

  it('-2 reports a NON-SYMBOLIC TrueType whose /Encoding is neither Mac nor WinAnsi', () => {
    expectPair({ embed: true, text: 'A', symbolic: false, encoding: 'StandardEncoding' },
      'TrueTypeNonSymbolicEncoding');
  });

  it('-2 accepts MacRomanEncoding and WinAnsiEncoding', () => {
    for (const encoding of ['MacRomanEncoding', 'WinAnsiEncoding']) {
      expect(ids({ embed: true, text: 'A', symbolic: false, encoding }, 2), encoding)
        .not.toContain('TrueTypeNonSymbolicEncoding');
    }
  });

  it('-2 reports /Differences naming a glyph with no Unicode value', () => {
    expectPair(
      { embed: true, text: 'A', symbolic: false, encoding: 'WinAnsiEncoding', differences: { 65: 'nosuchglyphname' } },
      'TrueTypeNonSymbolicEncoding',
    );
  });

  it('-2 accepts /Differences naming a real Adobe glyph', () => {
    expect(ids(
      { embed: true, text: 'A', symbolic: false, encoding: 'WinAnsiEncoding', differences: { 65: 'eacute' } },
      2,
    )).not.toContain('TrueTypeNonSymbolicEncoding');
  });

  it('-1 reports a non-symbolic program with neither a (3,1) nor a (1,0) cmap', () => {
    expectPair(
      { embed: true, text: 'A', symbolic: false, encoding: 'WinAnsiEncoding', cmaps: [{ plat: 3, enc: 0 }] },
      'TrueTypeNonSymbolicCmap',
    );
  });

  it('-1 accepts (3,1) and accepts (1,0)', () => {
    for (const cmaps of [[{ plat: 3, enc: 1 }], [{ plat: 1, enc: 0 }]]) {
      expect(ids({ embed: true, text: 'A', symbolic: false, encoding: 'WinAnsiEncoding', cmaps }, 2),
        JSON.stringify(cmaps)).not.toContain('TrueTypeNonSymbolicCmap');
    }
  });

  it('-4 reports a symbolic program with neither a (3,0) nor a (1,0) cmap', () => {
    expectPair(
      { embed: true, text: 'A', symbolic: true, cmaps: [{ plat: 3, enc: 1 }] },
      'TrueTypeSymbolicCmap',
    );
  });

  it('-4 accepts (3,0) and accepts (1,0)', () => {
    for (const cmaps of [[{ plat: 3, enc: 0 }], [{ plat: 1, enc: 0 }]]) {
      expect(ids({ embed: true, text: 'A', symbolic: true, cmaps }, 2),
        JSON.stringify(cmaps)).not.toContain('TrueTypeSymbolicCmap');
    }
  });
});

describe('PDF/UA-2 8.4.5.4-1: CMaps outside Table 116 must be embedded', () => {
  it('reports a predefined CMap Table 116 does not list', () => {
    // 'UniJIS2004-UTF16-H' is a real Adobe CMap cmapdata.ts BUNDLES and Table
    // 116 does NOT list -- verified against predefinedCMapNames(), which answers
    // 195. That gap is the whole rule: answering 'do we have this CMap' rather
    // than 'does PDF 2.0 sanction it' passes 134 CMaps this rule exists to
    // report, silently.
    expectPair({ type0: { encoding: 'UniJIS2004-UTF16-H' }, text: 'A' }, 'CMapEmbedded');
  });

  it('is silent for a Table 116 name', () => {
    expect(ids({ type0: { encoding: 'Identity-H' }, text: 'A' }, 2))
      .not.toContain('CMapEmbedded');
  });

  it('is silent for an EMBEDDED CMap, whatever it is called', () => {
    expect(ids({ type0: { encoding: 'X', embeddedCMap: {} }, text: 'A' }, 2))
      .not.toContain('CMapEmbedded');
  });
});

describe('PDF/UA-2 8.4.5.4-2: an embedded CMap /WMode must match the stream', () => {
  it('reports a dict /WMode that disagrees with the CMap program', () => {
    expectPair(
      { type0: { encoding: 'X', embeddedCMap: { wmode: 0, dictWMode: 1 } }, text: 'A' },
      'CMapWModeMatch',
    );
  });

  it('is silent when the two agree', () => {
    expect(ids({ type0: { encoding: 'X', embeddedCMap: { wmode: 1, dictWMode: 1 } }, text: 'A' }, 2))
      .not.toContain('CMapWModeMatch');
  });

  it('is silent when the dict states no /WMode', () => {
    // Absent is not a disagreement -- the stream simply does not state one, and
    // the CMap program's own value stands. Presence is tested on the RAW dict,
    // since doc.resolve(undefined) is null and would read as a stated 0.
    expect(ids({ type0: { encoding: 'X', embeddedCMap: { wmode: 1 } }, text: 'A' }, 2))
      .not.toContain('CMapWModeMatch');
  });
});

describe('PDF/UA-2 8.4.5.4-3: a CMap may not reference one outside Table 116', () => {
  it('reports a usecmap naming a CMap Table 116 does not list', () => {
    expectPair(
      { type0: { encoding: 'X', embeddedCMap: { usecmap: 'UniJIS2004-UTF16-H' } }, text: 'A' },
      'CMapReference',
    );
  });

  it('is silent for a usecmap naming a Table 116 CMap', () => {
    expect(ids({ type0: { encoding: 'X', embeddedCMap: { usecmap: 'Identity-H' } }, text: 'A' }, 2))
      .not.toContain('CMapReference');
  });

  it('is silent when the CMap references none', () => {
    expect(ids({ type0: { encoding: 'X', embeddedCMap: {} }, text: 'A' }, 2))
      .not.toContain('CMapReference');
  });
});

describe('PDF/UA-2 8.4.5.3.2-1: CIDToGIDMap', () => {
  it('reports an EMBEDDED CIDFontType2 with no /CIDToGIDMap', () => {
    expectPair({ type0: { encoding: 'Identity-H', embed: true }, text: 'A' },
      'CidToGidMap');
  });

  it('is silent when /CIDToGIDMap is present', () => {
    expect(ids({
      type0: { encoding: 'Identity-H', embed: true, cidToGid: 'Identity' }, text: 'A',
    }, 2)).not.toContain('CidToGidMap');
  });

  it('is silent for a NON-embedded CIDFontType2', () => {
    // The profile's own escape: `containsFontFile == false`. Reporting a
    // missing map on a font with no program would be reporting twice for one
    // defect, which 8.4.5.5.1-1 already names.
    expect(ids({ type0: { encoding: 'Identity-H', embed: false }, text: 'A' }, 2))
      .not.toContain('CidToGidMap');
  });

  it('is silent for a CIDFontType0, which has no /CIDToGIDMap', () => {
    expect(ids({
      type0: { encoding: 'Identity-H', embed: true, cidSubtype: 'CIDFontType0' }, text: 'A',
    }, 2)).not.toContain('CidToGidMap');
  });
});

describe('PDF/UA-2 8.4.5.3.1-1: CIDSystemInfo must match the CMap', () => {
  it('is silent for Identity-H whatever the CIDSystemInfo says', () => {
    // The profile exempts Identity-H and Identity-V by name -- they belong to
    // no collection, so there is nothing to agree with.
    expect(ids({
      type0: { encoding: 'Identity-H', registry: 'Adobe', ordering: 'Japan1' }, text: 'A',
    }, 2)).not.toContain('CidSystemInfoMatch');
  });

  it('reports an ordering that differs from the CMap', () => {
    expectPair({
      type0: { encoding: 'UniJIS-UCS2-H', registry: 'Adobe', ordering: 'GB1', supplement: 0 },
      text: 'A',
    }, 'CidSystemInfoMatch');
  });

  it('reports a registry that differs from the CMap', () => {
    expectPair({
      type0: { encoding: 'UniJIS-UCS2-H', registry: 'NotAdobe', ordering: 'Japan1', supplement: 0 },
      text: 'A',
    }, 'CidSystemInfoMatch');
  });

  it('reports a supplement HIGHER than the CMap', () => {
    // `CIDFontSupplement <= CMapSupplement` -- a font may be older than its
    // CMap, never newer. A fixture whose supplement is LOWER must stay silent,
    // or the case measures equality rather than the inequality the rule states.
    expectPair({
      type0: {
        encoding: 'UniJIS-UCS2-H', registry: 'Adobe', ordering: 'Japan1', supplement: 99,
      },
      text: 'A',
    }, 'CidSystemInfoMatch');
  });

  it('is silent for a supplement LOWER than the CMap', () => {
    expect(ids({
      type0: {
        encoding: 'UniJIS-UCS2-H', registry: 'Adobe', ordering: 'Japan1', supplement: 0,
      },
      text: 'A',
    }, 2)).not.toContain('CidSystemInfoMatch');
  });
});

describe('PDF/UA-2 8.4.5.8: ToUnicode', () => {
  // MEASURED, and the obvious fixture measures NOTHING: a SIMPLE font always
  // resolves a Unicode value through its /Encoding and the Adobe glyph list, so
  // `noToUnicode` on one still yields 'A'. Only a composite font in the Identity
  // ordering has no route at all -- no /ToUnicode, and no character collection
  // for cidunicode.ts to consult -- which is why every -1 case here is Type0.
  const noUnicode = {
    type0: {
      encoding: 'Identity-H', embed: true, cidToGid: 'Identity',
      registry: 'Adobe', ordering: 'Identity',
    },
    text: 'A', noToUnicode: true,
  } as const;

  it('-1 reports a code that maps to no Unicode', () => {
    expectPair(noUnicode, 'ToUnicodeMissing');
  });

  it('-1 is silent once a /ToUnicode covers the code', () => {
    expect(ids({ ...noUnicode, noToUnicode: false }, 2)).not.toContain('ToUnicodeMissing');
  });

  it('-1 EXEMPTS render mode 3', () => {
    expect(ids({ ...noUnicode, mode: 3 }, 2)).not.toContain('ToUnicodeMissing');
  });

  it('-2 reports U+0000, U+FEFF and U+FFFE', () => {
    for (const cp of [0x0000, 0xfeff, 0xfffe]) {
      expectPair({ embed: true, text: 'A', toUnicodeFor: { 65: cp } }, 'ToUnicodeReserved');
    }
  });

  it('-2 is silent for an ordinary mapping', () => {
    expect(ids({ embed: true, text: 'A', toUnicodeFor: { 65: 0x0041 } }, 2))
      .not.toContain('ToUnicodeReserved');
  });
});

describe('PDF/UA-2 8.4.5.6-1: glyph widths', () => {
  it('reports a /Widths that disagrees with the program by more than 1', () => {
    // The acceptance criterion's fixture. The tolerance is 1 unit of 1/1000 em
    // and programAdvance already normalizes to that space, so no scaling here.
    expectPair({ embed: true, text: 'A', widthsDisagreeBy: 50 }, 'GlyphWidthMismatch');
  });

  it('is silent for a disagreement of exactly 1', () => {
    // `<= 1` -- one unit is conformant, so a fixture that differs by 1 measures
    // the boundary rather than the rule.
    expect(ids({ embed: true, text: 'A', widthsDisagreeBy: 1 }, 2))
      .not.toContain('GlyphWidthMismatch');
  });

  it('is silent when the dictionary states no width for the code', () => {
    // widthFromDictionary == null. Glyph.width would answer from the program
    // here, so reading THAT would compare the program with itself.
    expect(ids({ embed: true, text: 'A', widths: {} }, 2))
      .not.toContain('GlyphWidthMismatch');
  });

  it('is silent when the two agree', () => {
    expect(ids({ embed: true, text: 'A' }, 2)).not.toContain('GlyphWidthMismatch');
  });
});

describe('PDF/UA-2 8.4.5.5.1-2: an embedded font defines every glyph shown', () => {
  it('reports a code the embedded program has no glyph for', () => {
    // The fixture program's cmap maps 'A' and 'B' and nothing else.
    expectPair({ embed: true, text: 'C' }, 'GlyphNotPresent');
  });

  it('is silent for a code the program does define', () => {
    expect(ids({ embed: true, text: 'A' }, 2)).not.toContain('GlyphNotPresent');
  });

  it('reports a CID pointing PAST the glyph count of the program', () => {
    // The other half of 'defines no glyph': the gid resolves perfectly well and
    // simply is not in the program. The fixture program has 8 glyphs, and under
    // /Identity a CID is its own gid, so CID 50 is out of range. Without the
    // numGlyphs bound this reports nothing at all.
    expectPair({
      type0: { encoding: 'Identity-H', embed: true, cidToGid: 'Identity' },
      text: '2',
    }, 'GlyphNotPresent');
  });

  it('is silent for a NON-embedded font, which 8.4.5.5.1-1 already names', () => {
    expect(ids({ embed: false, text: 'C' }, 2)).not.toContain('GlyphNotPresent');
  });
});

describe('PDF/UA-2 8.4.5.9-1: no .notdef may be shown', () => {
  it('reports a composite font whose CID selects glyph 0', () => {
    expectPair({
      type0: { encoding: 'Identity-H', embed: true, cidToGid: 'Identity' },
      text: '\u0000',
    }, 'NotdefUsed');
  });

  it('is silent for a CID selecting a real glyph', () => {
    expect(ids({
      type0: { encoding: 'Identity-H', embed: true, cidToGid: 'Identity' },
      text: '\u0001',
    }, 2)).not.toContain('NotdefUsed');
  });

  it('does NOT exempt render mode 3, unlike the other four', () => {
    // 8.4.5.9-1 carries no such escape in the profile: a .notdef in an
    // invisible OCR layer is still a reference to a glyph that draws nothing,
    // and the text it stands for is lost either way.
    expect(ids({
      type0: { encoding: 'Identity-H', embed: true, cidToGid: 'Identity' },
      text: '\u0000', mode: 3,
    }, 2)).toContain('NotdefUsed');
  });
});

describe('PDF/UA-2 8.4.5: glyph rules are DEDUPED per (font, code, mode)', () => {
  it('reports ONCE for a character drawn many times', () => {
    // GFGlyph.getGlyph caches per (font, code, renderingMode, ...), so veraPDF
    // models one Glyph however often it is drawn. A test asserting one finding
    // per occurrence would be asserting the ABSENCE of that cache.
    const hits = Document.Open(buildFontPdf({ embed: true, text: 'CCCCC' }))
      .ValidatePdfUa(2).Issues.filter((i) => i.rule === 'GlyphNotPresent');
    expect(hits).toHaveLength(1);
  });

  it('reports SEPARATELY for two distinct codes in one font', () => {
    // The other half: dedup must not collapse genuinely different glyphs. 'C'
    // and 'D' are both absent from the fixture program's cmap.
    const hits = Document.Open(buildFontPdf({ embed: true, text: 'CD' }))
      .ValidatePdfUa(2).Issues.filter((i) => i.rule === 'GlyphNotPresent');
    expect(hits).toHaveLength(2);
  });
});
