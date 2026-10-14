# Adobe Reader layout probes (164g.11)

**Producer:** Adobe Acrobat Reader 26.1.21691.0 (Acrobat DC in Reader mode,
Protected Mode on), Windows 11, 2026-10-14.

**What they are:** 24 dynamic XFA forms built by our own
`scripts/gen-xfa-adobe-probes.ts` and laid out by ADOBE. The template bodies
are `tN.xml`; `tN.pdf` are the exact bytes Reader rendered (t1 and t2 were
early runs Reader drew blank -- no `config` packet -- and are not vendored).
Each probe's `docReady` script walks `xfa.form` and writes every subform's,
field's and draw's SOM expression and, per fragment `k < xfa.layout.pageSpan`,
`page, xfa.layout.x/y/w/h(node, "pt", k)` into a field at the top of page 1.

**The channel is the SCREEN.** Reader will not save data typed into these
forms, and a folder-level trusted function is invisible to XFA scripts, so the
window was captured (`captures/tN.png`, cropped to the field) and the numbers
transcribed by hand into `adobe.json`. Only `t15`'s third and fourth `pos`
fragments are derived rather than read (720 and 216 -- the capture line is cut
off; `form1`'s own fragments on the same capture confirm both, and the field
positions on those pages are read).

**Coordinates** are relative to the parent's content box (t23 shows margins are
honoured while a child's y is reported without them); a root child's are
relative to the content area, which every probe places at (0.5in, 0.5in) on US
Letter, 7.5in x 10in.

**How to re-run:** Reader installed, then
`npx tsx scripts/gen-xfa-adobe-probes.ts tN` and
`scripts/run-xfa-adobe-probe.ps1 -Name tN.out`. The rebuilt probe differs from
the vendored one in its script text only (the spike's save attempt is gone).

**Ceiling:** one producer, one version, hand transcription. Evidence for how
Adobe splits a positioned subform, not conformance. Not covered: a positioned
subform inside a split tb chain (164g.21), margins across a split (t14,
164g.20), the bottom-piece rule for a field split (t21, 164g.13).

| File | SHA-256 |
|---|---|
| `t3.pdf` | `8b51bd69973edc2fa50da036d13d005330e5e465395f975d7715b6e4d58fcb99` |
| `t4.pdf` | `a1a905dade304f272c9cc4623e7d5d274388de8d968ee581cff5720dbe1748c8` |
| `t5.pdf` | `127468a039cfd37768797ef982aaa2fe715d1c2893f9909250de827342676496` |
| `t6.pdf` | `af1eea3ca3363ccccaf177e9b5a7ae62473978dcf2bf35940c1f51a59f139c64` |
| `t7.pdf` | `cd182ebc3c726b8c4e5c1008340f942995ba24ba7eb784349684616b4b7b0c33` |
| `t8.pdf` | `c874dbf3510895de7f1507c1a6b398ae350027eac5a947a42dc9551834a806d3` |
| `t9.pdf` | `d42d72849cb1800eaa3312f02cb2ba0f84898964aef8262af931ef8dea83aded` |
| `t10.pdf` | `59a71b4054bda5f044a3cc8c1681387156c6589b3b06a40798f0d792c53b9620` |
| `t11.pdf` | `b5683f90362ffd6a6d8563f69308f8454816e777968877bf8c2e2ce0bf206a1a` |
| `t12.pdf` | `158503669b34083e33c53746b9d0f3f581e786929510893845f3dd6b59d53a18` |
| `t13.pdf` | `140c1b473e02818d7112837a2f527a9d6a92aed121c20b3b0507c650b7b9ef4d` |
| `t14.pdf` | `1bea10a41f3d532c06508605722d648a212ad98e5827c857caee93a95b6dd576` |
| `t15.pdf` | `32759338670560312bf8848b591f77ee779024b64b1f96011a0309f813e46692` |
| `t16.pdf` | `4cc64ba6b7eb494ff2105dfd8f3c7caf0e764e2a6319ce010d35b6b51936eed8` |
| `t17.pdf` | `f123096656b18018e5f49a2b9ddf4a1bbb9868ef5b7dc99456d01f9b83e43157` |
| `t18.pdf` | `d01aa6a58142a5e8be6d1f2adaf82c4d471f4cf00670eb569f5e1793c919e73b` |
| `t19.pdf` | `10e2d79fb62922ea85dc0a7512ac650145895d810bed25f853487db91e9dc0f8` |
| `t20.pdf` | `b89f2bfeebc74229696a15b36c14993dfb84c4b26e3c84e77d074878d34d3f5f` |
| `t21.pdf` | `9da41ac11a1d93ee8b1ea03eb91a4bb3420ec916727034a79f8e323eb375e3c1` |
| `t22.pdf` | `2f377d1a3af304d72d40d78c3862dadab297367e61fba6a7b67cd4958d8cf6b7` |
| `t23.pdf` | `4a9f56665043e1d2cb2c1fb853af9dd12cca0a6447ad8f0bc144a54d562f6614` |
| `t24.pdf` | `800f1a3168ee7dc2ae25b44800d41458c15b531b1e4e2bc77870df3bad00eced` |
| `t25.pdf` | `99b796b04fd6d5022f7cf2c37322c23ddc9fafc4f203ba27abedaf2569a47fb4` |
| `t26.pdf` | `3361140efad12a2cf2d171170fec02bbb8c9b60c8cb91a6dc9dcbe2519a05ca4` |

## Qualified pagination probes (164g.9)

**Producer:** as above, 2026-10-14. `qN.xml` states its own `<pageSet>`; each
page area carries a draw named `markX` reading `AREA-X`, and the docReady report
adds `areas=` -- per page, the draws `xfa.layout.pageContent(p, "draw", true)`
returns. `adobe-qualified.json` holds, per probe, the page area of every page
and the page of every field, plus the rules XFA 3.3 leaves open as the probes
settled them (`decisions`). q15 was added during execution: q11 showed the
ordered relation treating every page as odd, and q15 confirms the consequence.

**What Adobe overruled:** simplex never uses an `oddOrEven="even"` page area
(q3; p. 798 says it is ignored). A duplex document is NOT ended on a blank back
page (q4, q9; Example 8.27 says it is). Outside duplex every page is a front
surface, the ordered relation included (q11): `pageOdd` takes the next page
with no filler, and `pageEven` can never be met -- Reader opens NO document
window for q12 and q15, three attempts each, its processes idle. With no page
area matching page 1 (q10), Reader draws one blank page and runs no layout.

**Ceiling:** one producer, one version, hand transcription, the screen as the
channel -- and Reader lays out on SCREEN, so these are Adobe's answers for the
display view, not for a duplex printer. Not covered: nested and sibling page
sets (164g.22), page-number initialization and scripting.

| File | SHA-256 |
|---|---|
| `q1.pdf` | `9440ae2503e9ff82201885eecc2aafd55d065367d9b216eaf6cfebcfd68da6f1` |
| `q2.pdf` | `b7de6ef9fada757007a7c885d4d9bbb30811311f2cdc82e26cb32671156a1cc7` |
| `q3.pdf` | `c0d249df20f588bf87852aa2736819c34f4a57ef56f5ebf8eae82a46418ad8b3` |
| `q4.pdf` | `2dc7672d3a801f328c08b44121dc062a2989bc3bdde4f9ac7c78764972b7e7c1` |
| `q5.pdf` | `daf5093d56c05bb27f93fb8ecb4fd2f15db98de56d9cb5c84a641427dbada623` |
| `q6.pdf` | `05006c7be67072cd34f4fa724c95fce4f3b2b9e862689f9a2928a0f96c68a458` |
| `q7.pdf` | `845626bdb75077bc212eed72b33f1aeffc036a359493e3e4cfc3e198dc784c5c` |
| `q8.pdf` | `406774879e1d9ac25b1f37b6bd20f0a9b30a96ba0dc280d985cca0f006488fa7` |
| `q9.pdf` | `94154abb52fb927309ad69fdfc39d2a5cbaa56f8c240ac01f444eedaf4c9ceba` |
| `q10.pdf` | `4e7c92b48d4828b4d5f2fa5aeec584eec9a73649d5dd48129fd6fa4b75456a74` |
| `q11.pdf` | `96ae9b50ef003dee01951f7fa3c3c1aea4ef26eb3b924725bddcfc8049f6ad60` |
| `q12.pdf` | `876dfc4e321873483a2158dd2e36ab45dc5e1c1ff1a8511afb2ef6eb698ac51d` |
| `q13.pdf` | `2c2b84216ff8dd1ed4a7ec49194e62d7e0731d183ec92b66ea370bb9b34078a5` |
| `q14.pdf` | `d7bad2dc3ffe301d7fd964b66721d20f46772cd0dcc9fd2cf96d3b8a4027ddd9` |
| `q15.pdf` | `5a53baee797ce5a76770c760131ed1174655e7176c17c45393fea34327130919` |
