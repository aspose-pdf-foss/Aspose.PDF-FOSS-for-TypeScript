// src/afdate.ts
/**
 * AForm date and time semantics (jzn8): util.printd and the STRICT half of
 * util._scand, transcribed from pdf.js `src/scripting_api/util.js` and
 * `src/shared/scripting_utils.js`, commit
 * d52fdf411a6e4d338180687456e0df019e28475e (Apache-2.0).
 *
 * **Stated divergence:** only strict matching. pdf.js falls back to
 * `#tryToGuessDate`, whose year defaults to the CURRENT year, and then to
 * `Date.parse`, which depends on the engine and the time zone. A value that
 * does not match its picture is left unformatted and rejected by the keystroke
 * check. Nothing here reads the machine's time zone: dates are fields,
 * normalised through `Date.UTC`, which is exactly pdf.js's local-time `Date`
 * under TZ=UTC (the goldens are generated under TZ=UTC), including its mapping
 * of years 0-99 onto the 1900s.
 */

export const DATE_FORMATS: readonly string[] = [
  'm/d', 'm/d/yy', 'mm/dd/yy', 'mm/yy', 'd-mmm', 'd-mmm-yy', 'dd-mmm-yy', 'yy-mm-dd',
  'mmm-yy', 'mmmm-yy', 'mmm d, yyyy', 'mmmm d, yyyy', 'm/d/yy h:MM tt', 'm/d/yy HH:MM',
];
export const TIME_FORMATS: readonly string[] = ['HH:MM', 'h:MM tt', 'HH:MM:ss', 'h:MM:ss tt'];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface DateParts {
  year: number; month: number; day: number;
  hours: number; minutes: number; seconds: number; dayOfWeek: number;
}

function normalize(y: number, mo: number, d: number, h: number, mi: number, s: number): DateParts {
  const t = new Date(Date.UTC(y, mo, d, h, mi, s));
  return {
    year: t.getUTCFullYear(), month: t.getUTCMonth(), day: t.getUTCDate(),
    hours: t.getUTCHours(), minutes: t.getUTCMinutes(), seconds: t.getUTCSeconds(),
    dayOfWeek: t.getUTCDay(),
  };
}

const PRINT = /(mmmm|mmm|mm|m|dddd|ddd|dd|d|yyyy|yy|HH|H|hh|h|MM|M|ss|s|tt|t|\\.)/g;
const PRINTERS: Record<string, (d: DateParts) => string> = {
  mmmm: (d) => MONTHS[d.month],
  mmm: (d) => MONTHS[d.month].substring(0, 3),
  mm: (d) => (d.month + 1).toString().padStart(2, '0'),
  m: (d) => (d.month + 1).toString(),
  dddd: (d) => DAYS[d.dayOfWeek],
  ddd: (d) => DAYS[d.dayOfWeek].substring(0, 3),
  dd: (d) => d.day.toString().padStart(2, '0'),
  d: (d) => d.day.toString(),
  yyyy: (d) => d.year.toString().padStart(4, '0'),
  yy: (d) => (d.year % 100).toString().padStart(2, '0'),
  HH: (d) => d.hours.toString().padStart(2, '0'),
  H: (d) => d.hours.toString(),
  hh: (d) => (1 + ((d.hours + 11) % 12)).toString().padStart(2, '0'),
  h: (d) => (1 + ((d.hours + 11) % 12)).toString(),
  MM: (d) => d.minutes.toString().padStart(2, '0'),
  M: (d) => d.minutes.toString(),
  ss: (d) => d.seconds.toString().padStart(2, '0'),
  s: (d) => d.seconds.toString(),
  tt: (d) => (d.hours < 12 ? 'am' : 'pm'),
  t: (d) => (d.hours < 12 ? 'a' : 'p'),
};

/** util.printd with a picture string. `\x` prints `x` literally. */
export function printd(fmt: string, d: DateParts): string {
  return fmt.replace(PRINT, (tok: string) =>
    (Object.hasOwn(PRINTERS, tok) ? PRINTERS[tok](d) : tok.charAt(1)));
}

interface Scanned {
  year: number; month: number; day: number;
  hours: number; minutes: number; seconds: number; am: boolean | null;
}
type Scanner = { pattern: string; action: (v: string, d: Scanned) => void };
const int = (v: string): number => parseInt(v, 10);
const SCAN = /(mmmm|mmm|mm|m|dddd|ddd|dd|d|yyyy|yy|HH|H|hh|h|MM|M|ss|s|tt|t)/g;
const SCANNERS: Record<string, Scanner> = {
  mmmm: { pattern: `(${MONTHS.join('|')})`, action: (v, d) => { d.month = MONTHS.indexOf(v); } },
  mmm: {
    pattern: `(${MONTHS.map((m) => m.substring(0, 3)).join('|')})`,
    action: (v, d) => { d.month = MONTHS.findIndex((m) => m.substring(0, 3) === v); },
  },
  mm: { pattern: '(\\d{2})', action: (v, d) => { d.month = int(v) - 1; } },
  m: { pattern: '(\\d{1,2})', action: (v, d) => { d.month = int(v) - 1; } },
  // pdf.js assigns the WEEKDAY index to `day` here; transcribed as found.
  dddd: { pattern: `(${DAYS.join('|')})`, action: (v, d) => { d.day = DAYS.indexOf(v); } },
  ddd: {
    pattern: `(${DAYS.map((x) => x.substring(0, 3)).join('|')})`,
    action: (v, d) => { d.day = DAYS.findIndex((x) => x.substring(0, 3) === v); },
  },
  dd: { pattern: '(\\d{2})', action: (v, d) => { d.day = int(v); } },
  d: { pattern: '(\\d{1,2})', action: (v, d) => { d.day = int(v); } },
  yyyy: { pattern: '(\\d{4})', action: (v, d) => { d.year = int(v); } },
  yy: { pattern: '(\\d{2})', action: (v, d) => { d.year = 2000 + int(v); } },
  HH: { pattern: '(\\d{2})', action: (v, d) => { d.hours = int(v); } },
  H: { pattern: '(\\d{1,2})', action: (v, d) => { d.hours = int(v); } },
  hh: { pattern: '(\\d{2})', action: (v, d) => { d.hours = int(v); } },
  h: { pattern: '(\\d{1,2})', action: (v, d) => { d.hours = int(v); } },
  MM: { pattern: '(\\d{2})', action: (v, d) => { d.minutes = int(v); } },
  M: { pattern: '(\\d{1,2})', action: (v, d) => { d.minutes = int(v); } },
  ss: { pattern: '(\\d{2})', action: (v, d) => { d.seconds = int(v); } },
  s: { pattern: '(\\d{1,2})', action: (v, d) => { d.seconds = int(v); } },
  tt: { pattern: '([aApP][mM])', action: (v, d) => { const c = v.charAt(0); d.am = c === 'a' || c === 'A'; } },
  t: { pattern: '([aApP])', action: (v, d) => { d.am = v === 'a' || v === 'A'; } },
};

/** The strict half of util._scand: the whole value must match the picture. */
export function scandStrict(fmt: string, value: string): DateParts | null {
  const actions: Scanner['action'][] = [];
  const escaped = fmt.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&');
  const re = escaped.replace(SCAN, (tok: string) => {
    const h = SCANNERS[tok];
    actions.push(h.action);
    // pdf.js's own rule, transcribed: a variable-width token is matched through
    // a lookahead and a backreference, which makes it POSSESSIVE. `HMM` then
    // refuses `930` (H takes 93 and gives nothing back) exactly as pdf.js does,
    // and a document-supplied picture of many `\d{1,2}` tokens cannot backtrack
    // exponentially — measured, `'Hs'.repeat(16)` against 48 digits did not
    // finish in two minutes without it.
    return h.pattern.includes(',') ? `(?=${h.pattern})\\${actions.length}` : h.pattern;
  });
  const m = new RegExp(`^${re}$`).exec(value);
  if (m === null || m.length !== actions.length + 1) return null;
  const d: Scanned = { year: 2000, month: 0, day: 1, hours: 0, minutes: 0, seconds: 0, am: null };
  actions.forEach((a, i) => a(m[i + 1], d));
  if (d.am !== null) d.hours = (d.hours % 12) + (d.am ? 0 : 12);
  return normalize(d.year, d.month, d.day, d.hours, d.minutes, d.seconds);
}

/** AFDate_FormatEx / AFTime_FormatEx. An empty or non-matching value is left as is. */
export function dateFormat(value: string, fmt: string): string {
  if (!value) return value;
  const p = scandStrict(fmt, value);
  return p === null ? value : printd(fmt, p);
}

/** AFDate_KeystrokeEx / AFTime_KeystrokeEx at commit time. */
export function dateKeystroke(value: string, fmt: string): boolean {
  if (!value) return true;
  return scandStrict(fmt, value) !== null;
}
