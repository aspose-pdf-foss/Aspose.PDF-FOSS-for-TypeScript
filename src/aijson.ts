/** A model's JSON reply parsed (`u0ec`): the one place `Ask`, `GenerateAltText`
 *  and `aiOcrEngine` turn reply text into a value.
 *
 *  **Invariant:** ONE markdown code fence around the whole reply is stripped
 *  first — ```` ```json … ``` ```` or a bare ```` ``` … ``` ````. A model that
 *  ignores "reply with JSON only" nearly always does exactly that, and refusing
 *  it fails a page or a figure for a reply whose content is perfect. Only a
 *  fence spanning the WHOLE reply is stripped: JSON with prose around it is
 *  still not the requested shape.
 *
 *  A leaf importing `errors.js` alone, so all three callers may reach it. */
import { rethrowLimit } from './errors.js';

const FENCE = /^```[A-Za-z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

/** `text` with one whole-reply code fence removed, trimmed. */
export function stripJsonFence(text: string): string {
  const t = text.trim();
  const m = FENCE.exec(t);
  return (m ? m[1]! : t).trim();
}

/** The parsed reply, or `bad()` thrown when it is not JSON. */
export function parseJsonReply(text: string, bad: () => Error): unknown {
  try {
    return JSON.parse(stripJsonFence(text));
  } catch (caught) {
    rethrowLimit(caught);
    throw bad();
  }
}
