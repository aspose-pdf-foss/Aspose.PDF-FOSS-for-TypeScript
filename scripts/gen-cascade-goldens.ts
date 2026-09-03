// Generates test/fixtures/css-cascade/goldens.json — Chrome's computed style
// for a set of documents, for the properties each document DECLARES.
//
// Not part of `npm test`:
//   npm i --no-save tsx puppeteer
//   npx tsx scripts/gen-cascade-goldens.ts
//
// Only author-declared properties are recorded, and that is the whole design:
// our UA sheet is transcribed from HTML §15 while Chrome's is Chrome's, so
// comparing full computed style would mismatch on every element nobody
// styled. See test/fixtures/css-cascade/PROVENANCE.md.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test', 'fixtures', 'css-cascade');

/** Each fixture names the properties to compare on EVERY element. Anything
 *  not named is left to the UA sheet and not compared.
 *
 *  Two rules the fixtures follow, both from the property semantics rather
 *  than from a failure:
 *   - border-style is always declared beside border-width, because Chrome
 *     reports a used border-width of 0 when the style is none.
 *   - line-height is always declared, never left `normal`, because Chrome
 *     resolves `normal` from font metrics we do not have. */
const CASES: { id: string; html: string; props: string[] }[] = [
  {
    id: 'cascade-order',
    html: '<style>p{color:red}p{color:blue}</style><p>x</p>',
    props: ['color'],
  },
  {
    id: 'specificity',
    html: '<style>p{color:red}#t{color:blue}.c{color:green}</style>'
      + '<p id=t class=c>x</p>',
    props: ['color'],
  },
  {
    id: 'important-and-inline',
    html: '<style>#a{color:red}#b{color:red!important}</style>'
      + '<p id=a style="color:blue">x</p><p id=b style="color:blue">y</p>',
    props: ['color'],
  },
  {
    id: 'inline-important',
    html: '<style>#t{color:red!important}</style><p id=t style="color:blue!important">x</p>',
    props: ['color'],
  },
  {
    id: 'inheritance',
    html: '<style>#o{color:red;font-style:italic;background-color:lime}</style>'
      + '<div id=o><p id=t>x</p></div>',
    props: ['color', 'font-style', 'background-color'],
  },
  {
    id: 'shorthand-order',
    html: '<style>#a{margin:0;margin-top:5px}#b{margin-top:5px;margin:0}</style>'
      + '<p id=a>x</p><p id=b>y</p>',
    props: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  },
  {
    id: 'border-shorthand',
    html: '<style>#t{border:2px solid red;border-left-color:blue}</style><p id=t>x</p>',
    props: ['border-top-width', 'border-top-style', 'border-top-color',
      'border-left-color', 'border-right-style'],
  },
  {
    id: 'relative-lengths',
    html: '<style>html{font-size:16px}#o{font-size:20px}'
      + '#t{font-size:2em;margin-top:2em;text-indent:1rem}</style>'
      + '<div id=o><p id=t>x</p></div>',
    props: ['font-size', 'margin-top', 'text-indent'],
  },
  {
    id: 'line-height-number-vs-percentage',
    html: '<style>#a{font-size:10px;line-height:1.5}#b{font-size:10px;line-height:150%}'
      + '.k{font-size:20px;line-height:inherit}</style>'
      + '<div id=a><p id=ta class=k>x</p></div><div id=b><p id=tb class=k>y</p></div>',
    props: ['line-height', 'font-size'],
  },
  {
    id: 'current-color',
    html: '<style>#t{color:red;border-top-style:solid;border-top-width:3px}</style>'
      + '<p id=t>x</p>',
    props: ['color', 'border-top-color', 'border-top-width', 'border-top-style'],
  },
  {
    id: 'css-wide-keywords',
    html: '<style>#o{color:red;font-weight:bold}'
      + '#a{color:inherit}#b{color:initial}#c{color:unset}#d{font-weight:unset}</style>'
      + '<div id=o><p id=a>a</p><p id=b>b</p><p id=c>c</p><p id=d>d</p></div>',
    props: ['color', 'font-weight'],
  },
  {
    id: 'font-shorthand',
    html: '<style>#t{font:italic bold 12px/1.5 Georgia, serif}</style><p id=t>x</p>',
    props: ['font-style', 'font-weight', 'font-size', 'line-height'],
  },
  {
    id: 'media-print',
    html: '<style>@media print{#t{color:red}}@media screen{#t{color:lime}}</style>'
      + '<p id=t>x</p>',
    props: ['color'],
  },
  // calc() and the comparison functions (zch2.2.6). Every declared value
  // here reduces to a PURE px or a number, because Chrome reports the USED
  // pixels for anything a percentage reaches — see PROVENANCE. That is a
  // limit on the corpus, not on the feature: the percentage-bearing cases
  // are pinned by test/csscalc.test.ts and test/cssresolve.test.ts.
  {
    id: 'calc-lengths',
    html: '<style>html{font-size:16px}'
      + '#t{font-size:calc(1em + 4px);margin-top:calc(10px * 2);'
      + 'text-indent:calc(2rem - 6px);line-height:calc(1.5 * 2)}</style>'
      + '<div id=t>x</div>',
    props: ['font-size', 'margin-top', 'text-indent', 'line-height'],
  },
  {
    // The unit inside calc() must resolve exactly as it does outside one,
    // which is what makes csscalc.ts's dimension table the single owner.
    id: 'calc-units-and-nesting',
    html: '<style>html{font-size:16px}#o{font-size:20px}'
      + '#t{margin-top:calc(1in - 24pt);text-indent:calc(1em + calc(2 * 3px));'
      + 'padding-top:calc((10px + 2px) / 4)}</style>'
      + '<div id=o><div id=t>x</div></div>',
    props: ['font-size', 'margin-top', 'text-indent', 'padding-top'],
  },
  {
    // clamp()'s argument order is the one that reads backwards: with the
    // bounds inverted the LOWER one wins, so #c is 40px and not 10px.
    id: 'min-max-clamp',
    html: '<style>html{font-size:16px}'
      + '#a{margin-top:min(30px, 1em)}#b{margin-top:max(30px, 1em)}'
      + '#c{text-indent:clamp(40px, 2px, 10px)}'
      + '#d{text-indent:clamp(10px, 25px, 40px)}</style>'
      + '<div id=a>a</div><div id=b>b</div><div id=c>c</div><div id=d>d</div>',
    props: ['margin-top', 'text-indent'],
  },
  {
    // An expression we REFUSE must be one Chrome refuses too, leaving the
    // initial value — otherwise a bug in the type rules shows up as a
    // plausible number rather than as a dropped declaration. Divs are used
    // throughout so the fallback is the initial 0 rather than a UA margin,
    // which our sheet and Chrome's would each have to agree about.
    //
    // DIVISION BY ZERO is deliberately absent, and it is the one refusal
    // Chrome does not share: it follows CSS Values 4, where `calc(10px / 0)`
    // is infinity clamped to 33554432px, while we refuse. Keeping it here
    // would force an allowlist onto a corpus that runs whole. See the note
    // in src/csscalc.ts and PROVENANCE.md.
    id: 'calc-invalid',
    html: '<style>'
      + '#a{margin-top:calc(1px + 2)}'      // number + length
      + '#b{margin-top:calc(2px * 3px)}'    // length * length
      + '#c{margin-top:calc(1px-2px)}'      // no whitespace around the minus
      + '#d{margin-top:calc(5px)}'          // valid, so the case cannot pass
      + '</style>'                          // by refusing everything
      + '<div id=a>a</div><div id=b>b</div>'
      + '<div id=c>c</div><div id=d>d</div>',
    props: ['margin-top'],
  },
  // Custom properties and var() (zch2.2.7). Every value here resolves to a
  // plain colour or length, so unlike zch2.2.6's percentage cases the whole
  // set is comparable.
  {
    id: 'var-basic-and-inheritance',
    html: '<style>#o{--c:rgb(1,2,3)}#a{color:var(--c)}'
      + '#b{--c:rgb(4,5,6);color:var(--c)}</style>'
      + '<div id=o><p id=a>a</p><p id=b>b</p></div>',
    props: ['color'],
  },
  {
    // The trap: #b's --x resolves, `color: 10px` then fails, and the element
    // INHERITS rather than taking the fallback.
    id: 'var-fallback',
    html: '<style>#o{color:rgb(0,128,0)}'
      + '#a{color:var(--nope, rgb(1,2,3))}'
      + '#b{--x:10px;color:var(--x, rgb(9,9,9))}'
      + '#c{--a:var(--b);--b:var(--a);color:var(--a, rgb(4,5,6))}</style>'
      + '<div id=o><p id=a>a</p><p id=b>b</p><p id=c>c</p></div>',
    props: ['color'],
  },
  {
    id: 'var-case-sensitivity',
    html: '<style>#o{color:rgb(0,128,0)}#t{--Foo:rgb(1,2,3);color:var(--foo, rgb(4,5,6))}'
      + '</style><div id=o><p id=t>x</p></div>',
    props: ['color'],
  },
  {
    id: 'var-in-shorthand-and-calc',
    html: '<style>html{font-size:16px}'
      + '#a{--c:rgb(4,5,6);border:2px solid var(--c)}'
      + '#b{--w:3px;border:var(--w) dashed rgb(7,8,9)}'
      + '#c{--m:10px;margin-top:calc(var(--m) * 2);--all:1px;border-top-width:var(--all);'
      + 'border-top-style:solid}</style>'
      + '<div id=a>a</div><div id=b>b</div><div id=c>c</div>',
    props: ['border-top-width', 'border-top-style', 'border-top-color', 'margin-top'],
  },
  {
    id: 'text-decoration',
    html: '<style>#o{text-decoration:underline dotted red}</style>'
      + '<div id=o><p id=t>x</p></div>',
    props: ['text-decoration-line', 'text-decoration-style', 'text-decoration-color'],
  },
];

const browser = await puppeteer.launch();
const chrome = await browser.version();
const cases: unknown[] = [];

for (const c of CASES) {
  const page = await browser.newPage();
  // `emulateMediaType('print')` is what makes @media print apply — without it
  // Chrome is a screen UA and the media-print fixture would record the wrong
  // answer while looking perfectly healthy.
  await page.emulateMediaType('print');
  await page.setContent(c.html);
  const values = await page.evaluate((props: string[]) => {
    // No named inner function here: tsx compiles with esbuild's keepNames,
    // which rewrites one into a call to an injected __name helper that does
    // not exist in the page, so the callback throws the moment puppeteer
    // serializes it across.
    const out: Record<string, string>[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const cs = getComputedStyle(el);
      const row: Record<string, string> = {};
      for (const p of props) row[p] = cs.getPropertyValue(p);
      out.push(row);
    }
    return out;
  }, c.props);
  await page.close();
  cases.push({ id: c.id, html: c.html, props: c.props, values });
}

await browser.close();

mkdirSync(outDir, { recursive: true });
const json = `${JSON.stringify({ chrome, cases }, null, 1)}\n`;
const file = join(outDir, 'goldens.json');
writeFileSync(file, json);

const rows = cases.reduce(
  (n: number, c) => n + (c as { values: unknown[] }).values.length
    * (c as { props: unknown[] }).props.length, 0);
console.log(`chrome:      ${chrome}`);
console.log(`cases:       ${cases.length}`);
console.log(`comparisons: ${rows}`);
console.log(`bytes:       ${Buffer.byteLength(json)}`);
console.log(`sha256:      ${createHash('sha256').update(json).digest('hex')}`);
