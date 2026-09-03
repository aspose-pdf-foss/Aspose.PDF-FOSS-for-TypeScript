// Generates test/fixtures/css-box/goldens.json — Chrome's used content width
// and collapsed sibling gap for every element of a set of documents.
//
// Not part of `npm test`:
//   npm i --no-save tsx puppeteer
//   npx tsx scripts/gen-box-goldens.ts
//
// Two numbers only, and deliberately: zch2.3 positions nothing, so absolute
// geometry is not ours to compare. See test/fixtures/css-box/PROVENANCE.md.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test', 'fixtures', 'css-box');

/** Every fixture pins `html { width: 800px }` so a percentage is
 *  viewport-independent, and `body { margin: 0 }` so the UA sheet's 8px body
 *  margin does not enter a comparison about author CSS.
 *
 *  Fixtures are STATIC and text is kept short enough not to wrap, since where
 *  a line breaks is layoutRuns' answer and not this corpus's.
 *
 *  Floats appear since zch2.10, but only with a STATED width and only as an
 *  only child. Stated, because a shrink-to-fit width depends on font metrics —
 *  Chrome renders the UA serif while the suite stubs Helvetica — so an
 *  auto-width float is not comparable at the 0.5px tolerance. Only child, so
 *  no sibling gap is measured: float PLACEMENT is not observable through
 *  getComputedStyle and is not what this corpus is for. */
const HEAD = '<style>html{width:800px}body{margin:0}</style>';

const CASES: { id: string; html: string }[] = [
  {
    id: 'insets',
    html: '<div style="padding:10px;border:5px solid black">a</div>'
      + '<div style="padding:0 20px">b</div>',
  },
  {
    id: 'stated-and-percentage-width',
    html: '<div style="width:300px">a</div><div style="width:50%">b</div>',
  },
  {
    id: 'auto-margins-centre',
    html: '<div style="width:400px;margin:0 auto">a</div>'
      + '<div style="width:400px;margin-left:auto">b</div>',
  },
  {
    id: 'sibling-collapse',
    html: '<p style="margin:0 0 30px">a</p><p style="margin:20px 0 0">b</p>'
      + '<p style="margin:40px 0">c</p>',
  },
  {
    id: 'collapse-through-parent',
    html: '<p style="margin:0">a</p>'
      + '<div><p style="margin-top:40px">b</p></div>'
      + '<p style="margin:0">c</p>',
  },
  {
    id: 'collapse-blocked-by-padding',
    html: '<p style="margin:0">a</p>'
      + '<div style="padding-top:1px"><p style="margin-top:40px">b</p></div>',
  },
  {
    id: 'collapse-blocked-by-height',
    html: '<div style="height:50px"><p style="margin-bottom:40px">a</p></div>'
      + '<p style="margin:0">b</p>',
  },
  {
    id: 'empty-block-collapse',
    html: '<p style="margin:0">a</p><div style="margin:20px 0 30px"></div>'
      + '<p style="margin:0">b</p>',
  },
  {
    id: 'negative-margin',
    html: '<p style="margin:0 0 40px">a</p><p style="margin:-10px 0 0">b</p>',
  },
  {
    // A float with a STATED width. Its margins must stay 0 rather than
    // absorbing the leftover column: CSS 2.1 §10.3.3's over-constrained rule
    // governs normal flow, and a float uses §10.3.5. Getting that wrong drove
    // the float's own content width negative (zch2.10).
    id: 'float-stated-width',
    html: '<div style="float:left;width:150px">a</div>',
  },
  {
    id: 'float-right-with-insets',
    html: '<div style="float:right;width:200px;padding:10px;border:5px solid black">a</div>',
  },
  {
    id: 'float-stated-margins',
    html: '<div style="float:left;width:150px;margin:0 20px">a</div>',
  },
  {
    id: 'nested-widths',
    html: '<div style="width:600px;padding:20px">'
      + '<div style="padding:10px">a</div><div style="width:50%">b</div></div>',
  },
];

const browser = await puppeteer.launch();
const chrome = await browser.version();
const cases: unknown[] = [];

for (const c of CASES) {
  const page = await browser.newPage();
  await page.emulateMediaType('print');
  await page.setContent(`<!doctype html>${HEAD}${c.html}`);
  const rows = await page.evaluate(() => {
    // No named inner function: tsx compiles with esbuild's keepNames, which
    // rewrites one into a call to an injected __name helper that does not
    // exist in the page, so the callback throws the moment puppeteer
    // serializes it across.
    const out: { path: number[]; width: number; gap: number | null }[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const path: number[] = [];
      let n: Element | null = el;
      while (n !== null && n.parentElement !== null) {
        path.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
        n = n.parentElement;
      }
      const prev = el.previousElementSibling;
      const gap = prev === null
        ? null
        : el.getBoundingClientRect().top - prev.getBoundingClientRect().bottom;
      out.push({ path, width: parseFloat(getComputedStyle(el).width), gap });
    }
    return out;
  });
  await page.close();
  cases.push({ id: c.id, html: `<!doctype html>${HEAD}${c.html}`, rows });
}

await browser.close();

mkdirSync(outDir, { recursive: true });
const json = `${JSON.stringify({ chrome, cases }, null, 1)}\n`;
const file = join(outDir, 'goldens.json');
writeFileSync(file, json);

const rows = cases.reduce((n: number, c) => n + (c as { rows: unknown[] }).rows.length, 0);
console.log(`chrome:  ${chrome}`);
console.log(`cases:   ${cases.length}`);
console.log(`rows:    ${rows}`);
console.log(`bytes:   ${Buffer.byteLength(json)}`);
console.log(`sha256:  ${createHash('sha256').update(json).digest('hex')}`);
