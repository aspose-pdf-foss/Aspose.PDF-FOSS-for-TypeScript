# Exact XMP packets and independent metadata clearing

`Document.GetXmpRaw()` returns a detached copy of the decoded catalog metadata stream, or `undefined` when absent. `SetXmpRaw(bytes)` copies the supplied bytes verbatim into an uncompressed XML metadata stream. An empty packet remains distinguishable from an absent packet. Neither operation needs an XML parser.

`ClearInfo()` and `ClearXmp()` unlink their respective metadata stores. The caller can reconcile shared fields with `SyncMetadata(direction)`. Typed setters keep their existing mirroring behavior and `ClearMetadata()` clears both stores.

Preserve page-level metadata when it shares an object with the catalog packet. Round trips through full and incremental saves must reflect the live catalog and trailer.
