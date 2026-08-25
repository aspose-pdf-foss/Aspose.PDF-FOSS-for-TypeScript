import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { buildNamedFont, buildTtc } from './helpers/build-sfnt.js';
import { buildType1 } from './helpers/build-type1.js';
import { buildDfont } from './helpers/build-dfont.js';
import { parseSfnt } from '../src/sfnt.js';

function folderWith(files: Record<string, Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf4ts-byname-'));
  for (const [rel, bytes] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, bytes);
  }
  return dir;
}

describe('Document.LoadFontByName', () => {
  it('finds a face by family name', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const font = doc.LoadFontByName('Alpha Sans');
    expect(font).toBeDefined();
    expect(font!.sfnt.postScriptName).toBe('AlphaSans');
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('  alpha SANS ')).toBeDefined();
  });

  it('matches the typographic family (ID 16) as well as ID 1', () => {
    const dir = folderWith({
      'a.ttf': buildNamedFont({ family: 'Foo Semibold', typographicFamily: 'Foo' }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('Foo')).toBeDefined();
    expect(doc.LoadFontByName('Foo Semibold')).toBeDefined();
  });

  it('returns undefined when no registered folder holds the family', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('Nonexistent Grotesk')).toBeUndefined();
  });

  it('returns undefined rather than throwing when nothing is registered', () => {
    expect(Document.New().LoadFontByName('Alpha Sans')).toBeUndefined();
  });

  it('prefers the regular face over bold and italic siblings', () => {
    // A TIE-BREAK, not style selection: LoadFontByName('Alpha Sans') returning
    // the bold face would be surprising. Choosing BETWEEN weights on request is
    // l1my.3's fallback chain, deliberately not built here.
    //
    // The filenames put bold and italic ahead of regular in directory order, so
    // a build with no tie-break returns the bold face and this goes red.
    const dir = folderWith({
      'a-bold.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Bold', bold: true }),
      'b-italic.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Italic', italic: true }),
      'c-regular.ttf': buildNamedFont({ family: 'Alpha Sans' }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const font = doc.LoadFontByName('Alpha Sans');
    expect(font).toBeDefined();
    expect(font!.sfnt.raw).toEqual(buildNamedFont({ family: 'Alpha Sans' }));
  });

  it('returns the SAME handle for a family requested twice', () => {
    // Identity, not equality: two AddText calls naming one family must share a
    // handle, or the font is subset and embedded into the file twice.
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('Alpha Sans')).toBe(doc.LoadFontByName('alpha sans'));
  });

  it('registers a folder once however often it is named', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    doc.RegisterFontFolder(dir);
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('Alpha Sans')).toBeDefined();
  });

  it('searches registered folders in registration order', () => {
    const first = folderWith({ 'a.ttf': buildNamedFont({ family: 'Shared', padGlyf: 0 }) });
    const second = folderWith({ 'b.ttf': buildNamedFont({ family: 'Shared', padGlyf: 64 }) });
    const doc = Document.New();
    doc.RegisterFontFolder(first);
    doc.RegisterFontFolder(second);
    // The first folder's face wins; the two differ only in glyf padding, which
    // makes the raw bytes distinguishable without changing the family.
    expect(doc.LoadFontByName('Shared')!.sfnt.raw.length)
      .toBe(buildNamedFont({ family: 'Shared', padGlyf: 0 }).length);
  });

  it('draws with a font found by name', () => {
    // End to end: the handle must be usable exactly as an AddFont handle is.
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const { page } = doc.AddPage(PageFormat.A4);
    const font = doc.LoadFontByName('Alpha Sans');
    page.AddText('A', 50, 700, { fontSize: 24, font });
    expect(doc.Save().length).toBeGreaterThan(0);
  });
});

describe('Document.RegisterSystemFonts', () => {
  it('does not throw on any platform, whatever is installed', () => {
    // The only honest assertion: which fonts a machine has is not this suite's
    // business, and every named directory may legitimately be absent.
    const doc = Document.New();
    expect(() => doc.RegisterSystemFonts()).not.toThrow();
    expect(() => doc.LoadFontByName('Definitely Not A Real Family')).not.toThrow();
  });
});

describe('Document.LoadFontByName — collections', () => {
  const pair = () => buildTtc([
    buildNamedFont({ family: 'Alpha Sans' }),
    buildNamedFont({ family: 'Beta Serif', bold: true }),
  ]);

  it('finds either face of a .ttc by name', () => {
    const dir = folderWith({ 'pair.ttc': pair() });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('Alpha Sans')!.sfnt.postScriptName).toBe('AlphaSans');
    expect(doc.LoadFontByName('Beta Serif')!.sfnt.postScriptName).toBe('BetaSerif');
  });

  it('gives the two faces of one file DIFFERENT handles', () => {
    // The memo is keyed by path + face, not by path alone. Both faces of a
    // collection share a path, so keying on the path returns face 0's handle
    // for face 1 -- every glyph then drawn from the wrong font, silently.
    const dir = folderWith({ 'pair.ttc': pair() });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const a = doc.LoadFontByName('Alpha Sans');
    const b = doc.LoadFontByName('Beta Serif');
    expect(a).not.toBe(b);
    expect(a!.sfnt.postScriptName).toBe('AlphaSans');
    expect(b!.sfnt.postScriptName).toBe('BetaSerif');
    // ...and each face is still memoized on its own.
    expect(doc.LoadFontByName('Alpha Sans')).toBe(a);
  });

  it('AddFont takes face 0 by default and the named face on request', () => {
    const doc = Document.New();
    expect(doc.AddFont(pair()).sfnt.postScriptName).toBe('AlphaSans');
    expect(doc.AddFont(pair(), { faceIndex: 1 }).sfnt.postScriptName).toBe('BetaSerif');
  });
});

describe('Document.LoadFontByName — style matching', () => {
  /** One family in four faces, as a real family ships. */
  function familyFolder(): string {
    return folderWith({
      'r.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Regular', weight: 400 }),
      'b.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Bold', weight: 700, bold: true }),
      'i.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Italic', weight: 400, italic: true }),
      'bi.ttf': buildNamedFont({
        family: 'Alpha Sans', subfamily: 'Bold Italic', weight: 700, bold: true, italic: true,
      }),
    });
  }

  it('resolves a weight and a slant to the face that carries them', () => {
    const doc = Document.New();
    doc.RegisterFontFolder(familyFolder());
    expect(doc.ResolveFontByName('Alpha Sans', { weight: 700 })!.subfamily).toBe('Bold');
    expect(doc.ResolveFontByName('Alpha Sans', { italic: true })!.subfamily).toBe('Italic');
    expect(doc.ResolveFontByName('Alpha Sans', { weight: 700, italic: true })!.subfamily)
      .toBe('Bold Italic');
    expect(doc.ResolveFontByName('Alpha Sans')!.subfamily).toBe('Regular');
  });

  it('reports exact: false and NAMES the face it substituted', () => {
    // The whole reason ResolveFontByName exists: EmbeddedFont.sfnt is @internal,
    // so a caller who asked for bold and got upright otherwise cannot find out.
    const dir = folderWith({
      'r.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Regular', weight: 400 }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const m = doc.ResolveFontByName('Alpha Sans', { weight: 700 })!;
    expect(m.exact).toBe(false);
    expect(m.subfamily).toBe('Regular');
    expect(m.weight).toBe(400);
    expect(doc.ResolveFontByName('Alpha Sans')!.exact).toBe(true);
  });

  it('returns undefined from Resolve when no family in the chain is present', () => {
    const doc = Document.New();
    doc.RegisterFontFolder(familyFolder());
    expect(doc.ResolveFontByName(['Nonexistent Grotesk'])).toBeUndefined();
    expect(doc.ResolveFontByName([])).toBeUndefined();
  });

  it('takes the first PRESENT family of a chain, not the best style in it', () => {
    const dir = folderWith({
      'a.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Regular', weight: 400 }),
      'lb.ttf': buildNamedFont({ family: 'Beta Sans', subfamily: 'Bold', weight: 700, bold: true }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const m = doc.ResolveFontByName(['Alpha Sans', 'Beta Sans'], { weight: 700 })!;
    expect(m.family).toBe('Alpha Sans');
    expect(doc.ResolveFontByName(['Missing Sans', 'Beta Sans'], { weight: 700 })!.family)
      .toBe('Beta Sans');
  });

  it('loads the resolved face, and Load and Resolve agree about which it is', () => {
    const doc = Document.New();
    doc.RegisterFontFolder(familyFolder());
    const m = doc.ResolveFontByName('Alpha Sans', { weight: 700, italic: true })!;
    const font = doc.LoadFontByName('Alpha Sans', { weight: 700, italic: true })!;
    expect(font).toBeDefined();
    // Every face here shares one PostScript name (buildNamedFont derives it from
    // the family), so the handle is checked against the FILE the resolver named.
    expect(doc.LoadFontByName(['Alpha Sans'], { weight: 700, italic: true })).toBe(font);
    expect(m.path.endsWith('bi.ttf')).toBe(true);
  });

  it('gives different styles of one family DIFFERENT handles', () => {
    const doc = Document.New();
    doc.RegisterFontFolder(familyFolder());
    const regular = doc.LoadFontByName('Alpha Sans')!;
    const bold = doc.LoadFontByName('Alpha Sans', { weight: 700 })!;
    expect(regular).not.toBe(bold);
  });
});

describe('Document.LoadFontFamily', () => {
  it('fills all four slots from a four-face family', () => {
    const dir = folderWith({
      'r.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Regular', weight: 400 }),
      'b.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Bold', weight: 700, bold: true }),
      'i.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Italic', weight: 400, italic: true }),
      'bi.ttf': buildNamedFont({
        family: 'Alpha Sans', subfamily: 'Bold Italic', weight: 700, bold: true, italic: true,
      }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const fam = doc.LoadFontFamily('Alpha Sans')!;
    expect(fam).toBeDefined();
    const handles = new Set([fam.regular, fam.bold, fam.italic, fam.boldItalic]);
    expect(handles.size).toBe(4);       // four files, four distinct handles
  });

  it('leaves a slot UNDEFINED rather than filling it with the regular face', () => {
    // The point of the method. Filling `bold` with whatever the matcher
    // returned would put the regular face in all four slots for a one-weight
    // family: four faces that are one face, dressed as a family. Undefined
    // routes through mdstyle.ts's own documented fallback instead -- and both
    // render identically, so only an assertion on the SLOT can see this.
    const dir = folderWith({
      'r.ttf': buildNamedFont({ family: 'Solo Sans', subfamily: 'Regular', weight: 400 }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const fam = doc.LoadFontFamily('Solo Sans')!;
    expect(fam.regular).toBeDefined();
    expect(fam.bold).toBeUndefined();
    expect(fam.italic).toBeUndefined();
    expect(fam.boldItalic).toBeUndefined();
  });

  it('fills the bold slot from a Semibold, which exact matching would refuse', () => {
    // A bucket, not the equality FontMatch.exact uses: a family shipping
    // Semibold and no 700 has a bold face -- it is the only heavier face there
    // is -- while ResolveFontByName at 700 still reports exact: false.
    const dir = folderWith({
      'r.ttf': buildNamedFont({ family: 'Semi Sans', subfamily: 'Regular', weight: 400 }),
      's.ttf': buildNamedFont({ family: 'Semi Sans', subfamily: 'SemiBold', weight: 600 }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const fam = doc.LoadFontFamily('Semi Sans')!;
    expect(fam.bold).toBeDefined();
    expect(fam.bold).not.toBe(fam.regular);
    expect(doc.ResolveFontByName('Semi Sans', { weight: 700 })!.exact).toBe(false);
  });

  it('returns undefined when no family in the chain is present', () => {
    const doc = Document.New();
    expect(doc.LoadFontFamily('Nonexistent Grotesk')).toBeUndefined();
  });

  it('drops straight into AddMarkdown as a font family', () => {
    // Pins the structural compatibility with MarkdownFontFamily, which is a
    // COMPILE-time claim the type system would otherwise be the only witness to.
    const dir = folderWith({
      'r.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Regular', weight: 400 }),
      'b.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Bold', weight: 700, bold: true }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    doc.AddPage(PageFormat.A4);
    const fam = doc.LoadFontFamily('Alpha Sans')!;
    // Note the nesting: the face goes under `style`, per MarkdownFlowOptions --
    // `{ font }` at the top level is a type error, not a runtime one.
    expect(() => doc.AddMarkdown('Plain and **bold**.', { style: { font: fam } })).not.toThrow();
  });
});

describe('Document.RegisterFontFolder — which files the scan opens', () => {
  it('finds a font with NO extension at all', () => {
    // The motivating shape: a font checked into a repo or unpacked from an
    // archive loses its extension. peekNames already judges by magic, so the
    // extension filter was the only thing hiding it.
    const dir = folderWith({ 'AlphaSans': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('Alpha Sans')).toBeDefined();
  });

  it('does NOT open an unrecognised extension by default, and DOES under sniff', () => {
    // Two documents over one folder, because the process-wide index cache is
    // keyed by path -- if the flag were left out of that key the second lookup
    // would be answered from the first one's narrower scan.
    const dir = folderWith({ 'a.dat': buildNamedFont({ family: 'Alpha Sans' }) });

    const plain = Document.New();
    plain.RegisterFontFolder(dir);
    expect(plain.LoadFontByName('Alpha Sans')).toBeUndefined();

    const sniffing = Document.New();
    sniffing.RegisterFontFolder(dir, { sniff: true });
    expect(sniffing.LoadFontByName('Alpha Sans')).toBeDefined();
  });

  it('skips a dotfile, which is NOT extensionless', () => {
    // '.DS_Store' has its dot at index 0, so it must not be mistaken for a file
    // with no extension. A valid font beside it proves the scan continued.
    const dir = folderWith({
      '.DS_Store': new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
      'good.ttf': buildNamedFont({ family: 'Alpha Sans' }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('Alpha Sans')).toBeDefined();
  });

  it('skips an extensionless NON-font without throwing, and still finds a real one', () => {
    // A skip test that does not prove the scan continued is worth little.
    const dir = folderWith({
      'README': new Uint8Array(Buffer.from('not a font at all, just some text')),
      'good.ttf': buildNamedFont({ family: 'Alpha Sans' }),
    });
    const doc = Document.New();
    expect(() => doc.RegisterFontFolder(dir)).not.toThrow();
    expect(doc.LoadFontByName('Alpha Sans')).toBeDefined();
  });

  it('upgrades an already-registered folder to sniff, in place', () => {
    // Sticky-on: monotone and order-stable. Registering again must not move the
    // folder (l1my.1's guarantee) but must not silently drop the widening
    // either. 'zz.dat' sorts after 'a.ttf', so if the upgrade were ignored the
    // second lookup finds nothing.
    const dir = folderWith({ 'zz.dat': buildNamedFont({ family: 'Dat Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('Dat Sans')).toBeUndefined();
    doc.RegisterFontFolder(dir, { sniff: true });
    expect(doc.LoadFontByName('Dat Sans')).toBeDefined();
  });

  it('keeps registration order when a folder is re-registered with sniff', () => {
    const first = folderWith({ 'a.ttf': buildNamedFont({ family: 'Shared Sans' }) });
    const second = folderWith({ 'b.ttf': buildNamedFont({ family: 'Shared Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(first);
    doc.RegisterFontFolder(second);
    doc.RegisterFontFolder(first, { sniff: true });   // upgrade, not a re-append
    expect(doc.ResolveFontByName('Shared Sans')!.path.endsWith('a.ttf')).toBe(true);
  });
});

describe('Document.LoadFontByName — Type 1', () => {
  const REAL_T1 = new Uint8Array(readFileSync('test/fixtures/fonts/NimbusSans-Regular.t1'));

  it('finds a .pfb by family name and embeds it', () => {
    const dir = folderWith({ 'nimbus.pfb': REAL_T1 });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const font = doc.LoadFontByName('Nimbus Sans');
    expect(font).toBeDefined();
    expect(font!.sfnt.postScriptName).toBe('NimbusSans-Regular');
  });

  it('reads the style out of /Weight and /ItalicAngle', () => {
    // The mapping that lets l1my.3's rules apply with no new style logic:
    // /Weight lands in `subfamily`, and deriveStyle's corroboration -- which
    // fires exactly at the default weight of 400 -- turns 'Bold' into 700.
    const dir = folderWith({
      'r.pfb': buildType1({
        charstrings: { '.notdef': Uint8Array.from([139, 139, 13, 14]) },
        fontName: 'Fam-Regular', familyName: 'Fam', weight: 'Regular',
      }),
      'b.pfb': buildType1({
        charstrings: { '.notdef': Uint8Array.from([139, 139, 13, 14]) },
        fontName: 'Fam-Bold', familyName: 'Fam', weight: 'Bold',
      }),
      'i.pfb': buildType1({
        charstrings: { '.notdef': Uint8Array.from([139, 139, 13, 14]) },
        fontName: 'Fam-Italic', familyName: 'Fam', weight: 'Regular', italicAngle: -12,
      }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.ResolveFontByName('Fam', { weight: 700 })!.weight).toBe(700);
    expect(doc.ResolveFontByName('Fam', { weight: 700 })!.exact).toBe(true);
    expect(doc.ResolveFontByName('Fam', { italic: true })!.italic).toBe(true);
    expect(doc.ResolveFontByName('Fam')!.subfamily).toBe('Regular');
  });

  it('is found by DEFAULT, needing no sniff', () => {
    const dir = folderWith({ 'nimbus.pfa': REAL_T1 });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);                 // no { sniff: true }
    expect(doc.LoadFontByName('Nimbus Sans')).toBeDefined();
  });

  it('skips a .pfb that will not parse, and still finds a real one', () => {
    // One corrupt font in a system directory must not break every lookup.
    const dir = folderWith({
      'broken.pfb': new Uint8Array(Buffer.from('%!PS-AdobeFont-1.0: nope\n', 'latin1')),
      'good.pfb': REAL_T1,
    });
    const doc = Document.New();
    expect(() => doc.RegisterFontFolder(dir)).not.toThrow();
    expect(doc.LoadFontByName('Nimbus Sans')).toBeDefined();
  });

  it('skips a Type 1 stating no /FamilyName', () => {
    // Same rule an sfnt stating no name ID 1 already gets: unusable to an index
    // that exists for nothing but matching by name.
    const dir = folderWith({
      'anon.pfb': buildType1({
        charstrings: { '.notdef': Uint8Array.from([139, 139, 13, 14]) },
        fontName: 'Anon',
      }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('Anon')).toBeUndefined();
  });
});

describe('Document.LoadFontByName — .dfont', () => {
  const LIBERATION = new Uint8Array(readFileSync('fonts/LiberationSans-Regular.ttf'));

  it('finds a .dfont by family name and embeds it', () => {
    const dir = folderWith({ 'Suitcase.dfont': buildDfont({ faces: [LIBERATION] }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const font = doc.LoadFontByName('Liberation Sans');
    expect(font).toBeDefined();
    expect(font!.sfnt.numGlyphs).toBe(parseSfnt(LIBERATION).numGlyphs);
  });

  it('resolves each face of a multi-face suitcase separately', () => {
    // The common Mac shape: regular, bold and italic in ONE file. This is what
    // faceIndex addressing buys, and a single-face suitcase cannot show it.
    const dir = folderWith({
      'Fam.dfont': buildDfont({
        faces: [
          buildNamedFont({ family: 'Suit Sans', subfamily: 'Regular' }),
          buildNamedFont({ family: 'Suit Sans', subfamily: 'Bold', bold: true, weight: 700 }),
          buildNamedFont({ family: 'Suit Sans', subfamily: 'Italic', italic: true }),
        ],
      }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.ResolveFontByName('Suit Sans', { weight: 700 })!.weight).toBe(700);
    expect(doc.ResolveFontByName('Suit Sans', { weight: 700 })!.faceIndex).toBe(1);
    expect(doc.ResolveFontByName('Suit Sans', { italic: true })!.faceIndex).toBe(2);
    expect(doc.ResolveFontByName('Suit Sans')!.faceIndex).toBe(0);
  });

  it('is found by DEFAULT, needing no sniff', () => {
    const dir = folderWith({ 'Plain.dfont': buildDfont({ faces: [LIBERATION] }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);                  // no { sniff: true }
    expect(doc.LoadFontByName('Liberation Sans')).toBeDefined();
  });

  it('is found by STRUCTURE when the file has no extension at all', () => {
    // The payoff of structural detection: l1my.4's extensionless case reaches
    // one format further. An extension-only test would miss this entirely.
    const dir = folderWith({ 'Suitcase': buildDfont({ faces: [LIBERATION] }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('Liberation Sans')).toBeDefined();
  });

  it('skips a .dfont that will not parse, and still finds a real one', () => {
    // One corrupt suitcase in a system directory must not break every lookup.
    const dir = folderWith({
      'broken.dfont': Uint8Array.from([0, 0, 1, 0, 0, 0, 9, 9, 0, 0, 0, 4, 0, 0, 0, 4]),
      'good.dfont': buildDfont({ faces: [LIBERATION] }),
    });
    const doc = Document.New();
    expect(() => doc.RegisterFontFolder(dir)).not.toThrow();
    expect(doc.LoadFontByName('Liberation Sans')).toBeDefined();
  });
});
