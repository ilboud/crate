/**
 * A small Markdown parser for chat answers.
 *
 * Purpose-built rather than a library for two reasons. The text comes from a
 * language model and can carry arbitrary Discogs data, so the output is a
 * token tree that the renderer turns into React nodes — no HTML string, no
 * dangerouslySetInnerHTML, nothing to inject into. And the model only uses a
 * handful of constructs here, so a full CommonMark implementation would be
 * several times the size of the app's own chat code.
 *
 * Parsing is kept separate from rendering so it can be tested without a DOM.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold'; children: Inline[] }
  | { type: 'italic'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] };

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'code'; text: string; lang: string | null };

/** Only these can be a link target; anything else renders as plain text. */
const SAFE_PROTOCOL = /^(https?:\/\/|\/)/i;

/**
 * Inline parsing, innermost-first by scanning left to right. Deliberately
 * forgiving: an unmatched `**` is text, not an error, because a half-streamed
 * answer is a normal intermediate state.
 */
export function parseInline(input: string): Inline[] {
  const out: Inline[] = [];
  let buffer = '';

  const flush = () => {
    if (buffer) {
      out.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };

  let i = 0;
  while (i < input.length) {
    const rest = input.slice(i);

    // `code` first: its contents are literal, so nothing inside is markup.
    const code = /^`([^`\n]+)`/.exec(rest);
    if (code) {
      flush();
      out.push({ type: 'code', text: code[1]! });
      i += code[0].length;
      continue;
    }

    // The href allows one level of balanced parentheses, so a real URL like
    // ..._(album) survives and a malformed target is consumed whole rather
    // than leaving its tail behind as stray text.
    const link = /^\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/.exec(rest);
    if (link) {
      flush();
      const href = link[2]!;
      const label = link[1]! || href;
      if (SAFE_PROTOCOL.test(href)) {
        out.push({ type: 'link', href, children: parseInline(label) });
      } else {
        // Unsafe or unrecognised scheme: show the label, drop the target.
        out.push({ type: 'text', text: label });
      }
      i += link[0].length;
      continue;
    }

    const bold = /^\*\*([^\n]+?)\*\*/.exec(rest);
    if (bold) {
      flush();
      out.push({ type: 'bold', children: parseInline(bold[1]!) });
      i += bold[0].length;
      continue;
    }

    const italic = /^\*([^*\n]+?)\*/.exec(rest);
    if (italic) {
      flush();
      out.push({ type: 'italic', children: parseInline(italic[1]!) });
      i += italic[0].length;
      continue;
    }

    buffer += input[i];
    i += 1;
  }

  flush();
  return out;
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const FENCE = /^```(\w*)\s*$/;

/** Block parsing: headings, fenced code, bullet and numbered lists, paragraphs. */
export function parseBlocks(input: string): Block[] {
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const endParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
  };
  const endList = () => {
    if (list) {
      blocks.push({
        type: 'list',
        ordered: list.ordered,
        items: list.items.map((t) => parseInline(t)),
      });
      list = null;
    }
  };
  const endAll = () => { endParagraph(); endList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = FENCE.exec(line);
    if (fence) {
      endAll();
      const lang = fence[1] || null;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      blocks.push({ type: 'code', text: body.join('\n'), lang });
      continue;
    }

    if (line.trim() === '') { endAll(); continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      endAll();
      blocks.push({
        type: 'heading',
        level: heading[1]!.length,
        children: parseInline(heading[2]!),
      });
      continue;
    }

    const ordered = ORDERED.exec(line);
    const bullet = BULLET.exec(line);
    if (ordered || bullet) {
      endParagraph();
      const isOrdered = Boolean(ordered);
      const text = (ordered ?? bullet)![1]!;
      // A change of list type starts a new list rather than mixing markers.
      if (list && list.ordered !== isOrdered) endList();
      if (!list) list = { ordered: isOrdered, items: [] };
      list.items.push(text);
      continue;
    }

    endList();
    paragraph.push(line.trim());
  }

  endAll();
  return blocks;
}
