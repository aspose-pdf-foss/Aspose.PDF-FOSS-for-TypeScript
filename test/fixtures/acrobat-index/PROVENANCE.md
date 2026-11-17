# Acrobat embedded search index fixture

`testing.pdf` is the original three-page test document from Matthew J.
Clemente's `pdfbox.cfc` repository, distributed under its MIT license. The PDF
identifies its Creator and Producer as `Acrobat Pro DC 18.11.20055`. Its creation
date is 2018-07-20, and its modification date and embedded index creation date
are 2018-07-23. Retrieved on 2026-11-17 for issue `g9vh`.

The upstream test suite explicitly asserts that this file has an embedded
search index and exercises removing that index. This fixture supplies producer
bytes independent of this repository's synthetic dictionaries. The current
local Acrobat installation identifies itself as Reader, so generation was not
repeated locally.

- [Original PDF at commit 553b0d477efcd1ac6a467efc3210f63aa3b63580](https://github.com/mjclemente/pdfbox.cfc/blob/553b0d477efcd1ac6a467efc3210f63aa3b63580/tests/resources/pdfs/testing.pdf)
- [Upstream index detection and removal tests](https://github.com/mjclemente/pdfbox.cfc/blob/553b0d477efcd1ac6a467efc3210f63aa3b63580/tests/specs/pdfboxcfcTest.cfc)
- [Upstream license](https://github.com/mjclemente/pdfbox.cfc/blob/553b0d477efcd1ac6a467efc3210f63aa3b63580/LICENSE)

## Identity

The file is unmodified, including its original object numbers, compression,
metadata, forms, attachments and actions. Tests load it as data and invoke
Sanitize through the normal Document API.

| Property | Value |
|---|---|
| Bytes | 3,052,539 |
| Pages | 3 |
| SHA-256 | `b64ad5904f07dcf2ddd17d28748070ecb05a9e4ef71173793805e8a2ebd980d6` |
| Upstream Git blob SHA-1 | `3a400a071a5b900e8f8f7e9de908f808d4b93c07` |

## Observed dictionary

`qpdf --show-object=1 testing.pdf` reports the following catalog entry.

```pdf
/PieceInfo <<
  /SearchIndex <<
    /Index1File 8 0 R
    /IndexFile 9 0 R
    /ModID (2cfecdfd3bd94bceae9d4163e1c268d5)
    /PDXFile 10 0 R
  >>
>>
```

The index fields are direct children of SearchIndex. This file carries neither
a nested Private dictionary nor IsFreshIndex/LastModified keys in that entry.
The older synthetic test inferred those fields from Acrobat plug-in strings.

All three payloads use FlateDecode. PDXFile begins with `%PDX-3.2`, followed by
a small PDX object catalog. The other two streams contain the binary index.

| Key | Object | Raw bytes | Decoded bytes | SHA-256 of decoded payload |
|---|---|---|---|---|
| PDXFile | 10 | 291 | 399 | `93b8450819f1f938d5ae2ee51ad0027fc84334ebd6acf5cf3da84474c710c19f` |
| IndexFile | 9 | 182 | 4,848 | `a182242db12132add28fd910b7f50e8689cf877025551d67f40be829a20680e4` |
| Index1File | 8 | 8,534 | 23,654 | `c12cc2109a12e1e143da43eb510ed8f2a2fe7b9281f6b3f0aee35be190433dc4` |

qpdf reports two pre-existing warnings in the upstream file. The cross-reference
stream lacks its own xref entry, and object 26 has a page child with missing or
invalid Resources. The original bytes are retained. Document.Open reads the
file, and saving the sanitized document produces a document accepted by this
library's validator with its original page text retained. Default Sanitize
also flattens the fixture's form appearances, adding the button label to the
extracted text on its second page.

## Regression coverage

`test/sanitize-search-index-real.test.ts` checks the actual index dictionary and
payloads before sanitization, reports `searchIndex: true`, removes PieceInfo,
and verifies that Save drops all three original compressed index payloads.
The saved/reopened document retains the page text and reports no remaining
index. With `privateData: false`, the saved/reopened document retains every
decoded index stream and ModID.

## License

MIT License

Copyright (c) 2018-2020 Matthew J. Clemente

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
