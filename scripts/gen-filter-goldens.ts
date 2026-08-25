// Generates test/fixtures/svg-filter/*.png — browser-rendered goldens for the
// filter primitives that are ports of PUBLISHED REFERENCE IMPLEMENTATIONS.
// Asserting such a port against values derived from the same reference proves
// nothing, so the expectations have to come from engines sharing no code with
// ours.
//
// Two constraints are baked in and must not be relaxed without re-measuring —
// see test/fixtures/svg-filter/PROVENANCE.md:
//
//   * turbulence fixtures stay at baseFrequency <= 0.05. Chrome and resvg
//     diverge on high-frequency noise by far more than a tolerance can hold
//     (mean channel difference 30.9/255 at 0.5, 1.7 at 0.02): the same function
//     sampled at different sub-pixel offsets.
//   * lighting fixtures are CHROME-ONLY. resvg panics inside
//     resvg/src/filter/lighting.rs and the panic ABORTS THE PROCESS rather than
//     raising, so it must not even be constructed for those inputs.
//
// Not part of `npm test`. The packages are installed WITHOUT being recorded in
// package.json, so the library's dependency tree is unchanged (a later
// `npm install`/`npm ci` prunes them; just re-run the first command). All three
// must go in ONE command — `npm i --no-save` prunes the other un-saved ones:
//
//   npm i --no-save tsx puppeteer @resvg/resvg-js
//   npx tsx scripts/gen-filter-goldens.ts
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import puppeteer from 'puppeteer';
import { decodePng } from '../test/helpers/decode-png.js';
import { diffImages } from '../test/helpers/compare-image.js';

const CHROME_ARGS = [
  '--force-color-profile=srgb', '--disable-lcd-text', '--disable-font-subpixel-positioning',
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test', 'fixtures', 'svg-filter');
const S = 64;

interface Fixture {
  name: string;
  body: string;
  /** Whether resvg may be used as the second engine. False for lighting. */
  crossCheck: boolean;
}

const region = `x="0" y="0" width="${S}" height="${S}"`;
const svgOf = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">${body}</svg>`;

const FIXTURES: Fixture[] = [
  {
    name: 'turbulence-fractal',
    crossCheck: true,
    body:
      `<filter id="f" color-interpolation-filters="sRGB" ${region}>` +
      '<feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="2" seed="7"/>' +
      `</filter><rect width="${S}" height="${S}" filter="url(#f)"/>`,
  },
  {
    name: 'turbulence-turb',
    crossCheck: true,
    body:
      `<filter id="f" color-interpolation-filters="sRGB" ${region}>` +
      '<feTurbulence type="turbulence" baseFrequency="0.012" numOctaves="2" seed="3"/>' +
      `</filter><rect width="${S}" height="${S}" filter="url(#f)"/>`,
  },
  // Lighting: Chrome only. The shapes deliberately run to the filter-region
  // edge so the NINE surface-normal kernels' border cases are exercised — a
  // shape floating clear of the edge would pass with the interior kernel used
  // everywhere.
  {
    name: 'diffuse-distant',
    crossCheck: false,
    body:
      `<filter id="f" color-interpolation-filters="sRGB" ${region}>` +
      '<feDiffuseLighting surfaceScale="8" diffuseConstant="0.9" lighting-color="#ffffff">' +
      '<feDistantLight azimuth="135" elevation="35"/>' +
      '</feDiffuseLighting></filter>' +
      `<rect x="0" y="0" width="${S}" height="${S}" rx="10" filter="url(#f)"/>`,
  },
  {
    name: 'diffuse-point',
    crossCheck: false,
    body:
      `<filter id="f" color-interpolation-filters="sRGB" ${region}>` +
      '<feDiffuseLighting surfaceScale="8" diffuseConstant="0.9" lighting-color="#ffddaa">' +
      '<fePointLight x="20" y="20" z="24"/>' +
      '</feDiffuseLighting></filter>' +
      `<rect x="0" y="0" width="${S}" height="${S}" rx="10" filter="url(#f)"/>`,
  },
  {
    name: 'specular-spot',
    crossCheck: false,
    // TWO things make this fixture discriminating, both learned the hard way:
    //
    //  * The surface is a BLURRED alpha, not the flat rect the diffuse fixtures
    //    use. A specular highlight needs varying surface normals; over a flat
    //    surface the result is uniform and proves nothing.
    //  * The light is COLOURED. feSpecularLighting's alpha is max(r,g,b), so a
    //    white light over the white page composites to white whether it is lit
    //    or not — the first attempt was pure #ffffff across all 64x64 pixels.
    //    With #3366ff the red channel sweeps 120..253 across the highlight.
    body:
      `<filter id="f" color-interpolation-filters="sRGB" ${region}>` +
      '<feGaussianBlur in="SourceAlpha" stdDeviation="4" result="b"/>' +
      '<feSpecularLighting in="b" surfaceScale="6" specularConstant="0.8" ' +
      'specularExponent="4" lighting-color="#3366ff">' +
      '<feSpotLight x="16" y="16" z="30" pointsAtX="32" pointsAtY="32" pointsAtZ="0" ' +
      'specularExponent="2" limitingConeAngle="45"/>' +
      '</feSpecularLighting></filter>' +
      `<rect x="8" y="8" width="48" height="48" rx="8" filter="url(#f)"/>`,
  },
];

mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({ args: CHROME_ARGS });

async function renderChrome(svg: string): Promise<Uint8Array> {
  const page = await browser.newPage();
  await page.setViewport({ width: S, height: S, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;padding:0;background:#fff}</style>${svg}`);
  const shot = await page.screenshot({ clip: { x: 0, y: 0, width: S, height: S } });
  await page.close();
  return new Uint8Array(shot);
}

const rows: string[] = [];

for (const fx of FIXTURES) {
  const svg = svgOf(fx.body);
  const chromePng = await renderChrome(svg);

  let crossNote = 'n/a (resvg panics on lighting)';
  if (fx.crossCheck) {
    const resvgPng = new Resvg(svg, {
      background: 'white', fitTo: { mode: 'original' },
    }).render().asPng();
    const cross = diffImages(decodePng(chromePng), decodePng(new Uint8Array(resvgPng)));
    crossNote = `maxDelta ${cross.maxDelta}`;
    // The independence gate. If this trips, LOWER the fixture's baseFrequency —
    // do not widen the gate. A golden that freezes one engine's sampling offset
    // is worse than no golden.
    if (cross.failFraction > 0.02) {
      throw new Error(
        `${fx.name}: engines disagree — maxDelta ${cross.maxDelta}, `
        + `failFraction ${cross.failFraction.toFixed(4)}. Lower baseFrequency.`);
    }
  }

  writeFileSync(join(outDir, `${fx.name}.png`), chromePng);
  writeFileSync(join(outDir, `${fx.name}.svg`), svg);
  const sha = createHash('sha256').update(chromePng).digest('hex');
  rows.push(`| \`${fx.name}.png\` | ${S}×${S} | ${fx.crossCheck ? 'yes' : '**no**'} `
    + `| ${crossNote} | \`${sha}\` |`);
  console.log(`ok   ${fx.name} (${crossNote})`);
}

await browser.close();

console.log('\nPROVENANCE table rows:\n');
console.log('| File | Size | Cross-checked | Chrome vs resvg | SHA-256 |');
console.log('|---|---|---|---|---|');
for (const r of rows) console.log(r);
