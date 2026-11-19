import type { Page } from './page.js';
import { PageFormat } from './pageformat.js';
import { LoadLimits } from './loadlimits.js';
import { PsInterpreter } from './psvm.js';
import { installPsGraphics, type PsGraphicsOptions } from './psgraphics.js';
import { installPsText } from './pstext.js';
import { framePostScript } from './eps.js';
import { readEpsBox } from './epsdsc.js';
import type { PsPageOutput } from './pspdf.js';
import type { PsBudget } from './psbudget.js';
import { PsFault } from './psvalue.js';
import { PdfParseError, rethrowLimit } from './errors.js';

/** Explicit job-local font program; no ambient font lookup is performed. */
export interface PostScriptFont { name: string; bytes: Uint8Array }
export interface PostScriptOptions {
  format?: 'auto' | 'ps' | 'eps';
  /** Initial plain-PS device size; incompatible with EPS. */
  pageSize?: PageFormat;
  fonts?: readonly PostScriptFont[];
}
export interface PostScriptResult { pages: Page[] }

/** Execute and finalize a detached job. Publication belongs to Document. */
export function runPostScriptImport(bytes: Uint8Array, options: PostScriptOptions,
  limits: LoadLimits): { pages: readonly PsPageOutput[]; budget: PsBudget } {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('PostScript input must be a Uint8Array');
  if (!(limits instanceof LoadLimits)) throw new TypeError('PostScript loadLimits must be a LoadLimits');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('PostScript options must be an object');
  const format = options.format === undefined ? 'auto' : options.format;
  if (!['auto', 'ps', 'eps'].includes(format)) throw new TypeError('Invalid PostScript format');
  const pageSize = options.pageSize;
  if (pageSize !== undefined && (!(pageSize instanceof PageFormat)
    || !Number.isFinite(pageSize.width) || !Number.isFinite(pageSize.height) || pageSize.width <= 0 || pageSize.height <= 0))
    throw new TypeError('PostScript pageSize must be a positive finite PageFormat');
  limits.enforce('maxFileBytes', bytes.length, 'PostScript input');
  const vm = new PsInterpreter({ limits }), budget = vm.budget;
  const fonts = options.fonts;
  if (fonts !== undefined) {
    if (!Array.isArray(fonts)) throw new TypeError('PostScript fonts must be an array');
    budget.items(fonts.length, 'supplied font registrations');
    budget.allocate(64, 'supplied font registrations');
    const names = new Set<string>();
    for (const font of fonts) {
      if (!font || typeof font.name !== 'string' || !(font.bytes instanceof Uint8Array))
        throw new TypeError('PostScript fonts require nonempty names and Uint8Array bytes');
      limits.enforce('maxObjectBytes', font.name.length, 'supplied font name');
      budget.work(font.name.length + 1, 'supplied font name');
      budget.allocate(64 + font.name.length * 2, 'supplied font name');
      if (!font.name.trim()) throw new TypeError('PostScript fonts require nonempty names');
      if (names.has(font.name)) throw new TypeError('Duplicate PostScript font name');
      names.add(font.name);
    }
  }
  const frame = framePostScript(bytes, format, budget);
  let device: PsGraphicsOptions = {};
  if (frame.kind === 'eps') {
    if (pageSize !== undefined) throw new TypeError('PostScript pageSize is incompatible with EPS');
    const [x0, y0, x1, y1] = readEpsBox(frame.source, budget);
    device = { eps: true, box: [0, 0, x1 - x0, y1 - y0], defaultMatrix: [1, 0, 0, 1, -x0, -y0] };
  } else if (pageSize) device = { box: [0, 0, pageSize.width, pageSize.height] };
  const graphics = installPsGraphics(vm, device);
  try { installPsText(vm, graphics, { fonts }); }
  catch (caught) {
    rethrowLimit(caught);
    if (caught instanceof PsFault) throw new PdfParseError(`PostScript ${caught.errorName}`);
    throw caught;
  }
  vm.run(frame.source);
  return { pages: graphics.finish(), budget };
}
