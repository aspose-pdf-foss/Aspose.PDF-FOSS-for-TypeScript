import type { PsArray, PsDictionary, PsFontId } from './psvalue.js';
import type { Matrix } from './text.js';
import type { PsBox, PsPathData } from './psstate.js';
import type { StdFont } from './metrics.js';

export type PsVector = [number, number];
export interface PsProgramGlyph {
  name: string; advance: PsVector; sidebearing: PsVector;
  path: PsPathData; box: PsBox; unicode?: string;
}
export interface PsFontProgram {
  readonly names: readonly string[];
  readonly encoding?: readonly string[];
  glyph(name: string): PsProgramGlyph;
}
export interface PsFontDefinition {
  readonly dictionary: PsDictionary; readonly identity: PsFontId;
  readonly type: 0 | 1 | 3 | 42; readonly matrix: Matrix; readonly box: PsBox;
  readonly encoding: readonly (string | number)[];
  readonly paintType: 0 | 2; readonly strokeWidth: number;
  readonly standard?: StdFont; readonly program?: PsFontProgram;
  readonly builder?: { procedure: PsArray; byName: boolean };
  readonly composite?: { mapType: 2 | 3; escape: number; descendants: readonly PsDictionary[] };
}
export interface PsCharacter {
  font: PsFontDefinition; root: PsDictionary; code: number; matchCode?: number; name: string; matrix: Matrix;
}
