# PostScript text witnesses

`mixed.ps` is original test source, authored for `lw8w.3`. Its Type 1 and Type 42
slots are expanded by the integration test using an original literal charstring
and the existing original `buildInkTtf` helper. These wrappers are not producer
oracles. Expected advances and cubic coordinates in the focused tests are literal
calculations, independent of the implementation's matrix helpers.

The real-program checks reuse `../fonts/NimbusSans-Regular.t1` and its existing
AFM/provenance/license, and `../../../fonts/LiberationSans-Regular.ttf` under
`fonts/LICENSE-OFL.txt`; no font bytes or licenses are duplicated here. Nimbus A
has AFM width 667; Liberation A has advance 1366 at 2048 units/em.

Saved/reopened extraction and pixel checks use this library. qpdf is a structural
check only. No independent interpreter or visual agreement is claimed; the broad
producer corpus remains `lw8w.5`, and public PS/EPS framing remains `lw8w.4`.

The separately executed [lw8w.5 oracle corpus](../postscript-oracle/PROVENANCE.md)
now supplies Ghostscript PDF/direct-PNG references, including these same licensed
font programs under explicit encoding and unhinted-device settings. The checks
described above remain literal tests, rather than independent oracle outputs.

The standard name-vector Unicode subset in `src/encoding.ts` comes from Adobe's
AGL/AGLFN repository, `glyphlist.txt` and `zapfdingbats.txt`, table version 2.0
(September 20, 2002), fetched 2026-11-18. SHA-256 of those source files:
`a3b2f61ced9f3644cc0d4ecde5c59df34ca286c689d9484a43a710a81c466789` and
`f6394e3cb8a447e84a1dad75d4baaf2aa7f45dc104faf369f4720e1a774ef2dc`.
Their BSD 3-clause notice is retained in `THIRD-PARTY-NOTICES.md`.
