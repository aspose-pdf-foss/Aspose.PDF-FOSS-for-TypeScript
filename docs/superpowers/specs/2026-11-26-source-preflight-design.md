# Source preflight before recovery

An ingest pipeline can already open a PDF and inspect `doc.recovery`. It also needs to inspect the bytes as received. For example, Open can reconstruct a missing cross-reference table and return all pages. A caller archiving the input still needs to know that the table was missing.

## Approaches

The approved API is a standalone synchronous `Document.Preflight(bytes, { limits })`. The caller decides whether to pass the same bytes to `Document.Open` for a recovery comparison. Combining both operations would require running the recovery ladder and potentially supplying credentials just to obtain source findings. Attaching findings to an opened document would also make them unavailable when opening fails.

## Report

Return a `SourcePreflightReport` with a `findings` array in deterministic traversal order. A clean inspection returns an empty array. Each finding has a category (`malformed`, `unsupported`, or `limit`), a stage, and a descriptive message. Include the original file offset and object number when known. For a limit finding, include the limit name, allowed value, and reached value. A limit ends the inspection immediately. Unexpected programming errors propagate.

## Coverage

Inspect the PDF header, cross-reference chain and revision footers, trailer root, live indirect objects, stream boundaries and object-stream membership. Use the existing parser, configured limits and a shared decode budget. Respect incremental updates and free entries. Report the first failure in a prerequisite structure and continue with independent checks where their inputs are usable. Record source offsets only when they identify bytes in the original input.

Preflight performs no reconstruction, decryption, page rendering, or ordinary stream content decoding. Report unsupported coverage when encryption or an unsupported structural filter prevents inspection. Keep the caller's byte view intact, including on failure. A clean report describes the covered structural checks. PDF/A conformance and page-content validation belong to the existing document validation APIs.
