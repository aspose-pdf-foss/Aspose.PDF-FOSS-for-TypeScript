# Frozen upstream inputs

Both files come from ArtifexSoftware/ghostpdl commit
`9a39d68ca934f8e9343f46a2803e765122a3b4a9` (tag `ghostpdl-10.07.1`).
Their bytes, including line endings, remain unchanged.

| Input | Original | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| upstream-tiger.eps | examples/tiger.eps | 78687 | ed255555fdab768cce7f025dcde744a6807292cac40f80f73733fbffe61edb4f |
| upstream-colorcir.ps | examples/colorcir.ps | 2061 | 3867d5e63b6e48e67682970254161368e718a6fb486c49a8029689d2b5d7d9ce |

Source: https://github.com/ArtifexSoftware/ghostpdl/tree/9a39d68ca934f8e9343f46a2803e765122a3b4a9/examples

Tiger identifies Adobe Illustrator 1.2d4 and OpenWindows Version 2 in its header.
Colorcir is an upstream example, not application-produced output. The upstream
LICENSE includes examples in GPL Ghostscript under AGPL-3.0-or-later; retained
LICENSE.ghostpdl and COPYING.ghostpdl carry its terms. These are test inputs,
not runtime code or package assets. Font fixtures reuse their existing licenses.

The other inputs are original repository test programs. Their literal samples,
counted spans and DOS headers were authored for this corpus. The RGB/Gray image
dictionaries explicitly request interpolation. inputs/hashes.json freezes every
source independently of regeneration; no normal test rewrites it.
