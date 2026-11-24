import { describe, it, expect } from 'vitest';
import { createPrivateKey } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Document, type OpenOptions } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { buildAnnotTarget } from './helpers/build-annot-target.js';
import { buildPdfaPdf } from './helpers/build-pdfa-pdf.js';
import { buildPageLabelsPdf } from './helpers/build-pagelabels-pdf.js';
import { buildComposeSource } from './helpers/build-compose-pdf.js';
import { buildMultiPageTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';

/** Every real-world PDF we vendor, except the deliberately damaged ones. */
function fixturePdfs(dir = 'test/fixtures'): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'corrupt') out.push(...fixturePdfs(p)); }
    else if (e.endsWith('.pdf')) out.push(p);
  }
  return out;
}

const issuesOf = (d: Document) => d.Validate().Issues.map((i) => `${i.rule}@${i.object?.num}`);

const protectedFixtures = 'test/fixtures/qpdf-legacy-passwords';
const pubSecFixture = 'test/fixtures/pubsec-go';
const pubSecOptions: OpenOptions = { recipient: {
  certificate: readFileSync(join(pubSecFixture, 'recipient-cert.pem')),
  privateKey: createPrivateKey(readFileSync(join(pubSecFixture, 'recipient-key.pem'))),
} };
const fixtureOptions = new Map<string, OpenOptions>([
  [join('test/fixtures/go-encrypted-signature', 'aes256.pdf'), { password: 'go-signature-user' }],
  [join(protectedFixtures, 'r2-rc4.pdf'), { password: 'fixture-user' }],
  [join(protectedFixtures, 'r3-rc4.pdf'), { password: 'fixture-user' }],
  [join(protectedFixtures, 'r4-aes128.pdf'), { password: 'fixture-user-π' }],
  [join(pubSecFixture, 'aes128.pdf'), pubSecOptions],
  [join(pubSecFixture, 'aes256.pdf'), pubSecOptions],
]);

describe('Validate() passes every clean document in the suite', () => {
  const files = fixturePdfs();
  it('found the vendored fixtures', () => expect(files.length).toBeGreaterThanOrEqual(13));
  for (const f of files)
    it(f, () => expect(issuesOf(Document.Open(readFileSync(f), fixtureOptions.get(f)))).toEqual([]));

  const builders: [string, () => Uint8Array][] = [
    ['buildTaggedPdf', buildTaggedPdf],
    ['buildFormPdf', buildFormPdf],
    ['buildAnnotTarget', buildAnnotTarget],
    ['buildPdfaPdf', () => buildPdfaPdf()],
    ['buildPageLabelsPdf', buildPageLabelsPdf],
    ['buildComposeSource', () => buildComposeSource()],
    ['buildMultiPageTaggedPdf', buildMultiPageTaggedPdf],
  ];
  for (const [n, build] of builders)
    it(n, () => expect(issuesOf(Document.Open(build()))).toEqual([]));

  it('Document.New + AddPage, saved and reopened', () => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    d.AddPage(PageFormat.Letter);
    expect(issuesOf(Document.Open(d.Save()))).toEqual([]);
  });

  it('Split / ExtractPages output', () => {
    const src = Document.Open(buildMultiPageTaggedPdf());
    expect(issuesOf(src.ExtractPages([1]))).toEqual([]);
  });
});
