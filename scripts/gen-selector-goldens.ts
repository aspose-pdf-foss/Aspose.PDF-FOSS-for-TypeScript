// Generates test/fixtures/css-selectors/goldens.json — Blink's answers for a
// set of documents crossed with a set of selectors, plus a set of
// specificity contests resolved by getComputedStyle.
//
// The premise the zch2.2.2 issue was filed under — "no vendorable oracle" —
// is true and incomplete: WPT's selector tests need a renderer, but a browser
// can be DRIVEN to produce a data-driven corpus, which is what
// gen-svg-goldens.ts already does for SVG output. It is cheaper here, because
// a selector's answer is a list of elements rather than a bitmap.
//
// Not part of `npm test`. The two packages it needs are installed WITHOUT
// being recorded in package.json, so the library's dependency tree is
// unchanged (a later `npm install`/`npm ci` prunes them; re-run the first
// command):
//
//   npm i --no-save tsx puppeteer
//   npx tsx scripts/gen-selector-goldens.ts
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test', 'fixtures', 'css-selectors');

/** Documents chosen for the SHAPES the matcher has to walk, not for realism:
 *  sibling runs long enough for An+B to be interesting, mixed types for the
 *  -of-type family, a foreign subtree for the case rules, nesting deep enough
 *  that descendant backtracking has somewhere to backtrack to. */
const DOCS: string[] = [
  '<!doctype html><ul><li id=n1>1</li><li id=n2>2</li><li id=n3>3</li>'
    + '<li id=n4>4</li><li id=n5>5</li><li id=n6>6</li><li id=n7>7</li></ul>',
  '<!doctype html><div class=a><div class=b><div class=b><i>deep</i></div></div></div>'
    + '<div class=b><em>shallow</em></div>',
  '<!doctype html><table><thead><tr><th>H</th></tr></thead>'
    + '<tbody><tr><td>1</td></tr><tr><td>2</td></tr><tr><td>3</td></tr></tbody></table>',
  '<!doctype html><div><p id=p1 class="x y">a</p><span id=s1 class=x>b</span>'
    + '<p id=p2>c</p><span id=s2>d</span></div>',
  '<!doctype html><a href="http://x/y" hreflang=en-GB class="one two">L</a>'
    + '<a id=bare>N</a><a HREF="Foo">M</a>',
  '<!doctype html><svg><linearGradient id=g/><a id=sa/></svg><a id=ha href=z>h</a>',
  '<!doctype html><section><h1>t</h1><p>a</p><p>b</p><div><p>c</p></div></section>',
  '<!doctype html><p id=e1></p><p id=e2> </p><p id=e3><i>x</i></p>',
  // No doctype: quirks mode, where #id and .class fold case.
  '<p id=Main class=Big>quirks</p>',
  // Shaped for :has(): a chain where the descendant and the child lead
  // disagree, and where a two-compound argument has somewhere WRONG to
  // anchor. The plausible reading of ":has(> div p)" — "some descendant
  // matches the selector `div p`" — reports #m as well as #o, because #q
  // matches `div p` on its own account.
  '<!doctype html><div id=o><div id=m><p id=q><i id=qi>t</i></p></div></div>'
    + '<div id=l><span id=ls>u</span></div>',
  // Shaped for the two sibling leads, with a deep subject for `+ p em`.
  '<!doctype html><section><h1 id=sh>t</h1><p id=spa><em id=se>a</em></p>'
    + '<span id=ssp>b</span><p id=spb>c</p></section>',
  // Shaped for :lang(). #lx is the case a startsWith gets wrong — `english`
  // starts with `en` and is not a match — and #ln states no language at all,
  // which must match NO range including the wildcard. #li inherits.
  '<!doctype html><p id=le lang=en>a</p><p id=leu lang=en-US>b</p>'
    + '<p id=lf lang=fr>c</p><p id=ln>d</p><p id=lx lang=english>e</p>'
    + '<div lang=de><p id=li>f</p></div>',
  // Shaped for the wildcard form and for the subtag-skipping rule: #lzh is
  // reached only by walking PAST a script subtag.
  '<!doctype html><p id=ldch lang=de-CH>a</p><p id=lfch lang=fr-CH>b</p>'
    + '<p id=ldde lang=de-DE>c</p><p id=lzh lang=zh-Hans-CH>d</p>',
  // Shaped for :dir(), including both auto resolutions, inheritance, and the
  // <bdi> default. #dax is auto whose scan must SKIP the inner dir=ltr.
  '<!doctype html><p id=dl dir=ltr>a</p><p id=dr dir=rtl>b</p><p id=dn>c</p>'
    + '<div dir=rtl><p id=di>d</p></div><p id=da dir=auto>مرحبا</p>'
    + '<p id=db dir=auto>hello</p><bdi id=dbdi>שלום</bdi>'
    + '<p id=dax dir=auto><span dir=ltr>של</span>hello</p>',
];

const SELECTORS: string[] = [
  '*', 'p', 'P', 'li', '#n1', '.b', '.x.y', '[href]', '[href=Foo]', '[href=foo]',
  '[href=foo i]', '[href^="http"]', '[href$="/y"]', '[href*="://"]',
  '[class~="two"]', '[hreflang|="en"]', '[hreflang|="en-G"]', '[href^=""]',
  'div p', 'div > p', 'h1 + p', 'h1 ~ p', '.a .b i', 'section h1 + p',
  'li:first-child', 'li:last-child', 'li:only-child', 'li:nth-child(1)',
  'li:nth-child(odd)', 'li:nth-child(even)', 'li:nth-child(2n+1)',
  'li:nth-child(2n-1)', 'li:nth-child(-n+3)', 'li:nth-child(n+3)',
  'li:nth-child(n-1)', 'li:nth-child(-n-1)', 'li:nth-last-child(1)',
  'li:nth-last-child(2n)', 'p:first-of-type', 'span:first-of-type',
  'p:nth-of-type(2)', 'span:last-of-type', 'p:only-of-type', 'span:first-child',
  ':root', 'p:empty', 'tr:nth-child(even) td',
  'p:not(.x)', ':is(#p1, #s2)', ':where(#p1, #s2)', 'p:not(div > .x)',
  ':is(p:not(.x))', ':link', 'a:visited', 'a:hover', 'p::before',
  'linearGradient', 'lineargradient', '#main', '.big', '#a#b',
  // :has(), and the relative selector it is the only taker of: the four lead
  // forms, the anchoring case, then composition with the rest of the grammar.
  // "div:has(p:has(span))" is invalid CSS — Blink refuses it, so the loop
  // below drops it and the refusal is pinned in cssselect-has.test.ts
  // instead. It is listed anyway: if Blink ever accepted it, this corpus
  // would report our refusal as a divergence rather than staying silent.
  'div:has(p)', 'div:has(> p)', 'div:has(> div p)', 'div:has(em)',
  'h1:has(+ p)', 'h1:has(+ span)', 'h1:has(~ span)', 'h1:has(+ p em)',
  'li:has(+ li)', 'p:has(i)', ':has(> li)', 'tr:has(td)',
  'div:has(> span, > p)', 'div:has(> p):has(> p > i)',
  'div:not(:has(p))', 'div:is(:has(> p))', 'section:has(h1 + p)',
  'a:has(+ a)', 'div:has(p:has(span))',
  // :lang() and :dir() (zch2.2.5). ONE unquoted ident is the whole accepted
  // grammar, matching Blink: Chrome 152 refuses the comma list, every
  // wildcard spelling and even `:lang("en")`, though Selectors 4 defines
  // them all. Those forms are deliberately absent here rather than listed
  // and dropped — the loop discards what Blink refuses, so listing them
  // would look like coverage while contributing no case at all.
  'p:lang(en)', 'p:lang(en-US)', 'p:lang(fr)', ':lang(en)', 'p:lang(de)',
  'p:lang(de-CH)', 'p:lang(zh)', 'div p:lang(de)', 'p:not(:lang(en))',
  'div:has(p:lang(de))',
  'p:dir(ltr)', 'p:dir(rtl)', ':dir(rtl)', 'p:dir(sideways)', 'bdi:dir(rtl)',
  'p:not(:dir(rtl))', 'div p:dir(rtl)',
];

/** Contests: two selectors that both match `#t`, each setting `property`.
 *  Blink's getComputedStyle says which won, which is the only way to observe
 *  a specificity — there is no API that reports the number.
 *
 *  "Both match" is CHECKED below rather than assumed, and that is not
 *  pedantry: `:not(#t)` against <p id=t> does not match at all, so the
 *  contest resolves on APPLICABILITY and records the less specific selector
 *  as the winner. A consumer then reads it as a specificity fact and
 *  disagrees with Blink over a rule Blink never expressed. */
const CONTESTS: { doc: string; a: string; b: string; property: string }[] = [
  { doc: '<!doctype html><p id=t class=c>t</p>', a: '#t', b: '.c.c.c.c.c.c.c.c.c.c', property: 'color' },
  { doc: '<!doctype html><p id=t class=c>t</p>', a: '[id=t]', b: '.c', property: 'color' },
  { doc: '<!doctype html><p id=t class=c>t</p>', a: 'p', b: '[class]', property: 'color' },
  { doc: '<!doctype html><p id=t class=c>t</p>', a: ':where(#t)', b: 'p', property: 'color' },
  { doc: '<!doctype html><p id=t class=c>t</p>', a: ':is(#t, .c)', b: '.c.c', property: 'color' },
  // `:not(#other)` rather than `:not(#t)`: the latter cannot match <p id=t>
  // at all, so it measures applicability instead of specificity. Negating an
  // ABSENT id both matches and still weighs [1, 0, 0].
  { doc: '<!doctype html><p id=t class=c>t</p>', a: ':not(#other)', b: '.c.c', property: 'color' },
  { doc: '<!doctype html><p id=t class=c>t</p>', a: 'p:hover', b: 'p.c', property: 'color' },
  // :has() takes its arguments' MAXIMUM, as :is() does, so [1, 0, 0] beats
  // [0, 2, 0]. It needs a child to find, hence its own document.
  {
    doc: '<!doctype html><p id=t class=c><b id=k>x</b></p>',
    a: ':has(#k)', b: '.c.c', property: 'color',
  },
  // The implicit anchor weighs NOTHING, and this contest separates the two
  // readings by itself: `p:has(> b)` is [0, 0, 2] and LOSES to `.c` at
  // [0, 1, 0]. Counting the anchor as a pseudo-class makes it [0, 1, 2],
  // which wins instead.
  {
    doc: '<!doctype html><p id=t class=c><b id=k>x</b></p>',
    a: 'p:has(> b)', b: '.c', property: 'color',
  },
  // :lang() and :dir() weigh as ORDINARY pseudo-classes, so p:lang(en) is
  // [0, 1, 1] and loses to .c.c at [0, 2, 0]. Nothing in cssselect.ts
  // special-cases them, which is exactly what these two check.
  {
    doc: '<!doctype html><p id=t class=c lang=en>t</p>',
    a: 'p:lang(en)', b: '.c.c', property: 'color',
  },
  {
    doc: '<!doctype html><p id=t class=c dir=rtl>t</p>',
    a: 'p:dir(rtl)', b: '.c.c', property: 'color',
  },
];

const COLORS = ['rgb(1, 0, 0)', 'rgb(0, 1, 0)'];

const browser = await puppeteer.launch();
const chrome = await browser.version();

const cases: unknown[] = [];
for (const doc of DOCS) {
  const page = await browser.newPage();
  await page.setContent(doc);
  for (const selector of SELECTORS) {
    const paths = await page.evaluate((sel: string) => {
      // The child-index path from the document element, counting ELEMENT
      // children only — the same walk the loader makes on our side. There is
      // no shared node identity across two engines, so a path is the only
      // way to compare an answer at all.
      //
      // Written INLINE rather than as a named helper on purpose: tsx compiles
      // with esbuild's keepNames, which rewrites a named function into a call
      // to an injected `__name` helper. That helper lives in the Node module,
      // not in the page, so a named inner function throws ReferenceError the
      // moment puppeteer serializes this callback across.
      try {
        const out: number[][] = [];
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const path: number[] = [];
          let n: Element | null = el;
          while (n !== null && n.parentElement !== null) {
            path.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
            n = n.parentElement;
          }
          out.push(path);
        }
        return out;
      } catch {
        return null;                        // Blink rejects the selector too
      }
    }, selector);
    if (paths === null) continue;           // not a case: both sides refuse it
    cases.push({ doc, selector, paths });
  }
  await page.close();
}

const specificity: unknown[] = [];
for (const c of CONTESTS) {
  const page = await browser.newPage();
  // Source order is A then B, so B wins any TIE. A test that only ever sees
  // "B won" cannot tell a specificity rule from source order, which is why
  // the assertions below name the expected winner explicitly.
  await page.setContent(
    `${c.doc}<style>${c.a}{${c.property}:${COLORS[0]}}`
    + `${c.b}{${c.property}:${COLORS[1]}}</style>`);
  const got = await page.evaluate((args: { prop: string; a: string; b: string }) => {
    const el = document.getElementById('t');
    if (el === null) return null;
    // A contest is only a SPECIFICITY fact when both rules actually apply.
    // Otherwise the winner is whichever one matched, and recording it makes
    // the corpus assert something Blink never said.
    if (!el.matches(args.a) || !el.matches(args.b)) return null;
    return getComputedStyle(el).getPropertyValue(args.prop);
  }, { prop: c.property, a: c.a, b: c.b });
  await page.close();
  if (got === null) continue;
  const winner = got === COLORS[0] ? c.a : got === COLORS[1] ? c.b : null;
  if (winner === null) continue;            // neither rule applied
  specificity.push({
    doc: c.doc, property: c.property,
    winner, loser: winner === c.a ? c.b : c.a,
  });
}

await browser.close();

mkdirSync(outDir, { recursive: true });
const json = `${JSON.stringify({ chrome, cases, specificity }, null, 1)}\n`;
const file = join(outDir, 'goldens.json');
writeFileSync(file, json);

console.log(`chrome:      ${chrome}`);
console.log(`documents:   ${DOCS.length}`);
console.log(`selectors:   ${SELECTORS.length}`);
console.log(`match cases: ${cases.length}`);
console.log(`contests:    ${specificity.length}`);
console.log(`bytes:       ${Buffer.byteLength(json)}`);
console.log(`sha256:      ${createHash('sha256').update(json).digest('hex')}`);
