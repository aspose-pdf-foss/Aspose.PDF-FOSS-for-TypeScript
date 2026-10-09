// scripts/gen-xfa-goldens.ts
// Regenerates test/fixtures/xfa-dynamic/goldens.json: the box pdf.js's XFA
// layout engine gives every named node of OPM Form 1644 and two derived
// variants (164g.6). NOT run by `npm test`. Needs network access to
// registry.npmjs.org (the pinned pdfjs-dist tarball), puppeteer with its
// headless Chrome, and `tar` on PATH:
//
//   npm i --no-save puppeteer
//   npm run gen:xfa
//
// pdf.js lays an XFA form out in two halves: its own engine sizes and
// positions every node and paginates, and the browser's CSS places the
// children of a flowed container. The goldens therefore come from a REAL
// render -- pdf.js's XfaLayer into Chrome -- and are read back with
// getBoundingClientRect. At scale 1 one CSS px is one point.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import {
  DYNAMIC_FILE, DYNAMIC_VARIANTS, deriveVariant, loadDynamicPdf, packetText, sha256,
  type DynamicGoldens, type GoldenNode, type VariantGoldens,
} from '../test/helpers/xfa-dynamic.js';

// Released 2026-08-29; a release at least a month old when pinned.
const VERSION = '6.3.289';
const INTEGRITY = 'sha512-ZHjSVpDa3D6izMq8/04lvkhkATUmL9px6ChPaXc1k6nU2Mrhlg1/7F0bdUqCwUjw3NsPTfPZsMDUU6ZIcRaeQw==';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'xfa-dynamic');

// ---- fetch and verify the pinned pdfjs-dist -----------------------------------
const tgz = new Uint8Array(await (await fetch(
  `https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-${VERSION}.tgz`)).arrayBuffer());
const got = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
if (got !== INTEGRITY) throw new Error(`pdfjs-dist ${VERSION}: integrity ${got}`);
const root = mkdtempSync(join(tmpdir(), 'pdfjs-xfa-'));
writeFileSync(join(root, 'p.tgz'), tgz);
const tar = spawnSync('tar', ['-xzf', 'p.tgz'], { cwd: root });
if (tar.status !== 0) throw new Error(`tar: ${String(tar.stderr)}`);
const dist = join(root, 'package');
// The tarball's package.json carries no gitHead; the registry's version
// document does, and it is the pdf.js commit the release was built from.
const pkg = await (await fetch(`https://registry.npmjs.org/pdfjs-dist/${VERSION}`)).json() as { gitHead?: string };
if (!pkg.gitHead) throw new Error('registry reports no gitHead');

// ---- the page that renders one document -----------------------------------------
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/web/pdf_viewer.css">
<style>body{margin:0}.page{position:relative}</style></head><body><div id="out"></div>
<script type="module">
import * as pdfjs from '/build/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/build/pdf.worker.mjs';
const doc = await pdfjs.getDocument({
  url: '/doc.pdf', enableXfa: true, standardFontDataUrl: '/standard_fonts/',
}).promise;
if (!doc.isPureXfa) throw new Error('pdf.js did not take the XFA path');
const out = document.getElementById('out');
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const xfaHtml = await page.getXfa();
  const vp = page.getViewport({ scale: 1 });
  // XfaLayer.render overwrites the class of the div it is given, so the page
  // number lives on a holder around it.
  const holder = document.createElement('div');
  holder.className = 'page';
  holder.dataset.page = String(i);
  const div = document.createElement('div');
  holder.append(div);
  out.append(holder);
  pdfjs.XfaLayer.render({
    viewport: vp.clone({ dontFlip: true }), div, xfaHtml,
    annotationStorage: doc.annotationStorage, linkService: null, intent: 'display',
  });
}
window.__pages = doc.numPages;
</script></body></html>`;

const TYPES: Record<string, string> = { mjs: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png' };
let current = new Uint8Array();
const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (path === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  if (path === '/doc.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(current); return; }
  try {
    const body = readFileSync(join(dist, path));
    res.writeHead(200, { 'content-type': TYPES[path.split('.').pop() ?? ''] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('no port');

const browser = await puppeteer.launch({ headless: true });
const chrome = await browser.version();

// The in-page collector, a STRING: tsx compiles with esbuild's keepNames, which
// would inject a `__name` helper into a function serialized to the browser.
const COLLECT = `(() => {
  const KIND = { xfaSubform: 'subform', xfaField: 'field', xfaDraw: 'draw', xfaExclgroup: 'exclGroup', xfaArea: 'area' };
  const nodes = [];
  const seen = new Map();
  const somOf = new Map();
  const r2 = (n) => Math.round(n * 100) / 100;
  for (const pg of document.querySelectorAll('.page')) {
    const o = pg.getBoundingClientRect();
    for (const el of pg.querySelectorAll('[xfaname]')) {
      const kind = [...el.classList].map((c) => KIND[c]).find((k) => k !== undefined);
      if (kind === undefined) continue; // the xfaPage (pageArea) and the like
      let p = el.parentElement;
      while (p && !somOf.has(p)) p = p.parentElement;
      // Page-area furniture (a page-number draw) is no part of the form's
      // subform tree; it is named for its pageArea so it cannot pass for one.
      const parent = p ? somOf.get(p)
        : el.closest('.xfaContentarea') ? ''
        : '#pageArea[' + el.closest('.xfaPage').getAttribute('xfaname') + ']';
      const name = el.getAttribute('xfaname');
      const id = el.getAttribute('data-element-id');
      const key = parent + '|' + name;
      const ids = seen.get(key) ?? [];
      if (!ids.includes(id)) ids.push(id);
      seen.set(key, ids);
      const som = (parent ? parent + '.' : '') + name + '[' + ids.indexOf(id) + ']';
      somOf.set(el, som);
      const b = el.getBoundingClientRect();
      const node = { page: Number(pg.dataset.page), som, kind,
        x: r2(b.left - o.left), y: r2(b.top - o.top), w: r2(b.width), h: r2(b.height) };
      if (kind === 'field') {
        const c = el.querySelector('textarea, input:not([type=checkbox]):not([type=radio])');
        if (c && c.value) node.value = c.value;
      }
      nodes.push(node);
    }
  }
  return { pages: window.__pages, nodes };
})()`;

/** Every named XFA node on every page. The SOM index of a node is the order in
 *  which its `data-element-id` first appears under the same parent path: pdf.js
 *  keeps a node's id when it splits the node across pages and gives a repeated
 *  instance a fresh one, so this counts INSTANCES, not page fragments. A node
 *  with no name carries no `xfaname` and is transparent, as SOM has it. */
async function collect(): Promise<{ pages: number; nodes: GoldenNode[] }> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${String(address.port)}/`);
  await page.waitForFunction('window.__pages !== undefined || false', { timeout: 120000 })
    .catch(() => { throw new Error(`render failed: ${errors.join('; ')}`); });
  const r = await page.evaluate(COLLECT);
  await page.close();
  return r as { pages: number; nodes: GoldenNode[] };
}

const source = loadDynamicPdf();
const variants = {} as Record<(typeof DYNAMIC_VARIANTS)[number], VariantGoldens>;
for (const v of DYNAMIC_VARIANTS) {
  const doc = deriveVariant(source, v);
  current = doc.Save();
  const { pages, nodes } = await collect();
  variants[v] = {
    pages,
    template: sha256(packetText(doc, 'template')),
    datasets: sha256(packetText(doc, 'datasets')),
    nodes,
  };
  console.log(`${v}: ${String(pages)} pages, ${String(nodes.length)} nodes`);
}
await browser.close();
server.close();

const goldens: DynamicGoldens = {
  meta: {
    source: DYNAMIC_FILE,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    pdfjsDist: VERSION,
    pdfjsIntegrity: INTEGRITY,
    pdfjsGitHead: pkg.gitHead,
    chrome,
  },
  variants,
};
writeFileSync(join(OUT, 'goldens.json'), `${JSON.stringify(goldens, null, 1)}\n`);
console.log(`wrote goldens.json (pdf.js ${VERSION} @ ${pkg.gitHead}, ${chrome})`);
