import type { DocContainer, DocNode } from './docmodel.js';

/** One EPUB content document: a title for the navigation entry, and the nodes
 *  that render into it. */
export interface Chapter {
  title: string;
  nodes: DocNode[];
}

/** 1..6 for `H1`..`H6`, undefined for anything else. */
function headingLevel(type: string): number | undefined {
  if (type.length !== 2 || type[0] !== 'H') return undefined;
  const n = type.charCodeAt(1) - 48;
  return n >= 1 && n <= 6 ? n : undefined;
}

const isContainer = (n: DocNode): n is DocContainer => n.kind === 'container';

/** Every text run under `node`, concatenated — a heading's own words. */
function textOf(node: DocNode): string {
  if (node.kind === 'text') return node.text;
  if (node.kind === 'container') return node.children.map(textOf).join('');
  return '';
}

/** Descend through lone wrapper containers to the list that holds the headings.
 *
 *  Both tagged paths bury everything one level down — `AddMarkdown({ tagged })`
 *  under a `/Sect`, `AutoTag` under a `/Document` — while the untagged geometry
 *  path is already flat. Splitting the top level alone would therefore yield a
 *  single chapter for every tagged PDF, which is the whole feature failing
 *  silently on exactly the documents that carry the best structure.
 *
 *  A heading is never treated as a wrapper: descending into one would split on
 *  its inline children. */
function findBody(nodes: DocNode[]): { wrappers: DocContainer[]; body: DocNode[] } {
  const wrappers: DocContainer[] = [];
  let body = nodes;
  while (
    body.length === 1 && isContainer(body[0])
    && headingLevel(body[0].type) === undefined
    && body[0].children.length > 0
  ) {
    wrappers.push(body[0]);
    body = body[0].children;
  }
  return { wrappers, body };
}

/** Rebuild the wrapper nesting around one chapter's nodes, so a `/Sect`'s
 *  `lang` survives into every content document rather than only the first. */
function rewrap(wrappers: DocContainer[], children: DocNode[]): DocNode[] {
  let out = children;
  for (let i = wrappers.length - 1; i >= 0; i--) {
    out = [{ ...wrappers[i], children: out }];
  }
  return out;
}

/** Split a document model into chapters at its shallowest heading level.
 *
 *  **Invariant:** the split level is DERIVED, never fixed at `H1`. Our own
 *  extraction routinely produces H2-rooted documents — `buildTaggedPdf`'s only
 *  heading is an `H2` — and a fixed rule would export those as one long
 *  chapter, which is the defect this exists to fix, reintroduced for a subset
 *  of documents.
 *
 *  **Invariant:** content before the first heading becomes its own leading
 *  chapter rather than being dropped or folded into chapter one. It is real
 *  content, and this library does not silently discard content.
 *
 *  **Invariant:** the result is never empty. A document with no headings — or
 *  no content at all — yields exactly one chapter, which is the behaviour
 *  `zwto.1` shipped and what keeps the spine and the nav non-empty. */
export function splitChapters(nodes: DocNode[], fallbackTitle: string): Chapter[] {
  const { wrappers, body } = findBody(nodes);

  let level: number | undefined;
  for (const n of body) {
    if (!isContainer(n)) continue;
    const h = headingLevel(n.type);
    if (h !== undefined && (level === undefined || h < level)) level = h;
  }

  if (level === undefined) {
    return [{ title: fallbackTitle, nodes: rewrap(wrappers, body) }];
  }

  const chapters: Chapter[] = [];
  let title = fallbackTitle;
  let current: DocNode[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    chapters.push({ title, nodes: rewrap(wrappers, current) });
    current = [];
  };

  for (const n of body) {
    if (isContainer(n) && headingLevel(n.type) === level) {
      flush();
      title = textOf(n) || fallbackTitle;
    }
    current.push(n);
  }
  flush();

  return chapters.length ? chapters
    : [{ title: fallbackTitle, nodes: rewrap(wrappers, body) }];
}
