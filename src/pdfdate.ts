/** PDF dates (32000-1 7.9.4, `D:YYYYMMDDHHmmSSOHH'mm'`) and XMP dates (the
 *  W3C-DTF profile of ISO 8601) converted TEXT TO TEXT (`o6uu.4`).
 *
 *  A leaf importing nothing. The conversion never passes through a JS `Date`,
 *  which keeps an instant but loses the offset it was written in — so
 *  `D:20240603123045+02'00'` and `2024-06-03T12:30:45+02:00` convert into
 *  each other exactly, precision and offset intact. Nothing here throws: a
 *  string that does not read is `undefined`. */

interface DateParts {
  y: string; mo?: string; d?: string; h?: string; mi?: string; s?: string;
  /** ISO fractional seconds including the dot; PDF dates cannot carry one. */
  frac?: string;
  tz?: { z: true } | { z: false; sign: '+' | '-'; h: string; m: string };
}

// The D: prefix is required by PDF 2.0 and optional in 1.x, so it is optional
// here. The offset is `+HH'mm'`, `+HH'mm` (PDF 2.0), `+HH'` or `+HH`; older
// producers write `Z00'00'`, and some write `+HHmm` with no apostrophes,
// which `metadata.ts`'s `parsePdfDate` has always read (`o6uu.9`).
const PDF_RE = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)(?:00'?00'?)?|([+-])(\d{2})(?:'(\d{2})?'?|(\d{2})'?)?)?$/;
const ISO_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/;

const within = (v: string | undefined, lo: number, hi: number) => v === undefined || (+v >= lo && +v <= hi);

/** Days in a month of the proleptic Gregorian calendar, which both grammars
 *  use (`o6uu.9`). Checking the day against 31 alone let `D:20240231` convert
 *  to a date that does not exist, and `isoInstant` then rolled it into March. */
function daysIn(y: string, mo: string | undefined): number {
  if (mo === undefined) return 31;
  const m = +mo;
  if (m === 2) { const yr = +y; return (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0 ? 29 : 28; }
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function valid(p: DateParts): DateParts | undefined {
  if (!within(p.mo, 1, 12) || !within(p.d, 1, daysIn(p.y, p.mo)) || !within(p.h, 0, 23)
    || !within(p.mi, 0, 59) || !within(p.s, 0, 59)) return undefined;
  if (p.tz && !p.tz.z && (!within(p.tz.h, 0, 23) || !within(p.tz.m, 0, 59))) return undefined;
  // A zone designator means nothing without a time of day, in either grammar.
  if (p.tz && p.h === undefined) return undefined;
  return p;
}

function parsePdf(s: string): DateParts | undefined {
  const m = PDF_RE.exec(s.trim());
  if (!m) return undefined;
  const tz: DateParts['tz'] = m[7] ? { z: true }
    : m[8] ? { z: false, sign: m[8] as '+' | '-', h: m[9], m: m[10] ?? m[11] ?? '00' } : undefined;
  return valid({ y: m[1], mo: m[2], d: m[3], h: m[4], mi: m[5], s: m[6], tz });
}

function parseIso(s: string): DateParts | undefined {
  const m = ISO_RE.exec(s.trim());
  if (!m) return undefined;
  const tz: DateParts['tz'] = m[8] === undefined ? undefined : m[8] === 'Z' ? { z: true }
    : { z: false, sign: m[8][0] as '+' | '-', h: m[8].slice(1, 3), m: m[8].slice(4, 6) };
  return valid({ y: m[1], mo: m[2], d: m[3], h: m[4], mi: m[5], s: m[6], frac: m[7], tz });
}

/** `D:` text to ISO 8601 text, or `undefined`. A `D:` date stating an hour
 *  and no minutes gains `:00`, since ISO requires minutes with an hour. */
export function pdfDateToIso(s: string): string | undefined {
  const p = parsePdf(s);
  if (!p) return undefined;
  let out = p.y;
  if (p.mo) out += `-${p.mo}`;
  if (p.d) out += `-${p.d}`;
  if (p.h) {
    out += `T${p.h}:${p.mi ?? '00'}`;
    if (p.s) out += `:${p.s}`;
    if (p.tz) out += p.tz.z ? 'Z' : `${p.tz.sign}${p.tz.h}:${p.tz.m}`;
  }
  return out;
}

/** ISO 8601 text to `D:` text, or `undefined`. Fractional seconds are dropped
 *  — a PDF date has no field for them. The offset is written `+HH'mm'`, the
 *  spelling `formatPdfDate` already uses. */
export function isoToPdfDate(s: string): string | undefined {
  const p = parseIso(s);
  if (!p) return undefined;
  let out = `D:${p.y}${p.mo ?? ''}${p.d ?? ''}${p.h ?? ''}${p.mi ?? ''}${p.s ?? ''}`;
  if (p.tz) out += p.tz.z ? 'Z' : `${p.tz.sign}${p.tz.h}'${p.tz.m}'`;
  return out;
}

/** Epoch milliseconds of an ISO date, or `undefined`. A time with no zone
 *  designator is read as UTC — both sides of a comparison get the same
 *  reading, and XMP gives no other. */
export function isoInstant(s: string): number | undefined {
  const p = parseIso(s);
  if (!p) return undefined;
  const d = new Date(Date.UTC(2000, +(p.mo ?? '1') - 1, +(p.d ?? '1'), +(p.h ?? '0'), +(p.mi ?? '0'), +(p.s ?? '0')));
  d.setUTCFullYear(+p.y); // Date.UTC maps years 0-99 onto the 1900s
  let ms = d.getTime() + (p.frac ? Math.floor(Number(`0${p.frac}`) * 1000) : 0);
  if (p.tz && !p.tz.z) ms -= (p.tz.sign === '-' ? -1 : 1) * (+p.tz.h * 60 + +p.tz.m) * 60000;
  return ms;
}

/** Do two ISO dates name the same instant, to the second? Seconds, because a
 *  `D:` date can hold nothing finer — a `.000Z` and a `+00:00` spelling of one
 *  moment must compare equal or every sync of our own output rewrites it. */
export function sameInstant(a: string, b: string): boolean {
  const x = isoInstant(a), y = isoInstant(b);
  return x !== undefined && y !== undefined && Math.floor(x / 1000) === Math.floor(y / 1000);
}
