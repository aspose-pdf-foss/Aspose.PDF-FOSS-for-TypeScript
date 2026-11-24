# OpenSSL RSAES-OAEP recipient envelopes

OpenSSL 3.5.9 generated both DER files with `cms -encrypt -binary -outform DER`
using `-aes-128-cbc` and the synthetic `recipient-cert.pem` from `../pubsec-go`.
The input is 24 bytes with successive values from 1 through 24. The key
options are `rsa_padding_mode:oaep`, `rsa_oaep_md:<digest>`, and
`rsa_mgf1_md:<digest>`, with the digest indicated by each filename. The label
uses the empty default. OpenSSL `cms -decrypt` with the matching test key
reproduced all 24 bytes for each file.

| Fixture | SHA-256 |
| --- | --- |
| `sha1.der` | `d9bb0b394670e724eadf89ef493116c42e0e7ed4cc55a4df6e50a86abf5f916b` |
| `sha256.der` | `85012f0821b612c7956877d24f8ee8ff4a5336369bc422a2e9df67e1ee565f2a` |

[RSAES-OAEP parameters in RFC 3560 §3](https://www.rfc-editor.org/rfc/rfc3560.html#section-3)
