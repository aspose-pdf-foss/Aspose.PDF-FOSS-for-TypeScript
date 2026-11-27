import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fsyncSync, lstatSync, openSync,
  readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats,
} from 'node:fs';
import { link, lstat, open, readlink, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, sep } from 'node:path';
import { rethrowLimit } from './errors.js';

// Path operations below use strings. Fail before staging if a filesystem
// name cannot be represented, rather than replacing a different filename.
const pathDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function fileParts(path: string) {
  if (!path) throw Object.assign(new Error('Empty output path'), { code: 'ENOENT' });
  const parts = parse(path);
  if (!parts.base || parts.base === '.' || parts.base === '..' || (process.platform !== 'win32' && path.endsWith('/')))
    throw Object.assign(new Error(`Expected a file path: ${path}`), { code: 'EISDIR' });
  return parts;
}

function visitLink(target: string, visited: Set<string>): void {
  if (visited.has(target) || visited.size >= 40)
    throw Object.assign(new Error(`Too many symbolic links: ${target}`), { code: 'ELOOP' });
  visited.add(target);
}

function linkTarget(parent: string, bytes: Buffer): string {
  const name = pathDecoder.decode(bytes);
  // Resolve ".." only after the filesystem resolves any preceding links.
  return isAbsolute(name) ? name : parent + sep + name;
}

function requireRegularFile(target: string, stat: Stats): void {
  if (!stat.isFile())
    throw Object.assign(new Error(`Expected a regular output file: ${target}`),
      { code: stat.isDirectory() ? 'EISDIR' : 'EINVAL' });
}

function siblingPath(target: string): string {
  return join(dirname(target), '.pdf-' + randomUUID() + '.tmp');
}

// Resolve the parent even when the final component (including a link target)
// does not exist yet. rename() on a symlink itself would destroy the link.
function outputTarget(path: string) {
  const visited = new Set<string>();
  for (;;) {
    const { dir, base } = fileParts(path);
    const parent = pathDecoder.decode(realpathSync.native(dir || '.', { encoding: 'buffer' }));
    const target = join(parent, base);
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (!stat?.isSymbolicLink()) return { target, stat };
    visitLink(target, visited);
    path = linkTarget(parent, readlinkSync(target, { encoding: 'buffer' }));
  }
}

/** Publish a complete file with one rename on the destination filesystem. */
export function writeFileAtomically(path: string, bytes: Uint8Array): void {
  const { target, stat } = outputTarget(path);
  if (stat) {
    requireRegularFile(target, stat);
    // Rename checks the parent directory. Keep the old writer's access check
    // on the file too, including Windows read-only attributes and ACLs.
    closeSync(openSync(target, constants.O_WRONLY | constants.O_NONBLOCK));
  }
  const stage = siblingPath(target);
  const fd = openSync(stage, 'wx', stat ? 0o600 : 0o666);
  let published = false;
  try {
    try {
      writeFileSync(fd, bytes);
      if (stat && process.platform !== 'win32') fchmodSync(fd, stat.mode & 0o777);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(stage, target);
    published = true;
  } finally {
    if (!published) unlinkSync(stage);
  }
}

async function outputTargetAsync(path: string, overwrite: boolean) {
  const visited = new Set<string>();
  for (;;) {
    const { dir, base } = fileParts(path);
    const parent = pathDecoder.decode(await realpath(dir || '.', { encoding: 'buffer' }));
    const target = join(parent, base);
    let stat: Stats;
    try {
      stat = await lstat(target);
    } catch (error) {
      rethrowLimit(error);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { target, stat: undefined };
      throw error;
    }
    // An occupied name includes the final link itself, even if it is dangling.
    if (!overwrite) throw Object.assign(new Error(`Output already exists: ${target}`), { code: 'EEXIST', path: target });
    if (!stat.isSymbolicLink()) return { target, stat };
    visitLink(target, visited);
    path = linkTarget(parent, await readlink(target, { encoding: 'buffer' }));
  }
}

/** Flush the sibling before making it visible at the requested name. */
export async function writeFileAtomicallyAsync(
  path: string, data: Uint8Array | string, overwrite = true, beforePublish?: () => void,
): Promise<void> {
  const { target, stat } = await outputTargetAsync(path, overwrite);
  if (stat) {
    requireRegularFile(target, stat);
    const existing = await open(target, constants.O_WRONLY | constants.O_NONBLOCK);
    await existing.close();
  }
  const stage = siblingPath(target);
  const fd = await open(stage, 'wx', stat ? 0o600 : 0o666);
  let published = false;
  let publicationError: unknown;
  try {
    try {
      await fd.writeFile(data);
      if (stat && process.platform !== 'win32') await fd.chmod(stat.mode & 0o777);
      await fd.sync();
    } finally {
      await fd.close();
    }
    beforePublish?.();
    if (overwrite) {
      await rename(stage, target);
    } else {
      // link is an atomic create-if-absent, including if a competitor has
      // claimed the name since lstat. The stage can be unlinked afterwards.
      await link(stage, target);
    }
    published = true;
  } catch (error) {
    rethrowLimit(error);
    publicationError = error;
    throw error;
  } finally {
    if (!published || !overwrite) await removeSibling(stage, target, published, publicationError);
  }
}

async function removeSibling(stage: string, target: string, published: boolean, publicationError: unknown): Promise<void> {
  try {
    await unlink(stage);
  } catch (cleanupError) {
    rethrowLimit(cleanupError);
    const code = (cleanupError as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (published) {
      throw Object.assign(new Error(`Output published to ${target}, but could not remove ${stage}`,
        { cause: cleanupError }), { code });
    }
    // Cancellation and resource limits retain their original error identity.
    if (publicationError !== undefined) {
      throw Object.assign(new AggregateError([publicationError, cleanupError],
        `Could not publish ${target} or remove ${stage}`, { cause: publicationError }),
        { code: (publicationError as NodeJS.ErrnoException)?.code });
    }
  }
}
