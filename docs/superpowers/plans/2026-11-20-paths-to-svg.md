# Export Selected Page Paths to SVG Implementation Plan

The [design](../specs/2026-11-20-paths-to-svg-design.md) defines `s2i2.3`.
Track work in Beads.

1. Add failing public API tests for selected compound paths, rotated and
   cropped coordinates, repeated Form draws, and empty output.
2. Add `PathsToSvg` to `src/page.ts`. Serialize only the supplied snapshot
   geometry and paint through the existing SVG writer in `src/svgrender.ts`.
3. Document the API and its snapshot semantics. Run the focused and full
   gates, review the change, integrate, and sync Git and Beads.
