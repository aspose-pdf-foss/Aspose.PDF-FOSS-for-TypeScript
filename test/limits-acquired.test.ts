import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { LoadLimits, type LimitField } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { decodeStream } from '../src/filters.js';
import { isStream, type PdfStream } from '../src/types.js';
import { contentPdf, buildObjectsPdf, BASE_OBJECTS } from './helpers/build-hostile-pdf.js';

// ibzo.7: a stream decodes under the policy of the document that HOLDS it.
// ibzo.3 registered streams at parse, construction and allocObject; anything
// entering a document another way decoded under LoadLimits.defaults and was
// never charged to the document's running total — so a caller's lowered limit
// silently did not reach an imported page, or an inline image.

function refusal(f: () => unknown): ResourceLimitError {
  try { f(); } catch (e) { if (e instanceof ResourceLimitError) return e; throw e; }
  throw new Error('completed without reaching a limit');
}
const expectLimit = (e: ResourceLimitError, field: LimitField) => expect(e.limit).toBe(field);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const tight = { limits: LoadLimits.defaults.with({ maxDecodedStreamBytes: 9_999 }) };

describe('a page imported from another document', () => {
  // The source opens under the defaults, where its 10,000-byte content stream is
  // fine; the target is the caller's tighter policy. Once imported, the stream
  // belongs to the target and must answer to it.
  const source = () => Document.Open(contentPdf(
    [`${hex(new Uint8Array(deflateSync(Buffer.from('n\n'.repeat(5000)))))}>`],
    { filter: '[/ASCIIHexDecode /FlateDecode]' }));

  it('decodes under the TARGET document\'s policy after AddPage', () => {
    const target = Document.Open(buildObjectsPdf(BASE_OBJECTS), tight);
    target.AddPage(source().Pages[0]);
    expectLimit(refusal(() => target.Pages[1].GetText()), 'maxDecodedStreamBytes');
  });

  it('and is charged to the target\'s running total', () => {
    const target = Document.Open(buildObjectsPdf(BASE_OBJECTS));
    target.AddPage(source().Pages[0]);
    const before = target.decodeBudget.decoded;
    target.Pages[1].GetText();
    expect(target.decodeBudget.decoded - before).toBe(10_000);
  });

  it('decodes under the target\'s policy after InsertPage too', () => {
    const target = Document.Open(buildObjectsPdf(BASE_OBJECTS), tight);
    target.InsertPage(1, source().Pages[0]);
    expectLimit(refusal(() => target.Pages[0].GetText()), 'maxDecodedStreamBytes');
  });
});

describe('an inline image', () => {
  // 100 x 100 DeviceGray, ASCIIHex-encoded: 10,000 decoded bytes, one over the
  // tight per-stream bound. Its samples live in the content op, in no object.
  const inline = () => {
    const data = hex(new Uint8Array(10_000).fill(128));
    return contentPdf([`q 10 0 0 10 0 0 cm\nBI /W 100 /H 100 /BPC 8 /CS /G /F /AHx\nID ${data}>\nEI\nQ`]);
  };

  it('decodes under the document\'s policy when rendered', () => {
    expect(() => Document.Open(inline()).Pages[0].ToImage()).not.toThrow();
    expectLimit(refusal(() => Document.Open(inline(), tight).Pages[0].ToImage()), 'maxDecodedStreamBytes');
  });

  it('decodes under the document\'s policy through page.InlineImages', () => {
    const doc = Document.Open(inline(), tight);
    expect(doc.Pages[0].InlineImages).toHaveLength(1);
    expectLimit(refusal(() => doc.Pages[0].InlineImages[0].Decode()), 'maxDecodedStreamBytes');
  });
});

describe('Document inserts objects in ONE place', () => {
  it('has no direct this.objects.set outside install()', () => {
    // Every stream a document acquires must be registered, and a new insertion
    // site written as a bare set would silently skip it. A scan is cheap and
    // names the line; the floor assertion stops a broken pattern passing by
    // matching nothing.
    const src = readFileSync(join(__dirname, '..', 'src', 'document.ts'), 'utf8');
    const lines = src.split('\n');
    const direct = lines
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /\bthis\.objects\.set\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    const inInstall = (n: number) => {
      for (let i = n - 1; i >= 0 && i >= n - 6; i--) if (/private install\(/.test(lines[i])) return true;
      return false;
    };
    expect(direct.length).toBeGreaterThan(0);
    expect(direct.filter(({ n }) => !inInstall(n)).map(({ l, n }) => `${n}: ${l.trim()}`)).toEqual([]);
  });

  it('registers what it installs — every stream in a merged document decodes under that document', () => {
    // Filtered: an unfiltered stream decodes to its own raw bytes and is never
    // charged, so it could not show whether it was registered.
    const merged = Document.Merge(Document.Open(contentPdf(
      [`${hex(new TextEncoder().encode('n\n'.repeat(10)))}>`], { filter: '/ASCIIHexDecode' })));
    for (const [, obj] of merged.objectEntries()) {
      if (!isStream(obj)) continue;
      decodeStream(obj as PdfStream);
    }
    expect(merged.decodeBudget.decoded).toBeGreaterThan(0);
  });

  it('registers the streams of a document built from an object map — Split and ExtractPages', () => {
    // These never pass through install(): the constructor's own loop is the only
    // registration they get, where a parsed or merged document has two.
    const source = Document.Open(contentPdf(
      [`${hex(new TextEncoder().encode('n\n'.repeat(10)))}>`], { filter: '/ASCIIHexDecode' }));
    for (const part of [source.Split()[0], source.ExtractPages([1])]) {
      for (const [, obj] of part.objectEntries()) if (isStream(obj)) decodeStream(obj as PdfStream);
      expect(part.decodeBudget.decoded).toBeGreaterThan(0);
    }
  });
});
