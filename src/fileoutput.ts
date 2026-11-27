import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fsyncSync, lstatSync, openSync,
  readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, sep } from 'node:path';

// Path operations below use strings. Fail before staging if a filesystem
// name cannot be represented, rather than replacing a different filename.
const pathDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Resolve the parent even when the final component (including a link target)
// does not exist yet. rename() on a symlink itself would destroy the link.
function outputTarget(path: string) {
  const visited = new Set<string>();
  for (;;) {
    if (!path) throw Object.assign(new Error('Empty PDF output path'), { code: 'ENOENT' });
    const { dir, base } = parse(path);
    if (!base || base === '.' || base === '..' || (process.platform !== 'win32' && path.endsWith('/')))
      throw Object.assign(new Error(`Expected a file path: ${path}`), { code: 'EISDIR' });
    const parent = pathDecoder.decode(realpathSync.native(dir || '.', { encoding: 'buffer' }));
    const target = join(parent, base);
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (!stat?.isSymbolicLink()) return { target, stat };
    if (visited.has(target) || visited.size >= 40)
      throw Object.assign(new Error(`Too many symbolic links: ${path}`), { code: 'ELOOP' });
    visited.add(target);
    const link = pathDecoder.decode(readlinkSync(target, { encoding: 'buffer' }));
    // Leave ".." in the path until the filesystem resolves any preceding links.
    path = isAbsolute(link) ? link : parent + sep + link;
  }
}

/** Publish a complete file with one rename on the destination filesystem. */
export function writeFileAtomically(path: string, bytes: Uint8Array): void {
  const { target, stat } = outputTarget(path);
  if (stat) {
    if (!stat.isFile())
      throw Object.assign(new Error(`Expected a regular PDF output file: ${target}`),
        { code: stat.isDirectory() ? 'EISDIR' : 'EINVAL' });
    // Rename checks the parent directory. Keep the old writer's access check
    // on the file too, including Windows read-only attributes and ACLs.
    closeSync(openSync(target, constants.O_WRONLY | constants.O_NONBLOCK));
  }
  const stage = join(dirname(target), '.pdf-' + randomUUID() + '.tmp');
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
