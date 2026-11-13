# External JPEG Reference Fixtures Implementation Plan

Execution: inline in this session; task status is tracked by Beads `ka3t`.

**Goal:** replace the former lossless/hierarchical coverage reminders with executable checks against independently encoded and decoded JPEG streams.

**Spec:** `bd show aspose-pdf-foss-for-ts-ka3t`; the existing lossless and hierarchical design specs describe the supported decoder paths.

**Architecture:** compile Thomas Richter's JPEG codec at commit `c719010a26ce0c666e98b2acf924ad5fc24b4f5d` in temporary storage. Commit only authored source samples, its encoded streams and reference decodes, a reproducible generator, and provenance. Vitest reads frozen artifacts and never invokes the external tool. Keep existing synthetic tests.

**Tech stack:** the installed MSVC toolchain for one-time codec generation; Node built-ins, TypeScript and Vitest for repository work. No dependency changes.

## Global Constraints

- Lossless SOF3 comparisons are exact against the known encoder input, also checked against the external decode.
- Hierarchical streams must contain real DHP, EXP and differential frames. Reference pixels come from the external decoder, not the in-repo JPEG builders or upsampler.
- Include source, tool commit/version, build and generation commands, hashes, and licensing information.
- Tests remain hermetic. Do not add skipped placeholders or distribute external codec software in the npm package.
- Verify both quality gates on the branch and on `main`, push code, and sync Beads before reporting completion.

## Review Focus

Exercise nonconstant samples with edges and distinct RGB channels, both expansion axes, nonzero residuals, image edges and odd dimensions, and the difference between lossless source samples and lossy reference decodes. Mutations must demonstrate that an altered EXP filter and omitted residual addition fail the external assertions.

## Implementation

1. Add a one-time generator under `scripts/` that accepts a path to the pinned external codec, writes deterministic 8-bit gray/RGB PNM sources, invokes SOF3 and hierarchical modes, and saves the external reference decodes under `test/fixtures/jpeg/`. Record marker geometry and hashes. Prefer small nonconstant images with odd dimensions; retain separate padded geometry when needed to isolate a defect.
2. Add executable fixture assertions in `test/jpeg-real.test.ts`, using `readPnm` for the known inputs and external goldens. Check the expected dimensions/components and SOF/DHP/EXP modes so a fixture cannot silently become baseline. Compare SOF3 samples exactly; derive any hierarchical IDCT tolerance from measured independent differences, not the source image's lossy error. If the new oracle exposes a decoder defect, reproduce it with a failing test, record it in Beads, and fix the affected path before completion.
3. Run targeted tests and mutation checks for EXP interpolation and residual composition. Restore production code after each mutation and rerun the affected tests. Extend `test/fixtures/jpeg/PROVENANCE.md` with full generation, license, hashes, measurements and limits; update the fixture inventory in `CLAUDE.md`. Add a changelog entry only if decoder behavior changes.
4. Run `npm run typecheck` and `npm test`, review and commit the deliverable, merge to `main`, repeat both gates, close the completed issue, commit its audit entry, push `main`, remove the merged branch and run `bd dolt push`.
