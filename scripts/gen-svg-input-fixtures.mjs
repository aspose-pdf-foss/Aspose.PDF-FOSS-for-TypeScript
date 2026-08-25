// Out-of-band generation for test/fixtures/svg-input/. NOT run by `npm test` --
// the suite reads only the committed bytes.
//
//   npm i --no-save svgo bootstrap-icons d3-shape @resvg/resvg-js
//   node scripts/gen-svg-input-fixtures.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const dir = join(process.cwd(), 'test', 'fixtures', 'svg-input');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const report = [];

// --- showcase.min.svg: SVGO over our readable board ---------------------
{
  const { optimize } = await import('svgo');
  const src = readFileSync(join(dir, 'showcase.svg'));
  // Plain default preset. The pair must frame identically or the comparison is
  // meaningless, so the viewBox has to survive: svgo 4 dropped removeViewBox
  // from preset-default (overriding it there is now an error), and showcase.svg
  // declares no width/height, so the plugin could not fire even if re-added.
  const out = optimize(src.toString('utf8'), {
    multipass: true,
    plugins: ['preset-default'],
  }).data;
  writeFileSync(join(dir, 'showcase.min.svg'), out);
  report.push(['showcase.svg', src.length, sha(src)]);
  report.push(['showcase.min.svg', Buffer.byteLength(out), sha(Buffer.from(out))]);
  console.log('svgo:', src.length, '->', Buffer.byteLength(out), 'bytes');
}

// --- chart.svg: d3-shape's own path data --------------------------------
{
  const { arc, pie, line, curveCatmullRom } = await import('d3-shape');
  // A donut plus a smoothed line. d3 emits its own path grammar -- long
  // decimals, A arcs with computed flags, C runs -- which is the point: none
  // of these bytes are ours.
  const slices = pie()([12, 25, 8, 31, 14]);
  const a = arc().innerRadius(30).outerRadius(70);
  const colors = ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00'];
  const wedges = slices
    .map((s, i) => `<path d="${a(s)}" fill="${colors[i]}"/>`)
    .join('\n    ');

  const pts = [[0, 40], [30, 10], [60, 55], [90, 20], [120, 45], [150, 15], [180, 35]];
  const ln = line().curve(curveCatmullRom)(pts);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <g transform="translate(100,80)">
    ${wedges}
  </g>
  <path d="${ln}" transform="translate(10,140)" fill="none" stroke="#111111"
        stroke-width="3"/>
</svg>
`;
  writeFileSync(join(dir, 'chart.svg'), svg);
  console.log('d3: chart.svg', Buffer.byteLength(svg), 'bytes');
}

// --- resvg goldens ------------------------------------------------------
{
  const { Resvg } = await import('@resvg/resvg-js');
  for (const name of ['icon', 'chart']) {
    const svgPath = join(dir, `${name}.svg`);
    let src;
    try { src = readFileSync(svgPath); } catch { continue; }   // not authored yet
    // 200x200 to match the page the test draws onto, so the comparison needs
    // no rescale. fitTo width, since these fixtures are square.
    const png = new Resvg(src.toString('utf8'), {
      fitTo: { mode: 'width', value: 200 },
      background: 'white',
    }).render().asPng();
    writeFileSync(join(dir, `${name}.png`), png);
    console.log(`resvg: ${name}.png`, png.length, 'bytes');
    report.push([`${name}.svg`, src.length, sha(src)]);
    report.push([`${name}.png`, png.length, sha(png)]);
  }
}

for (const [f, n, h] of report) console.log(`| \`${f}\` | ${n} | \`${h}\` |`);
