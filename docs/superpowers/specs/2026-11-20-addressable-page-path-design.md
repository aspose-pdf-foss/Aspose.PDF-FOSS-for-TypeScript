# Addressable PagePath

`Page.GetPaths()` supplies a read-only `PagePath.Addr` for identifying an
individual path on the live page (`s2i2.1`). The existing `addr` continues to
identify its paint or end operator.

The address contains inclusive `start` and `end` operator coordinates. These
can reference different page content streams. For paths inside forms it also
records each enclosing `Do` coordinate, from the page inward. Two draws of the
same form share the source span and have distinct invocation coordinates.

The extraction walk already has the source positions and the current path
state. Capture the first `m` or `re` alongside that state. Reconstructing
positions from the returned geometry would lose `h`, clipping, and the source
positions of normalized segments. Looking backward from the paint operator
would also miss paths built across streams.

Keep provenance privately with each extracted path. Verification checks page
ownership, resolved stream identity, and decoded bytes before an editor can
invoke copy-on-write. Ownership follows the live page dictionary when the
document rebuilds its page wrappers and ends when the page is removed. Use
weak references so retained paths do not retain their documents. A replaced
stream invalidates the handle even if an identical operation now occupies the
same position. Verification follows the
same resource inheritance as extraction and raises `RangeError` for a stale or
foreign handle. Callers can enumerate again after a content edit.

Removal, recoloring, transformation, and SVG export are tracked in the two
dependent issues.
