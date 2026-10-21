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
Adobe splits a positioned subform, not conformance. Not covered: the bottom-piece rule for a field split (t21, 164g.13).

**t4 (164g.19):** a default positioned subform taller than an empty content
area stays on the CURRENT page, below the content already there, and runs past
the content area and the page -- `d` sits at page y 1044 on a 792pt page.
One probe, one shape: a non-empty current page, uniform content areas.

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
sets (done by 164g.22, below), page-number initialization and scripting.

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
is itself a splittable subform straddling the cut (164g.25, since probed by
t122-t126 below), repeated table
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

**t65:** Reader splits the empty field D 44/16 across the break, directly under
the content area. It was compared in part until 164g.27 split a page-level
field; now D and C, the object adhesion moves, are both compared.

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

## Leader and trailer probes (164g.15)

**Producer:** as above, 2026-10-19. `t73.xml`-`t90.xml` as committed;
`captures/tN.png` are cropped to the oracle field. The probe script changed for
these (`scripts/gen-xfa-adobe-probes.ts`): a `<proto>` is lifted to template
level unless the probe opens with `<!-- proto in root -->`, the report adds a
`content=` line -- per page, `xfa.layout.pageContent(p, "subform", false)` --
and rows are packed two to a line without the `xfa[0].form[0].form1[0].` prefix
and `[0]`s. Where a row runs past the window's right edge (t74's `D1`, t79's
`a0`, t81's `S.Y`, t83's `p0`), the cut value is the template's own stated w
or h.

**What Adobe settled, against the spec text:**

- A target in a `<proto>` at TEMPLATE level is ignored -- no leader, no trailer,
  no reservation (t74, t75) -- while the same proto inside the root subform
  works (t88). A target that is not a subform is ignored too (t90).
- Every copy is a new FORM instance: `S.H[1]` after the in-flow `H` (t73),
  `S.L`, `S.L[1]` from a proto (t76), each with its own fields. An overflow copy
  is named under the ASSERTING subform even where it is laid out elsewhere (t79:
  `A.L` at the top of B's fragment; t83: `P.L` in the content area's flow,
  above P's continuation -- its golden carries `layoutParent`).
- An absent `<occur>` allows ONE copy (t73, t88). A list is counted per ENTRY:
  `#X #Y #X` with X and Y `max="1"` lays X, Y, then X again as `X[1]` (t81),
  where XFA 3.3 p. 322-323 passes over the spent X.
- The trailer's height is reserved in every fit, the chain's last leaf included:
  t89's 100pt subform splits in 104pt of room (Example 8.40). The last fragment
  gets no trailer (t76, t88).
- A break leader and trailer SWAP the roles of Example 8.36-8.37: the TRAILER
  goes into the region the break leaves, the LEADER into the one it enters, for
  `breakBefore` (t85) and `breakAfter` (t86) alike; both are named under the
  breaking subform's parent (`form1.T`).
- The deprecated `<break overflowLeader>` lays out exactly as `<overflow leader>`
  (t78 = t77).

**Ceiling:** one producer, one version, hand transcription. Every probe uses
draws, plus one field in a leader (t73, t76, t87). Not probed, and refused by
name (164g.31): a break leader inside a split chain, on the start break, on a
break that does not move, a break trailer that does not fit, an overflow
trailer on a split positioned subform. Not probed and implemented from XFA 3.3:
inheritance past a spent ancestor (p. 325).

| File | SHA-256 |
|---|---|
| `t73.pdf` | `2f5c199646197d1c0d37f553e523e2a58955c3899d344a5c8d1db1f5769eca1c` |
| `t74.pdf` | `10b99b350c68bb87438765bed09d7e36d5a21cdee86c02067bb42c851e374359` |
| `t75.pdf` | `c5175421b6f3808e0edbb25f49a9bd0d082278060f481ae9fe82815da3c140e9` |
| `t76.pdf` | `88ad02aed070d9aed5c34515706f9662dd0182865dc3191d4f958e77e2e51e2f` |
| `t77.pdf` | `3e4630c735dffe2dcaca0747eec94c34c5d7f0b839fed86bc8e91833949dd4b8` |
| `t78.pdf` | `c9e1b4a9c1be602ab0b99e8b4d7c4e9187c64e1fd5ad499b3352742f2c200605` |
| `t79.pdf` | `2674f097c4a6835d7c7b869c84d2b80672b8d0c123ac9987db849eda8fa9a550` |
| `t80.pdf` | `6914878306d68a3dd27ef8d6960476f31d0659159ae96ecc39a0bfc98b597280` |
| `t81.pdf` | `28cc2365f13911ac48de5de75e611b25ec0c2696305c9ad19f69b806f8117af7` |
| `t82.pdf` | `f7f873f1976365b391413d51f0d160b71db10c524404b0a56470773fa64bea09` |
| `t83.pdf` | `4fc6b3bd2f81f1098e3f34d807f9a619a876fd0acaeb8767e1b7bf229b00dff1` |
| `t84.pdf` | `46f085e2e6173f5ace9edabdccac132b416eb3710dbce8389c8ec70e190047d7` |
| `t85.pdf` | `c4bb0e08fc1b1abe55c495e246d3739038d53f66b7dde95d9f1e017b64daf3eb` |
| `t86.pdf` | `739ecfb2f1cbb248811bf62a882f79f1ba3f51abce78e886420992ece4e36a54` |
| `t87.pdf` | `62c7138fcccfa1a8770dfd074468c6f560b15b9ac9d1f7b189edddb921725b79` |
| `t88.pdf` | `810eeaa293641d8ffdf82b7629ce54f7ad233c5fdbb123dff4648537b10a8df2` |
| `t89.pdf` | `0077fc26cf77968c75fb3b56af8f618231e078d447a90abea2e5b151e7561bd9` |
| `t90.pdf` | `4413fc8b05bddedf28b791006d3409339d55c63b6a2c2ef35078f423c0b7e4f4` |

## U+2028 probe (164g.23)

**Producer:** as above, 2026-10-19. `t91.xml` as committed; `captures/t91.png`
is cropped to the oracle field and the drawn leaves below it. Growable (`minH`
1pt) 10pt Courier New leaves in a `tb` subform: `A<U+2028>B` as a plain draw
(`ls`), a rich draw (`rich`, inside `<p>`) and a field (`f`), beside the
controls `A\nB` (`nl`) and `AB` (`one`).

**What Adobe settled:** U+2028 breaks the LINE in all three -- each is 22pt,
exactly `nl`, against 10pt for `one`, and the capture shows A and B on two
lines -- though XFA 3.3 p. 56 names only the newline and U+2029.

**Not a geometry golden:** t91 is outside `ADOBE_PROBES` and
`test/xfa-linesep.test.ts` reads it alone. Since 164g.32 that test compares
Reader's ABSOLUTE heights too (10pt for one line, 22pt for two), which the hhea
measurement we used before (11.33pt, 22.66pt) did not match.

| File | SHA-256 |
|---|---|
| `t91.pdf` | `88139c0d07790caf72d8df5d7fbbef67cdb92b299df78d4796c148b9403a541d` |

## breakAfter probes (164g.16)

**Producer:** as above, 2026-10-19. `t92.xml`-`t95.xml` as committed;
`captures/tN.png` are full Reader windows. A `tb` subform S, no filler: draws
d1, d3, a1, a2 of 50pt, positioned C and E of 50pt; the break is
`<breakAfter targetType="pageArea"/>`.

| Probe | Template | Adobe |
|---|---|---|
| t92 | S: d1, C (breakAfter), d3 | d1, C p1; d3 p2 at 0 |
| t93 | S: A tb (a1, a2; breakAfter), d3 | a1, a2 p1; d3 p2 at 0 |
| t94 | S: d1, C (breakAfter); then root E | d1, C p1; E p2 at 0 |
| t95 | S: d1, C (breakAfter); nothing after | TWO pages; S has an empty 0pt fragment on p2 |

**What Adobe settled:** a breakAfter takes effect before whatever follows,
inside the chain or after it, and a trailing one still makes a page. S is split
although it fits (100pt of 504pt), and Reader reports a 0pt fragment of it on
the new page, which moves nothing and is not modelled.

| File | SHA-256 |
|---|---|
| `t92.pdf` | `2a681005865f6a45f12c278b4032b4c2f192e1806d3189bc7601627137452349` |
| `t93.pdf` | `cd80df6b02554b65b16bfa4c92b2084e795fdf71dc07ff251a4a12f44a69afb5` |
| `t94.pdf` | `7cc41c3a09c99dfaa8546e8f656ea633798408f14be632f30f7f00a3d88a5243` |
| `t95.pdf` | `6a63361b9c6bb73046d1b5f97442195f9f620c87a1d17db75edf0da2e4ef0219` |

## Margin probes (164g.20)

**Producer:** as above, 2026-10-19. `t96.xml`-`t104.xml` as committed;
`captures/tN.png` are full Reader windows. t96-t100, t103 and t104 hold the
216pt oracle, a 360pt filler and a keep-none positioned `pos` stating
`topInset="18pt" bottomInset="12pt"` (t98 top only, t99 bottom only), so 144pt
of room is left; `nxt` follows to show the second fragment's height. t101 and
t102 are VISUAL probes on landscape pages 4.5in and 3in tall (t102 with a 1in
oracle, through the generator's new `<!-- oracle 1in -->`): filled 6pt bars
whose drawn position is read off the capture at about 2.29 px/pt.
`captures/t101p2.png` is t101 opened with `xfa.host.currentPage = 1` added to
show page 2; that variant is not vendored.

| Probe | Template (content y) | Adobe |
|---|---|---|
| t96 | draw d 120..130 | d stays on p1 at 120; h p2 at 56; fragments 144;144 |
| t97 | draw d 108..118 | d p1 at 108; h p2 at 56 |
| t98 | top inset only; d 120..130 | as t96 |
| t99 | bottom inset only; d 134..142 | d p1 at 134; h p2 at 56 |
| t100 | growable; f 80, g 300 | fragments 144;206; g p2 at 156 |
| t101 | bars a 0, c 28, b 36; cut 36 | a drawn at 270pt (fragment top 252 + 18); b on p2 at 54pt (36 + 18) |
| t102 | bars a 0, c 66, b 72; cut 72 | a at 126pt (108 + 18); c at 192pt, past the content area's 180pt bottom |
| t103 | nested keep-none `in` (insets 10/6) at 20, k at 150 | `in` 124;76; k p2 at 26 |
| t104 | draw d 140..150 straddles | cut 140: fragments 140;148; d p2 at 0; h p2 at 60 |

**What Adobe settled:** the cut is the room in the subform's CONTENT coordinates,
the insets ignored, and every fragment draws its top inset -- so the first
fragment's content runs past the content area by the insets (t102). A straddler
still moves the cut (t104), and a nested subform applies the same rule in its
own content coordinates (t103). This is what t14 showed and could not explain:
`xfa.layout.y` reports a child without its parent's inset, so only the captures
of t101 and t102 tell where Reader DRAWS it.

| File | SHA-256 |
|---|---|
| `t96.pdf` | `69355e527b937be01d74b54212cab386a78619cb34dc58d6baa9e9c0e6fd2ea6` |
| `t97.pdf` | `d5958cbbd2affeba2d83ce769f87666c6af2a4a0ded7ee73395c379eb038d7c7` |
| `t98.pdf` | `efa166bc50dd167da89bbf3161eb0eae918dc3e5036dee8484678d21b77b6da9` |
| `t99.pdf` | `10601bcf6542a36e3d1e260ba73ecf0e3bceb2de7c94a02239dfd57086a661ec` |
| `t100.pdf` | `0152abd653625755ad5705ec4c3e0838da4821157f2e98e5c0633652b7288449` |
| `t101.pdf` | `0dff2d4e6634141487e653f4b677be95370f730c96f1e6f46440a7f8c688cb0d` |
| `t102.pdf` | `4c06a05828de914dce93e4dfad7fd47ac0a013e24608c2b77d6eae9f4f9caac4` |
| `t103.pdf` | `b253332d701e8594222c52e4606c29d05cf6c439438ef9675e557305687c0105` |
| `t104.pdf` | `0bbe4f58196adf732f46278dd1482a610c03a1c012578c7dc29af433e6f4eab5` |

## Positioned subform in a split tb (164g.21)

**Producer:** as above, 2026-10-19. `t105.xml`-`t110.xml` as committed;
`captures/tN.png` are full Reader windows. After the oracle and a 360pt
filler, a growable `tb` subform S holds a 50pt draw `d1` and then a 288pt
positioned `pos` stating `keep intact="none"` (t106: not), with fields f at 40
and h at 200, so 94pt of room is left for `pos`.

| Probe | Template | Adobe |
|---|---|---|
| t105 | S: d1, pos | pos 94;194; f p1 at 40; h p2 at 106 |
| t106 | as t105, pos without keep none | pos whole on p2; S 50;288 |
| t107 | as t105, then draw d2 in S | d2 p2 at 194, after pos's tail |
| t108 | S: d1, tb T holding pos | T and pos 94;194; h p2 at 106 |
| t109 | pos holds a draw at 80..100 | cut 80: pos 80;208, S 130;208; dd p2 at 0; h p2 at 120 |
| t110 | S has insets top 10 bottom 20 | room 64: pos 64;224; S 144;254; h p2 at 136 |

**What Adobe settled:** a keep-none positioned subform inside a split `tb`
splits by 164g.11's consensus against the room left inside the chain, the
enclosing bottom inset kept clear (t110), and the `tb` fragment holds only
what landed in it (t109). Not probed: the same in an `lr-tb`, and an in-chain
split the rules refuse (we move it whole).

| File | SHA-256 |
|---|---|
| `t105.pdf` | `0d37201c6850b6729f99a4d7e4d7429d37f6d057293b5d5c88f2d80cf3c76bc9` |
| `t106.pdf` | `1a5990c1fb667cab0955c4024375f709bcfefcf3a9dc57300124f013832c3afd` |
| `t107.pdf` | `2b9811e5127453e428620eec19ba6de7107e0529f6fbe195863479e340562479` |
| `t108.pdf` | `6d14e757140f3a52a38dcfc09c0d65ba1615e2f99fabe94184830db36d9f6ad0` |
| `t109.pdf` | `28892e64ec4fb1e8e31179693b4162147a1d8329c6401be820fd5d9ff7528ac2` |
| `t110.pdf` | `cea8d6ec3c17196b5367638a1890e0c61fca82610108da08e1ee3b6e26052930` |

## Nested and sibling page set probes (164g.22)

**Producer:** as above, 2026-10-19. `n1.xml`-`n10.xml` as committed, each page
area carrying an `AREA-X` draw as the q-probes do; `captures/nN.png` are full
Reader windows. The generator now takes every page set of a probe whole (a
greedy match; identical bytes for the single-set probes before it).

| Probe | Shape | Reader |
|---|---|---|
| n1 | XFA 3.3 Example 8.31, 9 pages of content | A,B,C,C,B,C,C; items 6-8 laid out nowhere |
| n2 | outer {inner max 1 {B max 2}, A max 1} | B,B,A,B,B,A,B |
| n3 | outer {A max 1, inner unlimited {B max 1}, C max 1} | A,B,B,B,B |
| n4 | Example 8.32: simplex {A,B,C first/rest/last, duplex {D odd first, E, F last}} | A,B,C,D,F |
| n5 | siblings, `relevant="simplex -duplex"` first | A,A,A,A |
| n6 | two ordered siblings, the first {A max 1} | A,A,A,A |
| n7 | ordered {A, inner {B}}; breaks to #B then #A | A,B,A |
| n8 | simplex {A,B,C, simplex {D,E,F}}; T x3 to #D, U to #B | A,C,D,E,D,F (blank),C |
| n9 | n4 with both duplex, blank-only G inner and H outer | A,B,C,G (filler),D,F |
| n10 | n5 with the siblings swapped | B,C,B,C |

**What Adobe settled:** XFA 3.3's occurrence ascent through nested sets holds
as written (n1-n3). A break into another set terminates the one it leaves
(n4, n8), and -- overruling 164g.9's final review -- a page opened by a break
is redone as `last` like any other (n8's page 7). Parity counts physical
surfaces across sets and a filler comes from the entered set (n9). Of sibling
page sets the first is used whatever `relevant` says (n5, n6, n10).

**Ceiling:** one producer, one version, hand transcription, on-screen layout --
so the siblings' `relevant` is Reader's DISPLAY answer, not a print path's. Not
covered: fields on a nested set's page area (reported, not created), and
termination of a one-page visit by an `only` page area inside a nested set.

| File | SHA-256 |
|---|---|
| `n1.pdf` | `3118b6741f5306e4f4807168480442e9261e7b53b4e0339331ca89abb82bd7f9` |
| `n2.pdf` | `67dfc016c5eea99c385955bcba2f845c89225442d6a0d4e5347ac8b96a9ab835` |
| `n3.pdf` | `5c1dca3fb46b584efa6b0d190f89217cd30b699f3d2354e5f2743824e725f204` |
| `n4.pdf` | `7eb66bc2fd2acda4a2fb949e4fc6de43e34b232dcc9e50daef681556e30aa162` |
| `n5.pdf` | `501a53e4792b60bd84cfddbe9add8e7aac0f287fb6c6bcb8c6aba39112defd88` |
| `n6.pdf` | `4c530c17592ae10df0935c2dd5a11e97460ab0f08b4f56469e15d27d3c7a644d` |
| `n7.pdf` | `1de5f7f02025ebe195f287fc630bc76f3015e2b418581b9a923eb864ba94c3f9` |
| `n8.pdf` | `80d6c524b68d0758453a441cb5090f0d200ef0fc607a5395e6614e76ed9ddeb8` |
| `n9.pdf` | `2658950df148b81c025e8f97fe344d8e3272d6fe4075437503255bf0a25fef88` |
| `n10.pdf` | `faa9d30c0eeb665c654fa01de5c1cbaacd4bd3b14b939bbeac185bb6b436561d` |

## Line height probes (164g.32)

**Producer:** as above, built with `scripts/gen-xfa-adobe-probes.ts` and run with
`scripts/run-xfa-adobe-probe.ps1` on **2026-10-20**. Each `tN.xml` is committed,
`tN.pdf` is the bytes Reader rendered, and `captures/tN.png` is the window Reader
showed, its report read off by hand into `adobe.json`. Every leaf is growable
(`minH="1pt"`) in a `tb` subform, so its height is Reader's measurement of its text.

| Probe | What it varies |
|---|---|
| t111 | Courier New, Arial, Times New Roman and Myriad Pro, 10pt, 1-3 lines |
| t112 | Arial and Courier New at 8, 13 and 20pt, 1-2 lines |
| t113 | fields beside draws, and top/bottom insets, Arial and Myriad Pro |
| t114 | growable fields with a reserve-less top caption (for 164g.36) |
| t115 | a soft wrap, mixed sizes on one line and across paragraphs, `lineHeight`, rich `space-before`, an empty value |
| t116 | `lineHeight` against size, `<para spaceAbove/spaceBelow>`, rich `space-after` and `margin-top` |
| t117 | `lineHeight` 5-20pt at 10pt Arial, 1-3 lines |
| t118, t119 | t111 and t113 without their Myriad Pro rows |
| t120 | rich `margin-bottom` and `margin-top` together |

**What Reader settled, and XFA 3.3 does not say:** a line is measured off its
font SIZE, never its face. One line of text at size s is s tall in all four
faces, and the leaf grows 1.2s per further line, so a box is 1.2s(n-1) + s:
10, 22 and 34 at 10pt, 8 and 17.6 at 8pt, 20 and 44 at 20pt. A line's size is
its LARGEST run's (t115 mixA: 10 + 20pt is 20), and only the LEAF's last line is
trimmed to s, across paragraphs (mixB: 20pt over 10pt is 24 + 10; mixC: 12 +
20). A stated `lineHeight` L below 1.2s is every line's height (n x L). At or
above 1.2s a lone line is s and a longer leaf ends on 1.2s ((n-1)L + 1.2s), a
break at exactly 1.2s that t117 sweeps on both sides. `<para>` spacing is
SUMMED, once around the leaf, since a plain newline breaks a line and not a
paragraph (t116: 5 + 7 = 12, for one line or two). Rich `margin-top` and
`margin-bottom` are summed too (t120: 3 + 5), and rich `space-before` and
`space-after` are ignored (t115, t116).

**The fixture this needed:** t111 and t113 are recorded but not compared
(`ADOBE_RECORDED`). Myriad Pro is not available here, a draw in it is refused
for want of a face to wrap with, and a refused draw refuses its whole flow, so
no row of those probes would place. t118 and t119 are the same content without
those rows. Reader reported the same numbers for every row they share. t114 is
164g.36's.

**Measured:** eight mutations, each to one rule above, and each reddens at least
one Adobe case here as well as the unit tests.

| File | SHA-256 |
|---|---|
| `t111.pdf` | `8c53a9c5a8f6b892566bced791ab8f5270a3da2f5e4c38a7fbefc35d5973acad` |
| `t112.pdf` | `b89ed9e4ec4ae504a38f8bf1f28a91afe9f046fa0aa8b20a983424f3bf4232ab` |
| `t113.pdf` | `fbc2c1834dd9c8a655a458dfddd75a116dbea6d9d175f5afe07b1cf68ae85030` |
| `t114.pdf` | `9776cb05041e530e7ea639548147726d7ed177fa9505e861515ea511c14826d8` |
| `t115.pdf` | `6639a1870681a1744f187d93abfae02d4e9fd0794c88841d2d308564bf28b2a3` |
| `t116.pdf` | `f404c4f9516929db2c8a21c325a6f5f73da4ff6abdfffc49a2a512e9608e2c4b` |
| `t117.pdf` | `dd1af0620070c968788f9f9d3e17b378ee1b994a44ad5f06944aaa26b15c7b04` |
| `t118.pdf` | `2e0d9d7d7ca691aad26ea10999657344c8c18b42f4223d91351a7ee1c6a822ad` |
| `t119.pdf` | `e0f09eaeaf1527b587be198ae0f21a58deb4edabf233b94f11dd579d33c94c1a` |
| `t120.pdf` | `edcbb86c1dbd152baa0a2f197e984fefbe44b4b31876bd48a15a4ebec4c7e3bf` |

## Reserve-less caption probe (164g.36)

**Producer:** as above, on **2026-10-20**. `t121.xml` is committed, `t121.pdf`
is the bytes Reader rendered and `captures/t121.png` its window.

| Probe | What it varies |
|---|---|
| t121 | top captions stating no reserve, 0.5in wide: one fitting word, three words, one 16-W word, caption margins, a 12pt caption, a fixed-height field; and the 16-W word as a draw and a field value |

**What Reader settled:** a caption that states no reserve takes its text,
measured by the 164g.32 line rule at the field's width less its insets, with its
own margins and its own font size (capFit 8, capTwo 27.2, capMar 2 + 8 + 3,
capBig 12). And a word too wide for its box is SPLIT between characters, not
left to overflow: sixteen 8pt Arial W in 36pt are four lines of four, 36.8pt,
whether caption, draw or field value. Neither is in XFA 3.3. One rule was refuted
by this probe: the work in progress had assumed "one word, one line".

**Compared:** the harness compares `dWide`, `fWide` and the oracle field
(`only`); a captioned field's widget excludes its caption, so the six
captioned fields are compared by `test/xfa-caption.test.ts`, widget top and
bottom alike. t114 stays recorded: its Myriad Pro row has no face here.

| File | SHA-256 |
|---|---|
| `t121.pdf` | `b4df0fa5483f34e545fd81f3414181bdf9e5594bc588585348f8cc43063b25ae` |
| `t121.xml` | `1557ab609d928a971b1ae968c88b487ac4d8a752a6bd532096dfb9a824ef9d69` |

## Splittable lr-tb item probes (164g.25)

**Producer:** as above, on **2026-10-20**. `tN.xml` is committed, `tN.pdf` is
the bytes Reader rendered and `captures/tN.png` its window. Each places a
400pt filler so 104pt are left on page 1, then an `lr-tb` flow whose second
item `s1` is a splittable subform straddling the foot.

| Probe | What it varies |
|---|---|
| t122 | `s1` a tb of four 40pt draws, two 180pt items after it |
| t123 | `s1` an lr-tb of six 90pt draws, two to a line |
| t124 | `s1` a table of three 40pt rows |
| t125 | `s1` a tb starting on the flow's SECOND line, 74pt left |
| t126 | `s1` a tb, beside a 150pt draw |

**What Reader settled:** `s1` splits between its own children exactly as a
page-level tb, lr-tb or table splits (164g.12): what fits the room left below
its top stays, and the first child that does not fit ends page 1. The rest of
the line does NOT stay on page 1 even where it would fit (t122's `a3`, 40pt
in 104): the tail opens page 2 at x = 0 and the later items re-pack after it,
so the flow on page 1 is as tall as the head. A table keeps its column widths
(t124). Every field and draw of all five lands on Reader's page and box.

**Not covered:** an item holding a break, which is still refused.

| File | SHA-256 |
|---|---|
| `t122.pdf` | `b04883a568912a18d4528522e255798787002c9259dbca475f77b299bd233233` |
| `t122.xml` | `bc9afda132656c4f62ff4f4cf408113c3cc68922076ce4b57b96308b31b48f67` |
| `t123.pdf` | `389a5d78616dd451338a7eb0be569b867b39c181edf34fe74d3d6a2ffd6824af` |
| `t123.xml` | `c45e3be668415552506b1173d7de2e5c00c71c102cfa713373eb1b365576d30a` |
| `t124.pdf` | `29e7e2b849abc4aba1f2f088c80bf3137f4dd2d6907d9f775bb560be5eeae9a0` |
| `t124.xml` | `061c3449bcbe92d36361c137d87fba529fd4edbe92e55360262dff3c8b30f8c1` |
| `t125.pdf` | `0cb1bb8cb6c4f4f0f60585674c0d417eb5faf4831c0c4268c5e06e6470318c6c` |
| `t125.xml` | `dbae29309ac2fc757420ef8a17f343a96c008753fabe03b565e75c506200ca53` |
| `t126.pdf` | `8e7b6750d7a2d411ffa2be57d424eb87004a5c3362dd2ef331800a7b1a0071bd` |
| `t126.xml` | `71607083633ab30809014f698bd2ff1d1ccf94eae46ff766247ad2ca9bbd955d` |

## Field-shape split probes (164g.26)

**Producer:** as above, on **2026-10-20**. `tN.xml` is committed, `tN.pdf` is
the bytes Reader rendered and `captures/tN.png` its window. Each is t45's shape
-- a 360pt filler, then a keep-none positioned subform holding a 2in field `f`
of ten 10pt Courier New lines that straddles the page foot -- with one property
164g.13 refused switched on.

| Probe | What it varies | Reader's page-1 piece |
|---|---|---|
| t127 | a left caption, 1in reserve | 60, as t45 |
| t128 | a top caption, 20pt reserve | 56 = 20 + 3 x 12 |
| t129 | top and bottom insets of 10pt | 58 = 10 + 4 x 12 |
| t130 | `vAlign="bottom"` in a 160pt field | 54 = 42 + 12 (the block is 118, not 120) |
| t131 | `lineHeight="15pt"` | 57 = 12 + 3 x 15 |
| t132 | `orphans="2"`, 14pt left | none: moved whole (t52 kept one line) |
| t133 | `widows="2"`, 112pt left | 96, 8 lines (9 without widows) |
| t134 | a check button | none: moved whole |
| t135 | a list box (`choiceList open="always"`) | none: moved whole |
| t136 | a comb of one line | 64, a free cut below the text |
| t137 | rich text, one 20pt line among 10pt | 60 = 12 + 12 + 24 + 12 |
| t138 | `lineHeight="20pt"` | 52 = 12 + 2 x 20 |
| t139 | `lineHeight="9pt"` | 63 = 7 x 9 |
| t140 | `vAlign="middle"` | 57 = 21 + 3 x 12 |
| t141 | t128 with 25pt left | none: moved whole, not cut at the caption |
| t142 | t130 with 30pt left | none: moved whole, not cut above the text |

**What Reader settled:** a field cuts at a line bottom of its own grid, from
the field's top: the text starts below the top inset and a top caption and is
moved down by `vAlign`; each line is 1.2 x its own size, or a stated
`lineHeight` L -- every line L under 1.2s, the first line 1.2s and the rest L
otherwise. With no line bottom above the room it moves. `orphans` and
`widows` count lines of the whole plain-text value, newline records included.
A field that is not a text entry moves rather than splitting. All sixteen
land on Reader's page; t127-t129, t134 and t141 hold a widget smaller than
the field box, so they compare our layout's field boxes (`fieldBoxes`).

**Not covered:** a bottom caption, paragraph spacing, a lineHeight with mixed
sizes, and orphans or widows across rich-text paragraphs.

| File | SHA-256 |
|---|---|
| `t127.pdf` | `dd0bba05737e7b8af87c5da8dc7f0f494c0054ab14e0b026bad048612695dc9b` |
| `t127.xml` | `297499138dadff9a98b29f145d765917a4c3c3bdd35343df05f5ee19ab881897` |
| `t128.pdf` | `f9d0d8eafac3383574ddc099a9c259b1f36172c1b3534d4399ffb73bf81ba0d6` |
| `t128.xml` | `31c11e7f960f354565654ac1c1b07a5ff45e1b96ed539719e107f41b836ce51c` |
| `t129.pdf` | `5a6ddf02789d162f7d1f916a10f153e9dcbb624a9b5e0714f3d2d409d884b57a` |
| `t129.xml` | `c63d68877bf0696a4ecf934c1e58f66d553e01e6452e63ed2dbf3ae8f15c3e02` |
| `t130.pdf` | `54a36b832ac81512af6139b7095aa69e2d5b81dac67f99747473925f1ddc94e5` |
| `t130.xml` | `b6390f044deadc040f849bf7ffe620bbdb14182a22acda175305482db367a900` |
| `t131.pdf` | `71dd4d8ab573101b3347c5c65c27026e1290c7bdab5c8e58832caebb1e471635` |
| `t131.xml` | `5922b5f4523b281d40870eaf14cbd6b4e822cf393fbddc79d1e161f3536fa426` |
| `t132.pdf` | `e878a9ceff522ba9ede7d9f6d80e684cfcd017268c9d244508d1851f39ecf191` |
| `t132.xml` | `25c62bbdfbbd7d203a88c8ab0522017edfa5c4db8529164023dff6dc8738897e` |
| `t133.pdf` | `3fa10afb70d154c62e259b3c36b880fa6f2e100f5dff6b8b641779d66e23c8c5` |
| `t133.xml` | `2a428d61bbae3acc804b08347646e73bb26c5a862dff50b0637c70006c5500cf` |
| `t134.pdf` | `f1dc1e7b3940b0f14739a7cec45faae961c77deff55adf52662baabace449dae` |
| `t134.xml` | `df01d658f59bc9288a81e70a67859a0dd475b8a66f8bea39dc5a1a91e2c52175` |
| `t135.pdf` | `a8b3d7fdaedbdf6b2caddee1447c10f20b4f0766d8ff08b70b4280a46c9d90bf` |
| `t135.xml` | `bb68f7ee44062da28763c038b0f108587ad307f86e62f6dab2c2dfb074dc97c3` |
| `t136.pdf` | `2d029a98812e0147eb91c2c044535afa29d40b791864c66ce503bd761726419e` |
| `t136.xml` | `759254b69ab182d546791b5f9e630885bd3667108b728bedd2934c3b7d46c1cc` |
| `t137.pdf` | `2e49d8eaa5b3e1450916039dfedefac99b7450720e5a99deb6497da8804be771` |
| `t137.xml` | `d89564480f0d8ae45cab87525ccefe52d89afaf43957e56a44c508198042a2a3` |
| `t138.pdf` | `5c3dc1d198e98bc3971cba0b1a78e6d3010fcd43d7ec1ee3c6274eaada147a07` |
| `t138.xml` | `516dacc218ba24b35b9e5f6364cb00a62f9ba65be0cffdf6c6bb1c17011ff4d5` |
| `t139.pdf` | `53503d3c0e590c435afe1922624d2b39ed68217bb6b8a3de4b03c34bb1120ec8` |
| `t139.xml` | `31e4628e0ccb5a626809ba3c9925cee896501b8cbdcb7155373b2ef8d346343a` |
| `t140.pdf` | `0d870739d468681bbc3d9b156f294374f0870aa427f61b517ffcad833388431d` |
| `t140.xml` | `9a2bd311323d1bcf21023140cb4a6b11ecf5a08546308f4f2a0a8d652ca7df3b` |
| `t141.pdf` | `99e24e988acddcdc796bda6a7b2bbd2480088f73529f376dfb0d154f2fed9e5a` |
| `t141.xml` | `d53f633715bb00b321f29a233e5a3902b3b09bd91508755237b0d69f0f30c8ce` |
| `t142.pdf` | `868ae0103c5500ee3df1c679e2450b9f1301b4d545f4d5a3088fa0cab9a8a3a7` |
| `t142.xml` | `71cf8732b35023fb3a7824fe78f35df31852b1163605557467a48af8d686aca0` |

## Overflow target probes (164g.30)

**Producer:** as above, 2026-10-21. t143-t159 test `<overflow target>` (XFA 3.3
p. 366-367, 791). The generator gained one hook: an `<overflow .../>` followed
by `<!-- root -->` goes on the ROOT subform. Two page sets: P1 = { C1 (5in), C2
(3in) } with P2 = { F (10in) }, or P1 = { C1 } with P2 = { G1 (2.5in), G2
(5in) }; content is 72pt draws. Each capture is cropped to the report.

**The goldens are DERIVED, not read** (`adobe-target.json`): each draw's and
field's top in PAGE coordinates, from its reported y, its parent's fragment and
its content area's origin. Reader's `pageSpan` counts pages, so a fragment in
a page's second content area is reported under the NEXT page number (t67's
trap); each node's own `xfa.layout.page` is reliable, and its y within the
parent's fragment tells which content area it sits in.

**What Reader settled:** the target replaces the natural next region for EVERY
overflow of the container stating it, a root child that merely does not fit
included (t143, t144, t149, t150, t153); a content-area target behaves as a
`startNew` content-area break (t157) and a page-area target opens a new page
of it every time (t147); a target is inherited (t146), holds only while its
container continues (t145), and a stated `target=""` blocks the inherited one
(t158); a positioned subform IGNORES its own target (t151) but follows the
root's (t159); a target naming nothing goes to the next PAGE, never the
page's next content area (t148, against the t154 control); and a leader opens
the target region (t152, t156; t155 is the control).

**A false start, recorded:** the first t152, t155 and t156 put the leader's
`<proto>` at template level, which Reader ignores (164g.15 R1, t74/t75), so no
leader appeared even in the control. The vendored ones carry `<!-- proto in
root -->`.

**Ceiling:** one producer, one version, hand transcription. Not covered: a
trailer beside a target, a SOM-expression target, a target in a nested page
set, a root field split under a root leader.

| File | SHA-256 |
|---|---|
| `t143.pdf` | `892a5cf0dbcd4d12330042451b7c23fcbce28562b2b3aa302432db83a11677c7` |
| `t143.xml` | `6004a116967661a6491ba1766dd28dd2e327c5a0bc0e653d378772df534f8e83` |
| `t144.pdf` | `2c81ef17b8b756266cb32b4ff057aaa9ddf3826c29abe7b663cfc1b129e8c061` |
| `t144.xml` | `b762cbf6f445c84fa010c43ff0e24455637cefa165cbe8fbd81d961e37b68310` |
| `t145.pdf` | `dca583f62b062856062a95ab7719045be76bb8dd8fe3302d0048b61c8421839a` |
| `t145.xml` | `48ec00bb63d8ed3a15845e7533cf8a3feb252460b354f75a4181a815242a3a6c` |
| `t146.pdf` | `8fb5d47141068c45a98a12568212d159058dbfef4adbd4f05d1f53d97b8a01d3` |
| `t146.xml` | `3a7ff9c36c2251afec5c391716a3492b219d5d2b12ad579745d641bea7280b00` |
| `t147.pdf` | `705808bd0ee14375fc758278d52e042dcba17b26efa287e9ebecbdb531d915ce` |
| `t147.xml` | `fee2e4f824e705f0f8cc5097b7fec43474edd9049321bc771ce7c9e8068fef62` |
| `t148.pdf` | `35b188615ee23caffddc7c596e5519a03d9b68d3e7c12636d777748c346eff4e` |
| `t148.xml` | `1c0eb382faea11e32def6439d5d78d162a84fc1ed6a8ffc879cd5b567b4fc26f` |
| `t149.pdf` | `82706da1166df0e77cc8f4439de127ca42540fb7e813c19c70139234fb9f41ff` |
| `t149.xml` | `357be37b1813af00c41169fc296a094feb964384ab5cd45e1ac5710734c48d28` |
| `t150.pdf` | `ddfef9733f6eb3c17b42bcec85116cc2f3a4b9c14abf42eaab1e4d4a6bc5fb62` |
| `t150.xml` | `692de6ef0f8bec7551f7cf9eb61001530f13a460e0a935bd33285753a51df298` |
| `t151.pdf` | `8310e447d5fa8bd015adcfccda32010f577eda91f59d92ee419872c914052457` |
| `t151.xml` | `11a7fbf5c02a24e540e5dbc108470395eec2f0d9429e32a0dc9cc31f290d32ae` |
| `t152.pdf` | `afca9c871faeb174a75e5e50df7bfe0605d287451c3d249cb7936c2aa0635c1a` |
| `t152.xml` | `6de8f0acda00a78ac4b621ceb065b562a9c03bb013e14eb67133334abc293ce9` |
| `t153.pdf` | `91e53acef3ea9fb3dcea7ff474beca57f849fa05ea25d98bb94d0ffb802b07ae` |
| `t153.xml` | `04ed9d5d6543ee6ef4c0980d1fb0bcbccdda65f4e8922a31fa90d7b2521ab4b0` |
| `t154.pdf` | `20dc91d3bf6ceb5a8246e597e4f501b21b7eb3c2f94b199c34484eb416ad7de9` |
| `t154.xml` | `46cf5dc0f857ae97b7bb231fdcd29bc321fe3787cbb054cf5939b62a6da343f0` |
| `t155.pdf` | `8e6d073d4005b152414f28ec3235a1955f77c8b6fe2de262a1da91395ac06b3d` |
| `t155.xml` | `1ba0211824ae0abb5e08ebfc7875cf997a36580b6be52635d26f7f3d9c3ddacc` |
| `t156.pdf` | `1edc634ca9b5feb83eb049ba71b0fb00fc6f8efe95b9f2ca975ea0028bd9f728` |
| `t156.xml` | `954e1a43d55ca7b9957c50aa9d9ed134ac6c70903c18680f523c052db0449279` |
| `t157.pdf` | `fbddc955f83c371170fddc07c6adf0d41dd0df631a1d8d782bc884338fd275ce` |
| `t157.xml` | `04592973f2266e12b9db1f57babbb9923b53b16c132b19400a0afe6b097f93da` |
| `t158.pdf` | `ee928460ef2cc02c314731a5afa8b3fdad8dedab475c0a883a06998610a42a7e` |
| `t158.xml` | `9e19a4031b528ddc83e9c15306f19b1099ae84cdf9a78f26ed1d75d2efc64201` |
| `t159.pdf` | `63d7d37000563cd0bd532befc0d98c422079f4f5a695e3e56128af502604f95c` |
| `t159.xml` | `9636983d66a34b2d3683d6b73086e568bce37b77314f1d5a4bdc23c7adbe1634` |
| `adobe-target.json` | `33f8414d5c1ef243a29af84f80f68013b3b4e7f073a5e617c7bfdb94e2fd65e6` |

## Bookend probes (164g.29)

**Producer:** as above, 2026-10-21. t160-t176 test `<bookend leader trailer>`
and the deprecated `<break bookendLeader bookendTrailer>` (XFA 3.3 p. 317-318,
326, 625, 634). The generator gained one hook: a `<bookend .../>` followed by
`<!-- root -->` goes on the ROOT subform, as `<overflow>` already could. L and
T are positioned subforms 20pt tall, each holding a draw and a field, in a
`<proto>` inside the root subform unless the probe says otherwise. Each
capture is cropped to the report; the goldens in `adobe.json` are READ, in
164g.11's parent-relative form.

**What Reader settled:** a bookend leader is the subform's first child and the
trailer its last (t160), through a split (t163), in an lr-tb (t169) and a table
(t176), with no other content (t162), on the root subform at the start and end
of the document (t166), and through the deprecated `<break>` attributes
(t170). Every subform, and every instance of a repeating one, gets its own
copy; a target's default `occur max` of 1 does not limit them (t161, t167,
t174). A copy is a form instance named after the instances the walk counted
(t172: `S.H[1]` beside the in-flow `S.H`). A positioned subform ignores its
bookend (t168); a template-level proto (t165) and a draw (t173) are ignored as
an overflow target is. A break leader goes before the bookend leader and a break
trailer after the bookend trailer (t171, p. 364, 366); a bookend trailer is
ordinary content and reserves nothing (t175); combined with an overflow leader
and trailer (t164, Example 8.46), each kind does its own job.

**Ceiling:** one producer, one version, hand transcription. Not covered: a
bookend copy and an overflow copy of one name in one scope, an `rl-tb` or
`rl-row` layout, a bookend target that states a bookend of its own. Draws a
probe repeats on one page (`Ld` and `Td` in t161, t167, t174; `Hd` in t172) are left out of
`draws`, the harness matching a draw by its bare label; their subforms are
checked through their fields.

| File | SHA-256 |
|---|---|
| `t160.pdf` | `d9d4d5ff986c82b5c1bf2d1732178d206876cd832375f3ad626b4532e68158d1` |
| `t160.xml` | `972e5e5a378c57aeca8e48d56a6292b39fc5e20b3dd791e58148b77af9fb7f0c` |
| `t161.pdf` | `c0cf172f1934754ec746ed1236604a2819bf86649f410cdf9fdc8461144f4045` |
| `t161.xml` | `6e8d8aa5de3f72212846ca4d109681fb620ade4fd9a4241115a9b0c839102fe5` |
| `t162.pdf` | `4991e624cbb4b3c92594fdc0c38284afaa68adc6b8b045d519a5fe46be03c834` |
| `t162.xml` | `ee821257b74ea63f92d8a2e1479b536f86a8c2ed9ac8af7be78f9cfa733e50cd` |
| `t163.pdf` | `4dfd5136e46ea6998459c78d21d81c6f609e19fb40253542f8654fe5febf26bc` |
| `t163.xml` | `3fac3c0e69c3f6473ae27cd78c69f58b45cdbfe38277fa36d65afcb82f774bdd` |
| `t164.pdf` | `60dc345273b3c2e15e1a289d841edd9b292199736702222a4ed4c1d36b43cf7b` |
| `t164.xml` | `9d83d4db2a35858438ffa86795fc5e550c7a558642069e30f3c3db29d865aa00` |
| `t165.pdf` | `616c6bf0e44aa1df645d323517e505c3a3299689bcb1664b51be0e08886da7c8` |
| `t165.xml` | `5df31cc7e5c5f0c4a2facd8357f9aa7e7c646af0c225333ea3c36746bd50a5d0` |
| `t166.pdf` | `7d20526593f60ea0b89cd5c19cc0bc4b740715a1cc74951e273372531b4855be` |
| `t166.xml` | `06405b048f1a973b464bb656729c9baafac62ee7ce3c7099722b7e4d9ab34f70` |
| `t167.pdf` | `449e7f5ff9378a30cb60d3bbb05b77cd74232e68f62436973da20628dcfb510c` |
| `t167.xml` | `b69e99318f51ccbdfacb6083205a7964981bf83cb422ef3630a06f3d21787a94` |
| `t168.pdf` | `f78ab47ec905e74ed9533ab6848006ce531e83defbc26b4b8d9f8de87aa1b4e3` |
| `t168.xml` | `1d7481dbfc77366a6f0c820f89569996366db203c3ed0ea66a0feb94fc5d5310` |
| `t169.pdf` | `db27023a059802833e940336fc9bd9df13627ccb645317fa132c7807f30688f0` |
| `t169.xml` | `9c0446a05d9cd813199cd9d0e93bab494822bcc8ba979393758db55ec422b18a` |
| `t170.pdf` | `c686c443371c6d437edb73dfdaf791dbce6ae2567a51121b14dc060bdd45b598` |
| `t170.xml` | `6ec954bfe2b340cb31442df089ce845a872ff354dc1d035987dc6d561ed9777b` |
| `t171.pdf` | `78657804f8cb31b4c12afdc12df74421c5ac7b277ff840f2c3faa6a4de993862` |
| `t171.xml` | `0391e6781dd09591dcfab15d7f2a0a42574fa99bec6122e8ec1bb10b8de72d0d` |
| `t172.pdf` | `8be6b200c14a70bdc3fbbad7cb15dbf0cbf3c8f774685565a4b2d74e6ac0d251` |
| `t172.xml` | `1c9e53ac5fc8af4f50c15e5972a0f0a897da0db9411163946cf92ed5a378b3d5` |
| `t173.pdf` | `a0a94c7a542d6bbe6af134861949bda5f4a598f7b9ebc06d512b64c3d6d64ecd` |
| `t173.xml` | `7c6a71919f97d2ad937607fb8306693ef49294b48f5add3ad87d1e27390f9705` |
| `t174.pdf` | `82a3a29fc474ddb63036a771b4379d086c0c4210ecc5b3fb8fb33ef45ba9f220` |
| `t174.xml` | `35657077c64f17ec8dd450a15fb7919f8726090f6f9835b175738dfaee8a38ef` |
| `t175.pdf` | `964b50f211011fdda4c6a81574e6e83685495da1037b6136f3d4ab0b3609f1a6` |
| `t175.xml` | `5c651e054248de983dbcef7b7eece45852d5e399bfb4b63b010220d15d361a67` |
| `t176.pdf` | `b358786367b6b9c584f352bf26881a22ce606f01283dfe35e82f883a23bd3241` |
| `t176.xml` | `aec8f1654409d233dafe02581621e48dd1dc8853da1a0cb07b57db6671359612` |

## Refused leader and trailer shapes (164g.31)

**Producer:** as above, 2026-10-21. t177-t186 test the leader and trailer
shapes 164g.15 refused as unprobed. The generator's root hook now also takes a
`<breakBefore .../> <!-- root -->`. L and T are positioned 20pt subforms with a
draw and a field, `occur max="-1"`; S2 is a positioned 50pt subform carrying
the break. Each capture is cropped to the report; goldens in `adobe.json` are
READ. t177 and t180 drew a blank window on the first run (Reader had not
finished) and were captured again after 25 seconds.

**What Reader settled:** a leader or trailer on the break that chooses where
layout starts is ignored (t177, t178); a break that does not move -- `auto`
(t179) or a page area naming the current one (t180) -- lays its trailer then
its leader in place; a trailer that does not fit opens a page of its own and
the break then applies from there (t181); inside a split chain the copies are
children of the breaking subform's parent, the trailer closing its fragment
and the leader opening the next (t182), and a trailing breakAfter's leader
makes a fragment of its own (t184); a break lays no OVERFLOW leader or trailer
(t183); a split positioned subform's overflow trailer is reserved in the cut
and laid in the content area's flow below the fragment (t185); a positioned
child's overflow inside a split positioned subform is ignored (t186).

**Ceiling:** one producer, one version, hand transcription. Not covered: an
`auto` breakAfter, a trailer that does not fit inside a split chain, a break
nested below the root child's own children, a non-moving break inside a chain.

| File | SHA-256 |
|---|---|
| `t177.pdf` | `4b041eaef913022741f14401320adbc66839fd30ed1c47c6beb83cc118d3e368` |
| `t177.xml` | `3fbdf2986ce8a60c7c2cf8e751a68415869304b672ba0276a202b3fc5ae2692f` |
| `t178.pdf` | `aaa4804157ae34cfd41137821fbe34e94164f0414b3f26f976d908b4766dcee3` |
| `t178.xml` | `51133578c960eec28ff78ce3306a48433c7da80b8f4173d552884bdf090897df` |
| `t179.pdf` | `6b95c33163ad683ef1194aceaddc6fb1beac0fe41775d16b67cd94a9a9a9eda0` |
| `t179.xml` | `7d6fc77db5342db7a3b1dd75efbe68bd10be7f21596ce16375349b491bc7920a` |
| `t180.pdf` | `6fbcb5c97a3c7b8a90899f9a6a8b6d7fac67adb06e6a86356cbd038b53b474ca` |
| `t180.xml` | `b5344c4d995aaf3e6704719b57bff409a2816176491e28c672d6442d6a09967c` |
| `t181.pdf` | `008e207105f8672a9622ad6c29d85c32b3badd83e430a3f2d9cd12d0ec95e7bd` |
| `t181.xml` | `c79a30126f02bbd0e82706908fa0ef8710b8e87efb88da588a41bbdbf0f25761` |
| `t182.pdf` | `fa031f51fb4ae201ea21bf4ed39e9c8984b0feb0533ed3d71b1e86775072ee59` |
| `t182.xml` | `32a810aa024952d7a1ebdd066fd83bc779b329f0e08dbc85c13898c033234b31` |
| `t183.pdf` | `d25b6b87652f1659458aeffb4f578925629758ecfc548a82b9893d7a2c1265e8` |
| `t183.xml` | `b11271e3edc83226c39fb4a78a0003c658b79e10ea9cc6010e76901efd477339` |
| `t184.pdf` | `1196b5582e1a74d526270c2304e9f3ab709604efdfc7b44ba0e2ab282f5e2b3e` |
| `t184.xml` | `a8d247943d575babf8389dec55c9024e8b3e7bed854014e3be359819529c9b7b` |
| `t185.pdf` | `0ffe9d2324c0fec076400c9b9e0f98be884841c0f9f71971d7213c7c33d99298` |
| `t185.xml` | `d40024eb1a465c818fbf2a684e9d6daa62401ab5cea1cc7ee37504d8eb0765d4` |
| `t186.pdf` | `b953827c830f53bf75a2251e5d8a4419b721ab98109308e8138808722b82169d` |
| `t186.xml` | `97fea1a64cd915d9d4983fd8dd04a570feebe60cbc26a5b0bbb836bd01873130` |
