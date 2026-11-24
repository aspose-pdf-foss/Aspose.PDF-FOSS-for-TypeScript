import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { FreeTextAnnotation } from '../src/annotation.js';
import { resolveAppearance } from '../src/annotappearance.js';
import { encodePdfText } from '../src/metadata.js';
import { PdfDict, PdfObject, name } from '../src/types.js';
import { buildBlankPage, buildFreeTextReadTarget } from './helpers/build-annot-target.js';
import { decodePng } from './helpers/decode-png.js';

const rect: [number, number, number, number] = [10, 20, 210, 100];

function body(doc: Document, annotation: FreeTextAnnotation): string {
  return new TextDecoder().decode(resolveAppearance(doc, annotation.Dict)!.stream.raw);
}

function fragment(doc: Document) {
  const page = Document.Open(doc.Save()).Pages[0];
  page.FlattenAnnotations();
  return page.GetTextFragments()[0];
}

describe('FreeText appearance styles', () => {
  it.each(['innerRect', 'borderEffect', 'BorderEffectIntensity', 'BorderEffect', 'InnerRect'] as const)(
    'raises the effective PDF version for %s on an older document', property => {
      const creating = property === 'innerRect' || property === 'borderEffect';
      const bytes = creating ? buildBlankPage() : buildFreeTextReadTarget();
      bytes[7] = '4'.charCodeAt(0); // %PDF-1.4
      const doc = Document.Open(bytes);
      const inner: typeof rect = [30, 30, 150, 80];
      if (creating) {
        const options = property === 'innerRect' ? { innerRect: inner } : { borderEffect: 'cloudy' as const };
        doc.Pages[0].AddFreeText({ rect, contents: 'note', ...options });
      } else {
        const a = doc.Pages[0].Annotations[0] as FreeTextAnnotation;
        if (property === 'BorderEffectIntensity') a.BorderEffectIntensity = 1;
        if (property === 'BorderEffect') a.BorderEffect = 'cloudy';
        if (property === 'InnerRect') a.InnerRect = inner;
      }
      expect(Document.Open(doc.Save({ incremental: true })).headerVersion()).toBe('1.6');
      expect(Document.Open(doc.Save()).headerVersion()).toBe('1.6');
    },
  );

  it('registers the selected face, replaces it on edit, and restores it without /AP', () => {
    const doc = Document.Open(buildBlankPage());
    const a = doc.Pages[0].AddFreeText({ rect, contents: 'note', font: 'Times-BoldItalic' });
    expect(fragment(doc).fontName).toBe('Times-BoldItalic');
    a.SetFont('Courier-Bold');
    expect(fragment(doc).fontName).toBe('Courier-Bold');
    const copy = Document.Open(doc.Save());
    const opened = copy.Pages[0].Annotations[0] as FreeTextAnnotation;
    opened.Dict.delete('AP');
    expect(opened.FontName).toBe('Courier-Bold');
    expect(fragment(copy).fontName).toBe('Courier-Bold');
  });

  it('encodes Unicode with the embedded font, including after reopening and rebuilding', () => {
    const doc = Document.Open(buildBlankPage());
    const font = doc.AddFontFile('fonts/LiberationSerif-Regular.ttf');
    const a = doc.Pages[0].AddFreeText({ rect, contents: 'ΩЖ', font });
    expect(fragment(doc)).toMatchObject({ text: 'ΩЖ', fontName: expect.stringContaining('LiberationSerif') });
    a.Contents = 'ΩЖΣ';
    a.RegenerateAppearance();
    expect(fragment(doc).text).toBe('ΩЖΣ');
    const copy = Document.Open(doc.Save());
    const opened = copy.Pages[0].Annotations[0] as FreeTextAnnotation;
    opened.Dict.delete('AP');
    expect(fragment(copy).text).toBe('ΩЖΣ');
    opened.Contents = 'ΣΩ';
    expect(opened.RegenerateAppearance()).toBe(true);
    expect(fragment(copy)).toMatchObject({ text: 'ΣΩ', fontName: expect.stringContaining('LiberationSerif') });
  });

  it('uses the embedded face for inherited rich runs and a standard face for styled runs', () => {
    const doc = Document.Open(buildBlankPage());
    const font = doc.AddFontFile('fonts/LiberationSerif-Regular.ttf');
    const a = doc.Pages[0].AddFreeText({ rect, contents: 'plain', font });
    a.Dict.set('RC', { kind: 'string', bytes: encodePdfText('<p>ΩЖ <b>Bold</b></p>') });
    expect(a.RegenerateAppearance()).toBe(true);
    const copy = Document.Open(doc.Save());
    copy.Pages[0].FlattenAnnotations();
    const runs = copy.Pages[0].GetTextFragments();
    expect(runs.find(r => r.text.includes('ΩЖ'))?.fontName).toContain('LiberationSerif');
    expect(runs.find(r => r.text.includes('Bold'))?.fontName).toBe('Helvetica-Bold');
  });

  it('refuses a font registered in another document before attaching', () => {
    const a = Document.Open(buildBlankPage()), b = Document.Open(buildBlankPage());
    const foreign = a.AddFontFile('fonts/LiberationSerif-Regular.ttf');
    expect(() => b.Pages[0].AddFreeText({ rect, contents: 'note', font: foreign })).toThrow(TypeError);
    expect(b.Pages[0].Annotations).toHaveLength(0);
  });

  it('positions justified embedded-font spaces with TJ displacements', () => {
    const doc = Document.Open(buildBlankPage());
    const font = doc.AddFontFile('fonts/LiberationSerif-Regular.ttf');
    const a = doc.Pages[0].AddFreeText({ rect: [10, 10, 110, 100], contents: 'plain', font });
    a.Dict.set('RC', { kind: 'string', bytes: encodePdfText(
      '<p style="text-align:justify">one two three four five six seven eight nine</p>') });
    a.RegenerateAppearance();
    expect(body(doc, a)).toMatch(/\) -[\d.]+ .*\] TJ/);
  });

  it('uses Helvetica by default even when /Helv already means a different font on the page', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const foreign = new Map<string, PdfObject>([['Subtype', name('Type1')], ['BaseFont', name('Courier')]]);
    page.Dict.set('Resources', new Map<string, PdfObject>([['Font', new Map([['Helv', foreign]])]]));
    page.AddFreeText({ rect, contents: 'plain' });
    expect(fragment(doc).fontName).toBe('Helvetica');
  });

  it('uses an imported /DA resource and preserves its custom encoding during edits', () => {
    const doc = Document.Open(buildBlankPage());
    const a = doc.Pages[0].AddFreeText({ rect, contents: 'Z' });
    const original = doc.allocObject(new Map<string, PdfObject>([
      ['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Times-Italic')],
      ['Encoding', new Map<string, PdfObject>([['BaseEncoding', name('WinAnsiEncoding')], ['Differences', [65, name('Z')]]])],
    ]));
    const ap = resolveAppearance(doc, a.Dict)!.stream;
    ap.dict.set('Resources', new Map<string, PdfObject>([['Font', new Map([['Alias Font', original]])]]));
    a.Dict.set('DA', { kind: 'string', bytes: new TextEncoder().encode('/Alias#20Font 11 Tf 0 g') });
    a.FontSize = 16;
    expect(a.RegenerateAppearance()).toBe(true);
    expect(a.FontName).toBe('Times-Italic');
    const rebuilt = resolveAppearance(doc, a.Dict)!.stream;
    const fonts = (doc.resolve(rebuilt.dict.get('Resources')) as PdfDict).get('Font') as PdfDict;
    expect(fonts.get('Alias Font')).toEqual(original);
    expect(body(doc, a)).toContain('/Alias#20Font 16 Tf');
    expect(fragment(doc)).toMatchObject({ text: 'Z', fontName: 'Times-Italic' });
  });

  it('draws and reopens asymmetric inner rectangles and cloudy borders', () => {
    const doc = Document.Open(buildBlankPage());
    const a = doc.Pages[0].AddFreeText({ rect, contents: 'cloud', innerRect: [14, 29, 195, 86],
      borderEffect: 'cloudy', borderEffectIntensity: 1.5 });
    expect(a.InnerRect).toEqual([14, 29, 195, 86]);
    expect(a.Dict.get('RD')).toEqual([4, 14, 15, 9]);
    const cloud = body(doc, a);
    expect(cloud).toContain('1 0 0 1 4 9 cm');
    expect(cloud).toContain(' c\n');
    const copy = Document.Open(doc.Save());
    const opened = copy.Pages[0].Annotations[0] as FreeTextAnnotation;
    expect(opened.BorderEffect).toBe('cloudy');
    expect(opened.BorderEffectIntensity).toBe(1.5);
    opened.Dict.delete('AP');
    expect(body(copy, opened)).toBe(cloud);
    opened.BorderEffectIntensity = 0.5;
    expect(body(copy, opened)).not.toBe(cloud);
    opened.BorderEffect = 'none';
    expect(body(copy, opened)).not.toContain(' c\n');
    opened.InnerRect = [16, 31, 192, 80];
    expect(body(copy, opened)).toContain('1 0 0 1 6 11 cm');
  });

  it('validates explicit geometry, intensity and font before attaching', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    for (const invalid of [{ innerRect: [30, 10, 300, 10] }, { borderEffectIntensity: 3 },
      { borderEffect: 'other' }, { font: 'unknown' }]) {
      expect(() => page.AddFreeText({ rect, contents: 'note', ...invalid } as never)).toThrow(TypeError);
    }
    expect(page.Annotations).toHaveLength(0);
  });

  it.each([false, true])('clips overflowing words and later lines to the inner box (rich %s)', rich => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const text = 'WWWWWWWWWW more lines to draw beyond the box';
    const a = page.AddFreeText({ rect, contents: text, innerRect: [30, 45, 70, 70], width: 0 });
    if (rich) {
      a.Dict.set('RC', { kind: 'string', bytes: encodePdfText(`<p><i>${text}</i></p>`) });
      a.RegenerateAppearance();
    }
    const img = decodePng(page.ToImage());
    let inside = 0, outside = 0;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      if (img.at(x, y)[0] > 100) continue;
      if (x >= 30 && x < 70 && y >= img.height - 70 && y < img.height - 45) inside++;
      else outside++;
    }
    expect(inside).toBeGreaterThan(0);
    expect(outside).toBe(0);
  });
});
