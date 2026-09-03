/** The user-agent stylesheet, transcribed from the HTML Standard §15
 *  "Rendering".
 *
 *  Invariant: a PURE LEAF exporting a STRING and nothing else. It is CSS text
 *  rather than a pre-compiled table for three reasons: it is reviewable
 *  against §15 line by line, it goes through the same parser and selector
 *  engine every author sheet does — so a construct we cannot parse shows up
 *  as a failing UA test rather than as a document that renders oddly — and a
 *  transcription slip is visible as CSS instead of buried in a data
 *  structure. csscascade.ts compiles it once, lazily; putting the compile
 *  here would make this module import that one and close a cycle.
 *
 *  Invariant: transcribed from §15, NOT from Chrome. That is a deliberate
 *  divergence from the oracle, and it is exactly why the generated corpus
 *  compares author-declared properties only — see
 *  test/fixtures/css-cascade/PROVENANCE.md. This sheet is the largest
 *  untested surface zch2.2.3 ships.
 *
 *  Invariant: sizes and vertical margins are in `em`, so a document that sets
 *  `html { font-size }` scales its headings with its body text. Absolute px
 *  here would scale one and not the other.
 *
 *  Note: it declares nothing `!important`. Tier 6 of the cascade exists
 *  because CSS says so; if a rule here ever needs it, csscascade.ts's
 *  six-tier test must gain a case that exercises it. */

export const UA_CSS = `
html { display: block; font-family: serif; font-size: medium; color: black;
       line-height: normal; text-align: start }

address, article, aside, blockquote, body, dd, div, dl, dt, fieldset,
figcaption, figure, footer, form, h1, h2, h3, h4, h5, h6, header, hgroup, hr,
legend, main, nav, ol, p, pre, section, summary, ul { display: block }

li { display: list-item }
head, base, link, meta, script, style, title, template, noscript { display: none }

table { display: table }
thead { display: table-header-group }
tbody { display: table-row-group }
tfoot { display: table-footer-group }
tr { display: table-row }
td, th { display: table-cell }
caption { display: table-caption }

body { margin: 8px }

h1 { font-size: 2em;    font-weight: bold; margin: 0.67em 0 }
h2 { font-size: 1.5em;  font-weight: bold; margin: 0.83em 0 }
h3 { font-size: 1.17em; font-weight: bold; margin: 1em 0 }
h4 { font-size: 1em;    font-weight: bold; margin: 1.33em 0 }
h5 { font-size: 0.83em; font-weight: bold; margin: 1.67em 0 }
h6 { font-size: 0.67em; font-weight: bold; margin: 2.33em 0 }

p { margin: 1em 0 }
blockquote, figure { margin: 1em 40px }
dl { margin: 1em 0 }
dd { margin-left: 40px }
ol, ul { margin: 1em 0; padding-left: 40px }
ul { list-style-type: disc }
ol { list-style-type: decimal }
ul ul, ol ul { list-style-type: circle }
ul ul ul, ul ol ul, ol ul ul, ol ol ul { list-style-type: square }
li { text-align: start }

pre { font-family: monospace; white-space: pre; margin: 1em 0 }
code, kbd, samp { font-family: monospace }

b, strong { font-weight: bold }
i, em, cite, var, dfn, address { font-style: italic }
u, ins { text-decoration: underline }
s, del { text-decoration: line-through }
small { font-size: smaller }
big { font-size: larger }
sub { vertical-align: sub; font-size: smaller }
sup { vertical-align: super; font-size: smaller }
mark { background-color: yellow; color: black }

a:link { color: #0000ee; text-decoration: underline }

hr { display: block; margin: 0.5em auto; border-style: inset; border-width: 1px }

table { border-collapse: separate; border-spacing: 2px; border-color: gray }
td, th { padding: 1px }
th { font-weight: bold; text-align: center }
caption { text-align: center }
`;
