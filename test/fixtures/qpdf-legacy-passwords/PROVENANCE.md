# qpdf legacy password fixtures

qpdf 12.3.2 encrypted a one-page PDF produced by
`test/helpers/build-pdf.ts` with the metadata title `Legacy password fixture`.
The files use distinct synthetic user and owner passwords and restrict copying
and modification. qpdf `--check` recognized each credential as its intended
role and reported clean syntax and stream encoding.

Create the input from the repository root with `node --import tsx --input-type=module`
and the following script.

```js
import { writeFileSync } from 'node:fs';
import { buildClassicPdf } from './test/helpers/build-pdf.ts';

writeFileSync('input.pdf', buildClassicPdf(1, { info: { Title: 'Legacy password fixture' } }));
```

Run qpdf with the matching options for each fixture.

```sh
qpdf --static-id --static-aes-iv --object-streams=disable --allow-weak-crypto \
  --encrypt --user-password=fixture-user --owner-password=fixture-owner \
  --bits=40 --print=n --extract=n --modify=n -- input.pdf r2-rc4.pdf

qpdf --static-id --static-aes-iv --object-streams=disable --allow-weak-crypto \
  --encrypt --user-password=fixture-user --owner-password=fixture-owner \
  --bits=128 --use-aes=n --print=low --modify=assembly --extract=n -- input.pdf r3-rc4.pdf

qpdf --static-id --static-aes-iv --object-streams=disable --password-mode=hex-bytes \
  --encrypt --user-password=666978747572652d757365722dcf80 --owner-password=666978747572652d6f776e65722df09f9492 \
  --bits=128 --use-aes=y --print=low --modify=assembly --extract=n --cleartext-metadata -- input.pdf r4-aes128.pdf
```

The hex passwords supply the exact UTF-8 bytes of `fixture-user-π` and
`fixture-owner-🔒` to the AES-128 fixture. Its `/EncryptMetadata false` flag
also exercises the metadata flag in legacy file-key derivation.

| Fixture | `/V` | `/R` | `/P` | Bytes | SHA-256 |
|---|---:|---:|---:|---:|---|
| `r2-rc4.pdf` | 1 | 2 | -32 | 1004 | `b81ed68fee97390f27f0badf683fac554df7e250d577acb9f23a76d7ffb90379` |
| `r3-rc4.pdf` | 2 | 3 | -2364 | 1007 | `0403b94998fb7496b3035ed286cfd3f7eb0c9bc64c92d4c329e75b9fccb1832e` |
| `r4-aes128.pdf` | 4 | 4 | -2364 | 1205 | `2e99ced6218b49b602b2ca51129f32ee80cf2fe19cd117155f2ecde5bef28d5d` |

`test/legacy-owner-password.test.ts` exercises both credentials, incorrect
and missing credentials, and the default encrypted-save round trip. The
fixtures are checked in so the tests can run independently of qpdf.
