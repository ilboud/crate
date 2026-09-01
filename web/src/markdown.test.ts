import { describe, it, expect } from 'vitest';
import { parseBlocks, parseInline, type Inline } from './markdown';

/** Flatten a token tree back to its visible text, for concise assertions. */
function textOf(nodes: Inline[]): string {
  return nodes
    .map((n) =>
      n.type === 'text' || n.type === 'code' ? n.text : textOf(n.children),
    )
    .join('');
}

describe('parseInline', () => {
  it('reads plain text', () => {
    expect(parseInline('You own seven records.')).toEqual([
      { type: 'text', text: 'You own seven records.' },
    ]);
  });

  it('reads bold, which is what the model actually emits for titles', () => {
    const out = parseInline('You own **Bitches Brew** on vinyl.');
    expect(out[0]).toEqual({ type: 'text', text: 'You own ' });
    expect(out[1]).toMatchObject({ type: 'bold' });
    expect(textOf([out[1]!])).toBe('Bitches Brew');
    expect(out[2]).toEqual({ type: 'text', text: ' on vinyl.' });
  });

  it('reads italic without mistaking it for bold', () => {
    const out = parseInline('*Kind Of Blue* is modal.');
    expect(out[0]).toMatchObject({ type: 'italic' });
    expect(textOf(out)).toBe('Kind Of Blue is modal.');
  });

  it('prefers bold over italic when both could match', () => {
    const out = parseInline('**Star People**');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'bold' });
  });

  it('reads inline code literally, so markup inside it is not parsed', () => {
    const out = parseInline('The catalogue number is `GP **26**`.');
    expect(out[1]).toEqual({ type: 'code', text: 'GP **26**' });
  });

  it('leaves an unmatched marker as text rather than failing', () => {
    // A half-streamed answer is a normal intermediate state.
    expect(textOf(parseInline('You own **Bitches Br'))).toBe('You own **Bitches Br');
    expect(textOf(parseInline('a * lone asterisk'))).toBe('a * lone asterisk');
  });

  it('reads a safe link', () => {
    const out = parseInline('See [Discogs](https://discogs.com/release/37006).');
    expect(out[1]).toMatchObject({ type: 'link', href: 'https://discogs.com/release/37006' });
    expect(textOf([out[1]!])).toBe('Discogs');
  });

  it('strips a javascript: target and keeps only the label', () => {
    // The text is model output that can echo arbitrary Discogs data, so an
    // unrecognised scheme must never become a live target.
    const out = parseInline('[click me](javascript:alert(1))');
    expect(out).toEqual([{ type: 'text', text: 'click me' }]);
    expect(JSON.stringify(out)).not.toContain('javascript');
  });

  it('strips a data: target', () => {
    const out = parseInline('[x](data:text/html;base64,PHNjcmlwdD4=)');
    expect(out.every((n) => n.type !== 'link')).toBe(true);
  });

  it('keeps a URL that legitimately contains parentheses', () => {
    const out = parseInline('[Kind of Blue](https://en.wikipedia.org/wiki/Kind_of_Blue_(album))');
    expect(out[0]).toMatchObject({
      type: 'link',
      href: 'https://en.wikipedia.org/wiki/Kind_of_Blue_(album)',
    });
  });

  it('allows a site-relative link', () => {
    const out = parseInline('[covers](/covers/37006-hi.jpg)');
    expect(out[0]).toMatchObject({ type: 'link', href: '/covers/37006-hi.jpg' });
  });
});

describe('parseBlocks', () => {
  it('makes one paragraph from wrapped lines', () => {
    const blocks = parseBlocks('You own seven\nMiles Davis records.');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('paragraph');
  });

  it('splits paragraphs on a blank line', () => {
    const blocks = parseBlocks('First.\n\nSecond.');
    expect(blocks).toHaveLength(2);
  });

  it('reads a numbered list, which is how it answered the Miles Davis question', () => {
    const blocks = parseBlocks(
      '1. **Bitches Brew** (1970)\n2. **Kind Of Blue** (2011)\n3. **Star People** (2022)',
    );
    expect(blocks).toHaveLength(1);
    const list = blocks[0]!;
    expect(list).toMatchObject({ type: 'list', ordered: true });
    if (list.type !== 'list') throw new Error('expected a list');
    expect(list.items).toHaveLength(3);
    expect(textOf(list.items[0]!)).toBe('Bitches Brew (1970)');
  });

  it('reads a bullet list', () => {
    const blocks = parseBlocks('- Jazz\n- Rock\n- Soul');
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: false });
  });

  it('starts a new list when the marker type changes', () => {
    const blocks = parseBlocks('- one\n- two\n1. three');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ ordered: false });
    expect(blocks[1]).toMatchObject({ ordered: true });
  });

  it('keeps a paragraph and a following list separate', () => {
    const blocks = parseBlocks('You own 7 releases:\n1. Bitches Brew\n2. Kind Of Blue');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe('paragraph');
    expect(blocks[1]!.type).toBe('list');
  });

  it('reads headings', () => {
    const blocks = parseBlocks('## Jazz\nSeven records.');
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 2 });
    expect(blocks[1]!.type).toBe('paragraph');
  });

  it('reads a fenced code block verbatim', () => {
    const blocks = parseBlocks('Try:\n```bash\nnpm run sync\n```');
    expect(blocks[1]).toEqual({ type: 'code', text: 'npm run sync', lang: 'bash' });
  });

  it('does not parse markup inside a fenced block', () => {
    const blocks = parseBlocks('```\n**not bold**\n```');
    expect(blocks[0]).toMatchObject({ text: '**not bold**' });
  });

  it('tolerates an unterminated fence', () => {
    const blocks = parseBlocks('```\nstill going');
    expect(blocks[0]).toMatchObject({ type: 'code', text: 'still going' });
  });

  it('returns nothing for empty input', () => {
    expect(parseBlocks('')).toEqual([]);
    expect(parseBlocks('   \n\n  ')).toEqual([]);
  });

  it('handles the real shape of an answer it gave', () => {
    const answer = [
      'You have 7 releases featuring Miles Davis:',
      '',
      '1. **Bitches Brew** (1970) #37006',
      '2. **Porgy And Bess** (1997) #1811497',
      '',
      'The first 5 are solo albums.',
    ].join('\n');
    const blocks = parseBlocks(answer);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'list', 'paragraph']);
  });
});
