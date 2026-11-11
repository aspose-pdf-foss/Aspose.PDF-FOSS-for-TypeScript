import { describe, it, expect } from 'vitest';
import { Document, type SaveOptions } from '../src/document.js';
import type { OperationProgress } from '../src/checkpoint.js';
import { controlDocument } from './helpers/control-fixtures.js';
import { buildManyGlyphTtf } from './helpers/build-optimize-pdf.js';
import { buildSigner } from './helpers/build-signer.js';

const modes: Array<[string, SaveOptions]> = [
  ['classic', {}], ['compressed', { compressed: true }],
  ['encrypted', { encrypt: { userPassword: 'pw', algorithm: 'rc4' } }],
  ['compressed encrypted', { compressed: true, encrypt: { userPassword: 'pw', algorithm: 'rc4' } }],
  ['filter', { streamFilter: 'ASCII85Decode' }], ['linearized', { linearized: true }],
  ['incremental', { incremental: true }],
];

describe('cooperative Save', () => {
  for (const [name, options] of modes) it(`supports ${name} output with controls and async parity`, async () => {
    const bytes = controlDocument().Save(), doc = Document.Open(bytes), events: OperationProgress[] = [];
    doc.Pages[0].Rotate = 90;
    const reason = new Error('pre-abort');
    expect(() => doc.Save({ ...options, signal: AbortSignal.abort(reason) })).toThrow(reason);
    await expect(doc.SaveAsync({ ...options, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    const actual = await doc.SaveAsync({ ...options, onProgress: (e) => events.push(e) });
    const expected = doc.Save(options);
    if (!options.encrypt) expect(actual).toEqual(expected);
    const reopened = Document.Open(actual, options.encrypt ? { password: 'pw' } : undefined);
    expect(reopened.Pages).toHaveLength(3);
    expect(reopened.Pages[0].Rotate).toBe(90);
    expect(reopened.Validate().Passed).toBe(true);
    expect(new Set(events.map((e) => e.operation))).toEqual(new Set(['Save']));
    if (options.incremental) expect(actual.slice(0, bytes.length)).toEqual(bytes);
  });

  it.each(['plan', 'remap', 'objects', 'groups', 'linearize', 'diff', 'filter', 'fonts'])('cancels during %s and can be retried', async (phase) => {
    const doc = Document.Open(controlDocument().Save()), controller = new AbortController(), reason = new Error(phase);
    doc.Pages[0].Rotate = 90;
    if (phase === 'fonts') {
      const font = doc.AddFont(buildManyGlyphTtf(5));
      doc.Pages[0].AddText('A', 2, 12, { font, fontSize: 8 });
    }
    const options: SaveOptions = phase === 'groups' ? { compressed: true }
      : phase === 'linearize' ? { linearized: true } : phase === 'diff' ? { incremental: true }
      : phase === 'filter' ? { streamFilter: 'ASCII85Decode' } : {};
    const events: OperationProgress[] = [];
    let handle: NodeJS.Immediate | undefined;
    try {
      await expect(doc.SaveAsync({ ...options, signal: controller.signal, onProgress: (e) => {
        events.push(e); if (e.phase === phase) handle = setImmediate(() => controller.abort(reason));
      } })).rejects.toBe(reason);
      expect(events.at(-1)?.phase).toBe(phase);
      expect(Document.Open(await doc.SaveAsync(options)).Validate().Passed).toBe(true);
    } finally { if (handle) clearImmediate(handle); }
  });

  it('checks pre-abort before font preparation and propagates callback failures', async () => {
    const doc = controlDocument(), font = doc.AddFont(buildManyGlyphTtf(5));
    doc.Pages[0].AddText('A', 2, 12, { font, fontSize: 8 });
    const count = [...doc.objectEntries()].length, reason = new Error('before prepare');
    await expect(doc.SaveAsync({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect([...doc.objectEntries()]).toHaveLength(count);
    await expect(doc.SaveAsync({ onProgress: () => { throw 'callback failed'; } })).rejects.toMatchObject({ cause: 'callback failed' });
  });

  it('honours controls on signed-verbatim output without invalidating it', async () => {
    const doc = controlDocument(), signer = buildSigner({ type: 'rsa' });
    await doc.Sign({ certificate: signer.certificate, privateKey: signer.privateKey });
    const signed = doc.Save(), reason = new Error('signed abort');
    expect(await doc.SaveAsync()).toBe(signed);
    await expect(doc.SaveAsync({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    const controller = new AbortController();
    await expect(doc.SaveAsync({ signal: controller.signal, onProgress: () => controller.abort(reason) })).rejects.toBe(reason);
    expect(doc.Save()).toBe(signed);
    await expect(doc.SaveAsync({ incremental: true })).rejects.toThrow(/signing in this session/);
  });

  it('preserves incompatible mode refusals', async () => {
    const doc = Document.Open(controlDocument().Save());
    await expect(doc.SaveAsync({ incremental: true, compressed: true })).rejects.toThrow(/compressed/);
    await expect(doc.SaveAsync({ linearized: true, compressed: true })).rejects.toThrow(/compressed/);
  });
});
