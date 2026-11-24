# Asynchronous PubSec recipient keys

`Document.OpenAsync(bytes, options)` accepts `recipient.certificate` and
`recipient.keyTransportAsync` for a provider that returns a promise. The provider
uses the same RSAES-PKCS1-v1_5 capability and AES content key sizes as the
synchronous transport. `OpenAsync` accepts existing credentials too.

The loader yields only at PubSec authentication. Both entry points share the
cross-reference and recovery paths and their decode budget. A separate async
parser would duplicate the recovery policy. Caching an unwrapped key for later
operations would avoid provider calls but would also bypass the provider's
ability to refuse authorization when a revision is read. Reopens therefore use
the retained provider and certificate under the original load limits.

The async entry point owns the input bytes across the provider call. CMS first
matches the recipient and validates transport and content parameters. The
provider receives a copy of the wrapped key. Invalid returned keys and provider
failures use the same credential error. Resource-limit errors propagate.

Incremental saves with an async credential use `SaveAsync`. Authentication
precedes graph changes. Signing, timestamps, and validation-data appends await
the stored base. Verification awaits each revision needed for structure,
unsigned-content attribution, appearance comparison, and document or field
locks. If an earlier revision cannot be authenticated, its structural evidence
is unavailable while the current revision's cryptographic verdicts remain usable.

Tests use Go-produced AES-128 and AES-256 files. They cover issuer and serial
matching, detached callback inputs, failed unwraps, encrypted incremental updates,
signed and historical revisions, and load limits before provider invocation.
