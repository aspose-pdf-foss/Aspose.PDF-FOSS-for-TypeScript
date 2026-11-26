import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { Document, PageFormat } from '../src/index.js';
import { isRef, isStream, name, type PdfDict } from '../src/types.js';
import * as assets from '../examples/feature-showcase/assets.js';
import { stampLogoOnEveryPage } from '../examples/feature-showcase/furniture.js';

it('paints one shared Form on the eligible showcase pages', () => {
  const doc = Document.New();
  for (let i = 0; i < 4; i++) doc.AddPage();
  const [cover, , toc] = doc.Pages;
  stampLogoOnEveryPage(doc, [cover, toc]);

  const reopened = Document.Open(doc.Save());
  for (const index of [0, 2]) expect(reopened.Pages[index].Contents).toHaveLength(0);
  const refs = [1, 3].map(index => {
    const page = reopened.Pages[index];
    const draws = [...new TextDecoder().decode(page.Contents).matchAll(/\/(\w+)\s+Do\b/g)];
    expect(draws).toHaveLength(1);
    const objects = reopened.resolve(page.Resources?.get('XObject')) as PdfDict;
    const ref = objects.get(draws[0][1]);
    expect(isRef(ref)).toBe(true);
    const form = reopened.resolve(ref);
    expect(isStream(form) && form.dict.get('Subtype')).toEqual(name('Form'));
    return ref;
  });
  expect(refs[1]).toEqual(refs[0]);
});

it('renders the Bootstrap icon over existing artwork like direct SVG placement', () => {
  const icon = readFileSync(new URL('./fixtures/svg-input/icon.svg', import.meta.url));
  const doc = Document.New();
  const format = PageFormat.custom(220, 130);
  const direct = doc.AddPage(format).page;
  const stamped = doc.AddPage(format).page;
  for (const page of [direct, stamped]) {
    page.Graphics().setFillColor([1, 0, 0]).drawRect(0, 0, 220, 130).fill().apply();
  }
  direct.AddSVGObject(icon, [75, 67, 120, 38]);
  const logo = vi.spyOn(assets, 'asposeLogo').mockReturnValue(icon);
  try {
    stampLogoOnEveryPage(doc, [direct]);
  } finally {
    logo.mockRestore();
  }
  const [expected, actual] = Document.Open(doc.Save()).Pages;
  const pixels = expected.ToPixels().data;
  expect(pixels.some((red, i) => i % 4 === 0 && red === 0)).toBe(true);
  expect(Buffer.from(actual.ToPixels().data).equals(pixels)).toBe(true);
});
