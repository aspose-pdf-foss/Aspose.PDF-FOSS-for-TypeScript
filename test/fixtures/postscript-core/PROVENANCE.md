# PostScript core language cases

Source: Adobe, *PostScript Language Reference*, third edition (1999),
[official PDF](https://www.adobe.com/jp/print/postscript/pdfs/PLRM.pdf),
consulted 2026-11-17. Page numbers in `language-cases.json` are printed page
numbers, not PDF page indexes.

The three `adobe-*` programs are short literal examples from the operator
entries for `eq` (580), `cvn` (566), and `anchorsearch` (529). Expected stacks
are transcribed as JSON in bottom-to-top order. Executable names have an
explicit attribute because displaying their text alone loses that distinction.

The `derived-*` programs were written for this repository from the corresponding
operator rules: shared substring identity in `search` (655), nondecimal real
conversion in `cvrs` (567), the composite fallback in `cvs` (568), composite
`copy` (548), and dictionary mutation rollback in `restore` (648). The copy
case also pins the approved project contract for overlap-safe copying. Their
expected stacks are independently reasoned literals, not captured output from
this interpreter. They are deliberately small enough to inspect by hand.

Final-review scanner regressions in `psscan.test.ts`, `psdata.test.ts` and
`psvm.test.ts` also use this Adobe reference: `token` (703) supplies the literal
`(15 (St1) {1 2 add}) token` remainder example and the one-whitespace terminator
rule; Syntax (26-27) supplies CRLF normalization and form-feed comment endings;
scanner errors (168) supplies the malformed-token string used as the offending
object. Remaining scanner cases are derived, hand-checked expectations.

No Ghostscript executable was available in the development environment. These
fixtures are specification examples and derived regressions, **not executed
Ghostscript oracle results**, and do not establish general PostScript
conformance. The normal test suite reads only this committed data, requires no
network access, and has no external interpreter dependency. Painting, fonts,
EPS framing and rendered-page differential fixtures belong to later issues.

Since `lw8w.5`, a separate [independent PS/EPS corpus](../postscript-oracle/PROVENANCE.md)
retains executed Ghostscript PDF and direct PNG references for thirteen inputs.
That evidence does not change the origin or scope of the literal data here.
