import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A scripted local chat-completions server (`3ywf.2`). Nothing in the suite
 *  reaches the internet — the arrangement `test/sign-seed.test.ts` uses for
 *  `httpTimestampProvider`. */

export interface Hit { method: string; url: string; headers: IncomingHttpHeaders; body: string }
export type Reply = (hit: Hit, res: ServerResponse) => void;
export interface AiServer { url: string; hits: Hit[]; close(): Promise<void> }

/** Start a server answering the n-th request with `replies[n]` (the last reply
 *  repeats), or every request with `replies` when it is one function. `url` is
 *  the BASE url — the client appends `/chat/completions`. */
export async function startAiServer(replies: Reply | Reply[]): Promise<AiServer> {
  const list = Array.isArray(replies) ? replies : [replies];
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const hit: Hit = {
        method: req.method ?? '', url: req.url ?? '', headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      hits.push(hit);
      list[Math.min(hits.length - 1, list.length - 1)]!(hit, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    url, hits,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** A 200 chat completion whose message content is `content`. `extra` is merged
 *  into `choices[0]` (e.g. `{ finish_reason: 'length' }`, or a `message`). */
export function completion(content: string | null, extra: Record<string, unknown> = {}): Reply {
  return (_hit, res) => {
    const body = {
      id: 'cmpl-1', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', ...extra }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

/** A response with `code`, a JSON (or raw string) `body`, and `headers`. */
export function status(code: number, body: unknown = {}, headers: Record<string, string> = {}): Reply {
  return (_hit, res) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}
