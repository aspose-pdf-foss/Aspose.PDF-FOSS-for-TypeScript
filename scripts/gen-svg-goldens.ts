// Generates test/fixtures/svg/*.png — browser-rendered goldens for ToSvg's
// transparency output. Rasterizes our SVG under headless Chrome and resvg,
// requires the two engines to agree, and writes the agreed PNG. An engine
// disagreement is reported, not resolved: a golden that freezes one engine's
// quirk is worse than no golden.
//
// Not part of `npm test`. The three packages it needs are installed WITHOUT
// being recorded in package.json, so the library's dependency tree is unchanged
// (a later `npm install`/`npm ci` prunes them; just re-run the first command):
//
//   npm i --no-save tsx puppeteer @resvg/resvg-js
//   npx tsx scripts/gen-svg-goldens.ts
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import puppeteer from 'puppeteer';
import { Document } from '../src/document.js';
import { decodePng } from '../test/helpers/decode-png.js';
import { diffImages, samplesMatch } from '../test/helpers/compare-image.js';
import { GOLDEN_FIXTURES, DEFAULT_MAX_FAIL_FRACTION } from '../test/helpers/svg-golden-fixtures.js';

const CHROME_ARGS = ['--force-color-profile=srgb', '--disable-lcd-text', '--disable-font-subpixel-positioning'];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test', 'fixtures', 'svg');

const browser = await puppeteer.launch({ args: CHROME_ARGS });

async function renderChrome(svg: string, width: number, height: number): Promise<Uint8Array> {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><style>html,body{margin:0;padding:0;background:#fff}</style>${svg}`);
  const shot = await page.screenshot({ clip: { x: 0, y: 0, width, height } });
  await page.close();
  return new Uint8Array(shot);
}

function renderResvg(svg: string): Uint8Array {
  return new Resvg(svg, { background: 'white', fitTo: { mode: 'original' } }).render().asPng();
}

mkdirSync(outDir, { recursive: true });

const rows: string[] = [];
const skipped: string[] = [];

for (const fx of GOLDEN_FIXTURES) {
  const svg = Document.Open(fx.pdf()).Pages[0].ToSvg();
  const chromePng = await renderChrome(svg, fx.width, fx.height);
  const resvgPng = renderResvg(svg);

  const c = decodePng(chromePng);
  const r = decodePng(resvgPng);
  const cross = diffImages(c, r);

  const cFails = samplesMatch(c, fx.probes);
  const rFails = samplesMatch(r, fx.probes);

  const budget = fx.maxFailFraction ?? DEFAULT_MAX_FAIL_FRACTION;
  if (cross.failFraction > budget) {
    skipped.push(`${fx.name}: engines disagree — maxDelta ${cross.maxDelta}, `
      + `failFraction ${cross.failFraction.toFixed(4)} (budget ${budget})`);
    continue;
  }
  if (cFails.length || rFails.length) {
    skipped.push(`${fx.name}: engines agree with each other but not with PDF semantics\n`
      + [...cFails.map((f) => `    chrome ${f}`), ...rFails.map((f) => `    resvg  ${f}`)].join('\n'));
    continue;
  }

  writeFileSync(join(outDir, `${fx.name}.png`), chromePng);
  const sha = createHash('sha256').update(chromePng).digest('hex');
  rows.push(`| \`${fx.name}.png\` | ${fx.width}×${fx.height} | ${cross.maxDelta} `
    + `| ${cross.failFraction.toFixed(4)} / ${budget} | \`${sha}\` |`);
  console.log(`ok   ${fx.name} (cross-engine maxDelta ${cross.maxDelta})`);
}

await browser.close();

for (const s of skipped) console.error(`SKIP ${s}`);
console.log(`\n${rows.length} golden(s) written, ${skipped.length} skipped.`);
console.log('Paste these rows into test/fixtures/svg/PROVENANCE.md:\n');
console.log(rows.join('\n'));
