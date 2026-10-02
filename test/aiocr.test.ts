import { describe, it, expect } from 'vitest';
import { aiOcrEngine } from '../src/aiocr.js';
import { AiServiceError } from '../src/errors.js';
import type { AiModel, AiRequest } from '../src/aimodel.js';
import type { OcrImage } from '../src/ocr.js';

const IMAGE: OcrImage = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png', width: 400, height: 200 };

function stub(reply: string): AiModel & { seen: AiRequest[] } {
  const seen: AiRequest[] = [];
  return { seen, complete: async (req) => { seen.push(req); return { text: reply }; } };
}

describe('aiOcrEngine (3ywf.3)', () => {
  it('sends the page image with the ocr_lines schema', async () => {
    const m = stub('{"lines":[]}');
    await aiOcrEngine(m, { language: 'German' }).recognize(IMAGE, {});
    const req = m.seen[0]!;
    expect(req.schema?.name).toBe('ocr_lines');
    expect(req.maxTokens).toBe(4096);
    const system = req.messages[0]!;
    expect(system.role).toBe('system');
    expect(String(system.content)).toContain('German');
    const user = req.messages[1]!;
    expect(Array.isArray(user.content) && user.content.some((p) => p.type === 'image' && p.bytes === IMAGE.bytes)).toBe(true);
  });

  it('scales the 0-1000 grid to pixels and normalizes inverted boxes', async () => {
    const m = stub('{"lines":[{"text":"Hi","box":[100,500,250,100]}]}');
    const spans = await aiOcrEngine(m).recognize(IMAGE, {});
    expect(spans).toEqual([{ text: 'Hi', box: [40, 20, 100, 100] }]);
  });

  it('passes the caller signal through', async () => {
    const m = stub('{"lines":[]}');
    const ctrl = new AbortController();
    await aiOcrEngine(m).recognize(IMAGE, { signal: ctrl.signal });
    expect(m.seen[0]!.signal).toBe(ctrl.signal);
  });

  for (const [what, reply] of [
    ['not JSON', 'sorry'],
    ['no lines array', '{"words":[]}'],
    ['a line without text', '{"lines":[{"box":[0,0,1,1]}]}'],
    ['a box of three numbers', '{"lines":[{"text":"a","box":[0,0,1]}]}'],
    ['a non-finite box', '{"lines":[{"text":"a","box":[0,0,"x",1]}]}'],
  ] as const) {
    it(`throws AiServiceError on ${what}`, async () => {
      await expect(aiOcrEngine(stub(reply)).recognize(IMAGE, {})).rejects.toBeInstanceOf(AiServiceError);
    });
  }

  it('validates its arguments', () => {
    expect(() => aiOcrEngine({} as never)).toThrow(TypeError);
    expect(() => aiOcrEngine(stub(''), { language: 5 as never })).toThrow(TypeError);
    expect(() => aiOcrEngine(stub(''), { maxTokens: 0 })).toThrow(RangeError);
  });
});
