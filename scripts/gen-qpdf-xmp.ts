// Generates test/fixtures/qpdf-xmp/*.pdf — documents ENCRYPTED BY qpdf with
// --cleartext-metadata, which writes /EncryptMetadata false and leaves the XMP
// packet plaintext WITHOUT a /Crypt marker (hch6). That shape is not one this
// library writes, so the reader's handling of it needs bytes we did not produce.
//
// The input is ours (a page of text and an XMP packet); what is under test is
// qpdf's encryption of it. --static-id and --static-aes-iv make the output
// reproducible, which is what lets PROVENANCE.md record hashes.
//
// It REFUSES to write a fixture whose XMP qpdf did not leave plaintext and
// unmarked, or that qpdf's own --check does not call clean.
//
// Not part of `npm test`. qpdf must be on PATH:
//
//   qpdf --version
//   npx tsx scripts/gen-qpdf-xmp.ts
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'test', 'fixtures', 'qpdf-xmp');

const TITLE = 'hch6 cleartext XMP';
const BODY = 'hch6 body text';

/** The unencrypted input: one page of text and an XMP packet. */
function input(): Uint8Array {
  const doc = Document.New();
  doc.AddPage().page.AddText(BODY, 72, 720);
  doc.SetXmp({ title: TITLE });
  return doc.Save();
}

// qpdf forces V 4 for --cleartext-metadata, so `rc4` is RC4 under a /V2 crypt
// filter, not the V 2 handler.
const FIXTURES: { name: string; args: string[] }[] = [
  { name: 'aes128', args: ['--bits=128', '--use-aes=y'] },
  { name: 'aes256', args: ['--bits=256'] },
  { name: 'rc4', args: ['--bits=128', '--use-aes=n'] },
];

function qpdf(args: string[]): { text: string; ok: boolean } {
  try {
    return { text: execFileSync('qpdf', args, { encoding: 'utf8' }), ok: true };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { text: `${err.stdout ?? ''}${err.stderr ?? ''}`, ok: false };
  }
}

function main(): void {
  const version = qpdf(['--version']).text.split('\n')[0].trim();
  if (!version.startsWith('qpdf version')) {
    console.error('qpdf not found on PATH — install it and re-run.');
    process.exit(1);
  }
  console.log(version);
  mkdirSync(outDir, { recursive: true });
  const tmp = join(outDir, '.input.pdf');
  let failed = false;

  for (const f of FIXTURES) {
    writeFileSync(tmp, input());
    const out = join(outDir, `${f.name}.pdf`);
    const run = qpdf([
      '--static-id', '--static-aes-iv', '--stream-data=preserve', '--object-streams=disable',
      ...(f.name.startsWith('rc4') ? ['--allow-weak-crypto'] : []), '--encrypt', '--user-password=', '--owner-password=owner', ...f.args, '--cleartext-metadata', '--',
      tmp, out,
    ]);
    if (!run.ok) { console.error(`${f.name}: qpdf failed\n${run.text}`); failed = true; continue; }
    const bytes = readFileSync(out);
    const text = bytes.toString('latin1');
    const meta = /\d+ 0 obj\s*<<(?:(?!endobj)[^])*?\/Type\s*\/Metadata(?:(?!endobj)[^])*?stream\r?\n/.exec(text)?.[0] ?? '';
    const plaintext = text.includes(TITLE);
    const check = qpdf(['--password=', '--check', out]);
    if (!meta || /\/Crypt/.test(meta) || !plaintext || !/EncryptMetadata false/.test(text) || !check.ok) {
      console.error(`${f.name}: not the shape under test, or qpdf --check is not clean\n${meta}\n${check.text}`);
      rmSync(out, { force: true });
      failed = true;
      continue;
    }
    const sha = createHash('sha256').update(bytes).digest('hex');
    console.log(`${f.name}.pdf  ${bytes.length}  ${sha}`);
  }
  rmSync(tmp, { force: true });
  if (failed) process.exit(1);
}

main();
