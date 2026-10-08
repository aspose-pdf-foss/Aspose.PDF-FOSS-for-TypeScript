// Generates test/fixtures/box-paint/*.png — headless-Chrome renderings of the
// TEXT-FREE boxes in test/helpers/box-paint-fixtures.ts, the oracle for
// v9j3.4's rounded corners, backgrounds and gradients.
//
// Not part of `npm test`. The packages it needs are installed WITHOUT being
// recorded in package.json, as scripts/gen-svg-goldens.ts does:
//
//   npm i --no-save tsx puppeteer
//   npx tsx scripts/gen-box-paint-goldens.ts
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { BOX_PAINT_FIXTURES } from '../test/helpers/box-paint-fixtures.js';

const CHROME_ARGS = ['--force-color-profile=srgb', '--disable-lcd-text', '--disable-font-subpixel-positioning'];
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test', 'fixtures', 'box-paint');
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({ args: CHROME_ARGS });
console.log(`Chrome ${await browser.version()}`);
for (const fx of BOX_PAINT_FIXTURES) {
  const page = await browser.newPage();
  await page.setViewport({ width: fx.width, height: fx.height, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html>${fx.html}`);
  const shot = new Uint8Array(await page.screenshot({ clip: { x: 0, y: 0, width: fx.width, height: fx.height } }));
  await page.close();
  writeFileSync(join(outDir, `${fx.id}.png`), shot);
  console.log(`${createHash('sha256').update(shot).digest('hex').toUpperCase()}  ${fx.id}.png`);
}
await browser.close();
