# Identified text edits

Callers select the existing fragment or paragraph read result. A fragment can replace its text, change its style, or move by a delta in PDF page points. A paragraph can align its lines within the original bounds. Methods edit the document immediately. The enumerable fields continue to describe the original read.

Bind a handle to the page, source streams, Form drawing and encoded glyph ranges. Verify that identity before writing. A stale handle raises `RangeError`. A target composed of incompatible pieces raises `UnsupportedFeatureError`. A refusal must leave saved bytes and live document resources intact.

Preserve text state outside the edit, including the pen position of the next show and the origin used by subsequent relative lines. Paragraph alignment retains line breaks and existing glyph bytes. Joined paragraphs have multiple source rectangles and cannot be aligned as one.
