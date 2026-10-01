import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Document } from '../src/index.js';
import { openOpc, OFFICE_DOCUMENT, STYLES, NUMBERING, IMAGE, HYPERLINK, type OpcPackage } from '../src/opcread.js';
import { buildPngRgbWith } from './helpers/build-embed-images.js';

const MAIN_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

/** The five things m2fp.3 follows from the main document. */
export function expectResolvesDocx(p: OpcPackage): void {
  const [main] = p.byType('', OFFICE_DOCUMENT);
  expect(main.part).toBe('word/document.xml');
  expect(p.contentType(main.part!)).toBe(MAIN_CT);
  for (const t of [STYLES, NUMBERING, IMAGE]) {
    const [r] = p.byType(main.part!, t);
    expect(r, t).toBeDefined();
    expect(p.has(r.part!), `${t} -> ${r.part}`).toBe(true);
  }
  const [img] = p.byType(main.part!, IMAGE);
  expect(img.part).toMatch(/^word\/media\/.+\.png$/);
  expect(p.contentType(img.part!)).toBe('image/png');
  const [link] = p.byType(main.part!, HYPERLINK);
  expect(link.external).toBe(true);
  expect(link.target).toMatch(/^https:\/\/example\.com\/?$/);
  expect(link.part).toBeUndefined();
  // Every internal relationship from the two sources names a part that exists.
  for (const source of ['', main.part!])
    for (const r of p.relationships(source))
      if (!r.external) expect(p.has(r.part!), `${source} ${r.id} -> ${r.target}`).toBe(true);
}

describe('openOpc over ToDocx output', () => {
  it('resolves the main document, styles, numbering, an image and a hyperlink', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ tagged: true });
    const png = Buffer.from(buildPngRgbWith(4, 4, new Array(48).fill(128), 0)).toString('base64');
    flow.AddMarkdown([
      '# Title', '', '- one', '- two', '',
      `![pic](data:image/png;base64,${png})`, '',
      '[the docs](https://example.com)', '',
    ].join('\n'));
    flow.Render();
    expectResolvesDocx(openOpc(doc.ToDocx()));
  });
});

describe('openOpc over a Word 2010 document (test/fixtures/docx/PROVENANCE.md)', () => {
  const bytes = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'docx', 'word2010-basic.docx')));

  it('is the vendored file PROVENANCE describes', () => {
    expect(createHash('sha256').update(bytes).digest('hex').toUpperCase())
      .toBe('67544B884EF9D50B80091AC5BF523273596900819141214089A172CB7AF63DB8');
  });

  it('resolves the main document, styles, numbering, an image and a hyperlink', () => {
    expectResolvesDocx(openOpc(bytes));
  });

  it("keeps Word's relationship FILE order, which is not Id order", () => {
    const ids = openOpc(bytes).relationships('word/document.xml').map((r) => r.id);
    expect(ids.slice(0, 3)).toEqual(['rId8', 'rId3', 'rId7']);
  });

  it('answers the image content type through a Default, not an Override', () => {
    const p = openOpc(bytes);
    const ct = new TextDecoder().decode(p.read('[Content_Types].xml'));
    expect(ct).toMatch(/<Default Extension="png"/);
    expect(ct).not.toMatch(/PartName="\/word\/media\//);
  });
});
