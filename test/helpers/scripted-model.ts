import type { AiModel, AiRequest, AiResponse } from '../../src/aimodel.js';

/** An AiModel stub: `answer(req, n)` replies to the n-th request (1-based). A
 *  string reply becomes `{ text }`. Every request is recorded in `requests`. */
export function scriptedModel(
  answer: (req: AiRequest, n: number) => string | AiResponse | Promise<string | AiResponse>,
): AiModel & { requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  return {
    requests,
    async complete(req: AiRequest): Promise<AiResponse> {
      requests.push(req);
      const r = await answer(req, requests.length);
      return typeof r === 'string' ? { text: r } : r;
    },
  };
}

/** The system prompt and the user text of a recorded request. */
export function systemOf(req: AiRequest): string {
  const m = req.messages.find((x) => x.role === 'system');
  return typeof m?.content === 'string' ? m.content : '';
}
export function userTextOf(req: AiRequest): string {
  const m = req.messages.find((x) => x.role === 'user');
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
}
