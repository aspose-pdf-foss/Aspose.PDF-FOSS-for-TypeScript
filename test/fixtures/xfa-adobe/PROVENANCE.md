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

## lr-tb and table splitting probes (164g.12)

**Producer:** as above, 2026-10-14. Every probe holds the 216pt oracle field and
a 400pt positioned filler, leaving 104pt of a 720pt content area on page 1, then
the shape under test: an `lr-tb` of 180pt items, three to a 540pt line (t27,
t28, t33, t35, t37, t38), a table (t29, t30, t34, t36), a `tb` holding one of
those (t31, t32), or a `tb` of draws (t39). The spec's probe table
(`docs/superpowers/specs/2026-10-14-xfa-split-lrtb-table-design.md`) says what
each settled.

**Captures are uncropped.** `captures/t27.png`-`t39.png` are whole Reader
windows, not crops of the field. Only `t29`'s `c4c` is derived rather than read:
its line is cut off at the bottom of the field, and `r4`, `c4a` and `c4b` on the
same capture fix it at `2,360,0,180,60`.

**What Adobe overruled:** 164g.8 gave a split `tb` its top margin on the first
fragment and its bottom margin on the last; Adobe puts both on every fragment
(t35, t36, t39). DD 1494, 164g.8's oracle, has no margins on a split subform, so
it could not see this.

**Ceiling:** one producer, one version, hand transcription. Not covered: a field
split between its lines (t27, t28, t31 -- refused, 164g.13), an `lr-tb` item that
is itself a splittable subform straddling the cut (164g.25), repeated table
header rows (164g.15).

| File | SHA-256 |
|---|---|
| `t27.pdf` | `c833a641344ef987b5e6cf78bc31851817ca40b7488ad3849bffbd345c2a811d` |
| `t28.pdf` | `c4e3478622b8fd94bad34ea1cf959d22211376f74df25df0b0f3b2d1b422ac96` |
| `t29.pdf` | `7185008738847bf17dfa47cdba2b2ba4d32fe9cc989d39cced9d7fb966ab51f5` |
| `t30.pdf` | `462fdaa9ccd18b02a4fba71637ebec9bb66bde550cc29263c4afa2e339042c77` |
| `t31.pdf` | `e41eb249e8737be4062040afcd671a4b17ad6db3e35a072626f6b6e38a8f920b` |
| `t32.pdf` | `86d49a7337cb98c83a038cfce786e4a55933221054876fd6350d8d77403d9bd4` |
| `t33.pdf` | `b9b936e3415ec40524ab045104bb2a82db4e0409c556fff1ee3ee6c1bf432fcc` |
| `t34.pdf` | `c571d9a399a7173d8029ba24c5d6dd60669a9a79d7bf6984489f5b1a8909cbb8` |
| `t35.pdf` | `fcfaab6634921e33843ac74dc9fb6563c6522cd894a4b11e42c5a5856767b8ad` |
| `t36.pdf` | `6fcbfacd0717f0934f97efce796ac0a6f53f9d32fd34e360e1078eab4ec0708e` |
| `t37.pdf` | `b9b6f6c05b63e8d20998f8407f381d4ac53d0acd2658172a39932b11c8b4b9fb` |
| `t38.pdf` | `5abf1611bc5fc80feca47735a87e8e8391279e559f46f2fc29eaaa79828245d8` |
| `t39.pdf` | `0357ed849401015802df2960d07d61125fd1992e3f9745af34410f5f28eb5e26` |

## Field splitting probes (164g.13)

**Producer:** as above, 2026-10-15. t40-t46 and t50-t54 hold one field `f` in a
`keep intact="none"` positioned subform cut 144pt below its top; t47 and t48 a
130pt field and draw in a `tb` after a 400pt filler; t49 a text field on an
`lr-tb`'s second line. t40-t44 are EMPTY fields, the rest hold ten one-word
lines (`line 01` ... `line 10`; t54 three) in Courier New, Arial (t50) or 20pt
Courier New (t51). The spec's tables
(`docs/superpowers/specs/2026-10-15-xfa-split-field-design.md`) give each
probe's room and Adobe's pieces.

**What it settled:** a field's lines sit on a `1.2 x font size` grid whatever
the font; inside the text the cut snaps to a whole line, below it the cut is
free; a bottom piece under one font size moves the cut up by exactly one font
size; no orphan or widow control; a field in a `tb` splits (164g.8 moved it),
a draw does not.

**Captures are uncropped** whole Reader windows, as for t27-t39.

**Ceiling:** one producer, one version, hand transcription. Not covered:
captions, insets, `vAlign`, `lineHeight`, orphans/widows, non-text fields and
mixed sizes (164g.26), and how Reader draws a split field's text.

| File | SHA-256 |
|---|---|
| `t40.pdf` | `b5d8a4cf40daddcf2416d6ee9ef2e01d77204a68a8b9c2c2cdc4b2ff787f422b` |
| `t41.pdf` | `2eeaa44da27b02b70027c70621d9ff63f00ca4e45d36c1e3e23751f240ea6039` |
| `t42.pdf` | `6af623884e50adecf90b01df19a5c9dcde47f55d846dc9809db1b6e6fbb68ac3` |
| `t43.pdf` | `1eeb1391677175ceaa91e421d46ddb7a7a5e0f63e764813e37e7923b813db1f7` |
| `t44.pdf` | `56b466013ef79d88d479f28cc08fcb22999fd08fa395a575134cbac59a5bdf02` |
| `t45.pdf` | `25e4b9697bef9546f6ad68e99b9e99d0abca4f2a12dc11b55d37c035cdf6a5eb` |
| `t46.pdf` | `e057a14097c46418b6abb3a9a42a46e75770ccb2c94408d57cb5ffa1abaea9ef` |
| `t47.pdf` | `94bf30c9b0e3e72970a0b9082e161f69bd205ab3d1108aee93820082ee74eec9` |
| `t48.pdf` | `7232dc380a4180fea11ef10740a4df6bbc1c94bf916b4a90af6a8858c21d2a81` |
| `t49.pdf` | `1ad727668a0bfb3710b69ae5e90eeb2d7685620c6aebb6de0a3e05033b8ffbb0` |
| `t50.pdf` | `75f2803ec2bcaa34222dfabda4841ce6f379eaa7545ecb2a6cd291d8f59561b5` |
| `t51.pdf` | `1dea81e24f3631f70dc212ec99cc06cd26e18235a47198ed05370cbc8214ad61` |
| `t52.pdf` | `1fc031463ef64b08dfefc11a1228990897e6957f716c404af38ca469b8ea3174` |
| `t53.pdf` | `12c7938332dca76ea9d9d72d8fabdd2625f148c23f6cc93d0ce30c0ffb3d4d7f` |
| `t54.pdf` | `167d12fb8f9c0157f6eac2dfb19754a6d02f7db37d50ff24c4fbcc700e4d8a88` |

## Adhesion and keep intact probes (164g.14)

**Producer:** as above, 2026-10-16. `t55.xml`-`t72.xml` as committed;
`captures/tN.png` are full Reader windows (not cropped). Every probe but t71
places a positioned `filler` after the 216pt oracle field, so page 1 has 504pt
less the filler left. Capital names are positioned subforms with a stated h
(unsplittable); lower-case names are draws.

**What Adobe settled, against the spec text:** a chain that cannot fit even
an EMPTY content area does not move to a fresh one -- the first member stays
where it would go alone and the next runs past (t69: C at 316, D from 616 to
1116 on ONE page; p. 312 reads as moving the chain). A flowed subform's
`keep intact="pageArea"` splits like `none`, across pages included (t67, t68;
p. 291 says not across pages), while a positioned one with `pageArea` still
moves whole (t71). `keep next="pageArea"` is no adhesion (t64). A splittable
subform that fits whole but not with its adhering next moves whole, not split
(t61).

**Derived, not read:** t66 and t67 state two content areas of 360pt (A above
B). Reader's `pageSpan` counts PAGES, so a subform split across A and B of one
page reports only its first fragment, and t67's second reported fragment
(`2,0,0,540,350`) is in fact B on page 1, mislabelled `page(c) + 1` by the
probe script. Their goldens are therefore `absolute` -- every draw's y is
relative to the A origin with B 360pt down -- and the subform fragments are
derived from the draws, which are read.

**t65 is compared in part (`only`):** Reader splits the empty field D 44/16
across the break; a field directly under the content area does not split here
(164g.13; follow-up 164g.27). C, the object adhesion moves, is compared.

| File | SHA-256 |
|---|---|
| `t55.pdf` | `883fc3b88e6c684a3642645093ac7b7b82193fce3893f0e45e6b7aa44d7a1f70` |
| `t56.pdf` | `d040653911588fa02ada8e4197fe4dc42b5a663f6356822d8ba615785bae32ec` |
| `t57.pdf` | `40f4977d50578fad78b6df5d4e30437cc52dfdfc57aa34ea4e665064496666b0` |
| `t58.pdf` | `ac3ad7e44d1555968df39dff42a99dce8fc7471a89179330540d538ae7bcb143` |
| `t59.pdf` | `506c1937220e1de20613388b57676b29680b242b8f7948e85565763019c563ae` |
| `t60.pdf` | `708c8f9755fa5dac88d13dcb2f39fbd425e5fd87e0c5854a4099d064346d7e97` |
| `t61.pdf` | `030dac3e585a5c12cff22ef3dff6a77d981af147e2418d0a3334f122f8a236b6` |
| `t62.pdf` | `be72431a739d64b7c6bab3a2aad4093635c9d78c84f230b74c415ba1593a972c` |
| `t63.pdf` | `18c26f434f2d550c7b59bd5241f9431fc2987226c61e20369385b9f8a4ae04f6` |
| `t64.pdf` | `3ee9a3a1293aefc6a8320cd8c90be9d62cc111a0ec009ecd16e362c0a93bbefb` |
| `t65.pdf` | `779fffba4e60fb50721a5e124a6dc4963df7b7a64de90be029980ad287be4fa9` |
| `t66.pdf` | `c0be7a5852d05109891d5cb32bf4ba02bf92723e0ad382edd0790af729d8e79f` |
| `t67.pdf` | `276a0e18ccd4c8981832c71de2878961bf2af3c5d8b5de26ad4388748de92ba9` |
| `t68.pdf` | `97f3af665b8dbdc317b58ec33419b712aef35b5dd793219a5e84d569567de427` |
| `t69.pdf` | `8c82be02af3a3d7db85a48152405ac8ddc3ccb191650a62ba29584604d6da08b` |
| `t70.pdf` | `27532f576db4d2ef6863c7de0afdc99b7017e9d9483491ddf66d653f4be68644` |
| `t71.pdf` | `46ed6e3cc5e7af6b47c102e23e6ab1ecab5a4f6f55cb27a6545d3e9e0d5f3415` |
| `t72.pdf` | `5ea1bde51d6c8f59b38b0c413b864bb5293551275b0304c10b0a260ed080b1ea` |
