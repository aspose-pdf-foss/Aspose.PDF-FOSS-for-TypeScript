# Complete StandardEncoding High-Range Table — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `standardEncoding`'s `0xB0..0xFF` entries in `src/encoding.ts` from Adobe StandardEncoding (ISO 32000-1 Annex D Table D.2, STD column), removing the `TODO(transcribe)`, and pin the values with tests.

**Architecture:** Single self-contained edit to the `over` code→Unicode map inside the `standardEncoding` IIFE; undefined StandardEncoding slots omitted. TDD with pinning tests.

**Tech Stack:** TypeScript (ESM, strict), vitest.

**Spec:** `docs/superpowers/specs/2026-06-16-standardencoding-completion-design.md`

---

## File Structure

| File | Change |
|------|--------|
| `test/encoding.test.ts` | Extend the StandardEncoding test with pins for new values + an undefined-slot assertion. |
| `src/encoding.ts` | Add `0xB0..0xFF` defined entries to `standardEncoding`'s `over` map; drop the TODO + "(transcribe below)" note. |

---

## Task 1: Complete StandardEncoding high range

**Files:**
- Modify: `test/encoding.test.ts`
- Modify: `src/encoding.ts`

- [ ] **Step 1: Extend the failing test**

In `test/encoding.test.ts`, replace the existing `StandardEncoding` test case with
this expanded version (adds high-range pins + an undefined-slot check):

```typescript
  it('StandardEncoding: ASCII-ish with typographic quotes', () => {
    expect(standardEncoding[0x41]).toBe('A');
    expect(standardEncoding[0x27]).toBe('’'); // quoteright
    expect(standardEncoding[0x60]).toBe('‘'); // quoteleft
    // high range (Annex D Table D.2 STD column)
    expect(standardEncoding[0xb7]).toBe('•'); // bullet
    expect(standardEncoding[0xd0]).toBe('—'); // emdash
    expect(standardEncoding[0xe1]).toBe('Æ'); // AE
    expect(standardEncoding[0xe9]).toBe('Ø'); // Oslash
    expect(standardEncoding[0xfb]).toBe('ß'); // germandbls
    expect(standardEncoding[0xb0]).toBeUndefined(); // undefined slot stays undefined
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/encoding.test.ts`
Expected: FAIL — `standardEncoding[0xb7]` (and the other high-range pins) are
`undefined` because `0xB0..0xFF` are not populated yet.

- [ ] **Step 3: Populate the `over` map in `src/encoding.ts`**

In `src/encoding.ts`, inside the `standardEncoding` IIFE, replace this block:

```typescript
  // High range (0xA1..0xFF) from Annex D Table D.2 STD column. Seed entries:
  const over: Record<number, number> = {
    0xa1:0xa1, 0xa2:0xa2, 0xa3:0xa3, 0xa4:0x2044, 0xa5:0xa5, 0xa6:0x192,
    0xa7:0xa7, 0xa8:0xa4, 0xa9:0x27, 0xaa:0x201c, 0xab:0xab, 0xac:0x2039,
    0xad:0x203a, 0xae:0xfb01, 0xaf:0xfb02,
    // TODO(transcribe): remaining STD entries 0xB0..0xFF from Annex D Table D.2.
  };
```

with the completed map (defined StandardEncoding slots only — `0xB0`, `0xB5`,
`0xBE`, `0xC0`, `0xC9`, `0xCC`, `0xD1`–`0xE0`, `0xE2`, `0xE4`–`0xE7`, `0xEC`–`0xF0`,
`0xF2`–`0xF4`, `0xF6`, `0xF7`, `0xFC`–`0xFF` are intentionally omitted and remain
`undefined`):

```typescript
  // High range (0xA1..0xFF) from Annex D Table D.2 STD column.
  const over: Record<number, number> = {
    0xa1:0xa1, 0xa2:0xa2, 0xa3:0xa3, 0xa4:0x2044, 0xa5:0xa5, 0xa6:0x192,
    0xa7:0xa7, 0xa8:0xa4, 0xa9:0x27, 0xaa:0x201c, 0xab:0xab, 0xac:0x2039,
    0xad:0x203a, 0xae:0xfb01, 0xaf:0xfb02,
    0xb1:0x2013, 0xb2:0x2020, 0xb3:0x2021, 0xb4:0xb7, 0xb6:0xb6, 0xb7:0x2022,
    0xb8:0x201a, 0xb9:0x201e, 0xba:0x201d, 0xbb:0xbb, 0xbc:0x2026, 0xbd:0x2030,
    0xbf:0xbf, 0xc1:0x60, 0xc2:0xb4, 0xc3:0x2c6, 0xc4:0x2dc, 0xc5:0xaf,
    0xc6:0x2d8, 0xc7:0x2d9, 0xc8:0xa8, 0xca:0x2da, 0xcb:0xb8, 0xcd:0x2dd,
    0xce:0x2db, 0xcf:0x2c7, 0xd0:0x2014, 0xe1:0xc6, 0xe3:0xaa, 0xe8:0x141,
    0xe9:0xd8, 0xea:0x152, 0xeb:0xba, 0xf1:0xe6, 0xf5:0x131, 0xf8:0x142,
    0xf9:0xf8, 0xfa:0x153, 0xfb:0xdf,
  };
```

Also update the `standardEncoding` doc comment two lines above the IIFE — change:

```typescript
/** StandardEncoding (Adobe): ASCII letters/digits, typographic quotes at 0x27/0x60,
 *  high range per ISO 32000-1 Annex D Table D.2 "STD" column (transcribe below). */
```

to:

```typescript
/** StandardEncoding (Adobe): ASCII letters/digits, typographic quotes at 0x27/0x60,
 *  high range per ISO 32000-1 Annex D Table D.2 "STD" column. */
```

- [ ] **Step 4: Run to verify the test passes**

Run: `npx vitest run test/encoding.test.ts`
Expected: PASS.

- [ ] **Step 5: Full typecheck + suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass (no other path touches `standardEncoding`).

- [ ] **Step 6: Commit**

```bash
git add src/encoding.ts test/encoding.test.ts
git commit -m "feat: complete StandardEncoding 0xB0..0xFF table (4m2)"
```

- [ ] **Step 7: Close the issue**

Run:
```bash
bd close aspose-pdf-foss-for-ts-4m2
```

---

## Self-Review Notes

- **Spec coverage:** all defined `0xB0..0xFF` STD entries from the spec data table
  are present in the `over` map (Step 3); undefined slots omitted; TODO + doc-comment
  note removed; pinning tests cover emdash/AE/Oslash/germandbls/bullet + an
  undefined-slot assertion (Step 1) — matching the spec's test list.
- **Placeholder scan:** none.
- **Value spot-check (map vs spec table):** 0xB4→00B7 (periodcentered), 0xC1→0060
  (grave), 0xC8→00A8 (dieresis), 0xE8→0141 (Lslash), 0xFB→00DF (germandbls) — all
  consistent with the design spec data table.
