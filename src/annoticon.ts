// The icon a viewer draws for a /Text (sticky note) or /FileAttachment
// annotation that carries no /AP (`v0tz.1`). A producer is entitled to leave
// that appearance to the viewer, and many do — so without this those
// annotations render blank in ToImage and ToSvg and vanish on flatten.
//
// A LEAF importing nothing: it turns a subtype, a /Name, a fill colour and a
// box into content-stream text, so every rule is testable from numbers with no
// document built. `annotappearance.ts` wraps the result in a stream.
//
// The artwork is OURS, drawn to be recognisable rather than to match any
// viewer's pixels; the standard names are only names (32000-1 12.5.6.4 and
// 12.5.6.15 list them and prescribe no drawing).

/** Fill colour as the annotation states it: 1, 3 or 4 components (gray, RGB,
 *  CMYK), `null` for an EMPTY /C — transparent, 12.5.2 — or `undefined` for
 *  no usable /C, which takes the subtype's default. */
export type IconFill = readonly number[] | null | undefined;

export type IconSubtype = 'Text' | 'FileAttachment';

/** Artwork in a 20x20 unit box, y up. `F` marks the paths that take the fill
 *  colour (closed, filled and outlined); `S` paths are outlined in black only;
 *  `W` paths are a wire drawn in the fill colour over a black casing, for an
 *  icon with no area to fill. */
interface Artwork { F?: string; S?: string; W?: string }

/** Bezier approximation of a circle, as a closed subpath. */
function circle(cx: number, cy: number, r: number): string {
  const k = r * 0.5523;
  return `${cx + r} ${cy} m ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c `
    + `${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c `
    + `${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c `
    + `${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c h `;
}

const TEXT_ICONS: Record<string, Artwork> = {
  Note: {
    F: '3 1 m 17 1 l 17 15 l 13 19 l 3 19 l h ',
    S: '13 19 m 13 15 l 17 15 l 6 12.5 m 14 12.5 l 6 9.5 m 14 9.5 l 6 6.5 m 14 6.5 l ',
  },
  Comment: {
    F: '2 7 m 2 17 l 18 17 l 18 7 l 9 7 l 5 3 l 6 7 l h ',
    S: '5 13.5 m 15 13.5 l 5 10.5 m 12 10.5 l ',
  },
  Key: {
    F: circle(6, 13, 4) + '9.3 10.3 m 17 2.6 l 18.4 4 l 10.7 11.7 l h ',
    S: circle(5.2, 13.8, 1.2) + '14.6 5 m 16.6 7 l 12.6 7 m 14.6 9 l ',
  },
  Help: {
    F: circle(10, 10, 8.5),
    S: '7 13 m 7 16.2 13 16.2 13 13 c 13 10.8 10 10.8 10 8 c ' + circle(10, 5, 0.8),
  },
  NewParagraph: {
    F: '10 18 m 17 8 l 3 8 l h ',
    S: '3 4 m 17 4 l 6 1.5 m 14 1.5 l ',
  },
  Paragraph: {
    F: '9 18 m 9 9 l 5 9 3 11.5 3 13.5 c 3 16 5 18 9 18 c h ',
    S: '9 18 m 16 18 l 12 18 m 12 2 l 15 18 m 15 2 l ',
  },
  Insert: {
    F: '3 3 m 10 17 l 17 3 l 14 3 l 10 11 l 6 3 l h ',
  },
};

const ATTACH_ICONS: Record<string, Artwork> = {
  PushPin: {
    F: '6 18 m 14 18 l 12.5 12 l 14.5 9 l 5.5 9 l 7.5 12 l h ',
    S: '10 9 m 10 1 l ',
  },
  Graph: {
    F: '4 2 3 7 re 9 2 3 12 re 14 2 3 9 re ',
    S: '2 18 m 2 2 l 18 2 l ',
  },
  Paperclip: {
    W: '8 5 m 8 15 l 8 18.5 13.5 18.5 13.5 15 c 13.5 3.5 l 13.5 0.5 10.5 0.5 10.5 3.5 c 10.5 14 l ',
  },
  Tag: {
    F: '2 10 m 8 17 l 18 17 l 18 3 l 8 3 l h ',
    S: circle(7, 10, 1.4),
  },
};

const DEFAULT_NAME: Record<IconSubtype, string> = { Text: 'Note', FileAttachment: 'PushPin' };
/** A note is yellow when it states no colour, as viewers draw it; an
 *  attachment icon has no conventional colour, so it is white. */
const DEFAULT_FILL: Record<IconSubtype, readonly number[]> = { Text: [1, 1, 0], FileAttachment: [1] };

/** The colour-setting operator for `c`, non-stroking (`stroke` false) or
 *  stroking; undefined for a component count no device space has. */
function colorOp(c: readonly number[], stroke: boolean): string | undefined {
  const n = c.map((v) => +v.toFixed(4)).join(' ');
  if (c.length === 1) return `${n} ${stroke ? 'G' : 'g'}`;
  if (c.length === 3) return `${n} ${stroke ? 'RG' : 'rg'}`;
  if (c.length === 4) return `${n} ${stroke ? 'K' : 'k'}`;
  return undefined;
}

/** Content-stream text drawing the icon for `subtype` / `iconName` squared and
 *  centred in a `w` x `h` box whose origin is (0, 0). An unknown or absent
 *  name draws the subtype's default icon, AS A VIEWER DOES — drawing nothing
 *  for a name we do not recognise would be the one outcome no viewer shows.
 *  Names match exactly, case included: `/note` is not `/Note`. */
export function iconBody(subtype: IconSubtype, iconName: string | undefined, fill: IconFill, w: number, h: number): string {
  const table = subtype === 'Text' ? TEXT_ICONS : ATTACH_ICONS;
  const art = (iconName !== undefined && Object.prototype.hasOwnProperty.call(table, iconName))
    ? table[iconName] : table[DEFAULT_NAME[subtype]];
  const side = Math.min(w, h);
  const s = side / 20;
  const dx = (w - side) / 2, dy = (h - side) / 2;
  // `null` is a stated EMPTY /C: transparent, so paths are outlined only.
  const color = fill === null ? undefined
    : (fill !== undefined && colorOp(fill, false) !== undefined ? fill : DEFAULT_FILL[subtype]);

  const parts = ['q', `${+s.toFixed(6)} 0 0 ${+s.toFixed(6)} ${+dx.toFixed(4)} ${+dy.toFixed(4)} cm`,
    '1 j 1 J 0 G 0.8 w'];
  if (art.F) {
    if (color) parts.push(colorOp(color, false)!, `${art.F}B`);
    else parts.push(`${art.F}S`);
  }
  if (art.S) parts.push(`${art.S}S`);
  if (art.W) {
    parts.push(`2.2 w ${art.W}S`);
    if (color) parts.push(`${colorOp(color, true)!} 1.2 w ${art.W}S`);
  }
  parts.push('Q');
  return parts.join('\n');
}
