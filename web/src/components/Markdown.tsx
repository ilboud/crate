import { Fragment, type ReactNode } from 'react';
import { parseBlocks, type Block, type Inline } from '../markdown';

/**
 * Renders parsed Markdown as React nodes.
 *
 * Nothing here builds an HTML string, so model output — which can echo
 * arbitrary Discogs data — has no path to becoming markup. Link targets were
 * already filtered to http(s) and site-relative during parsing.
 */

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return <Fragment key={i}>{node.text}</Fragment>;
      case 'bold':
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case 'italic':
        return <em key={i}>{renderInline(node.children)}</em>;
      case 'code':
        return <code key={i}>{node.text}</code>;
      case 'link':
        return (
          <a key={i} href={node.href} target="_blank" rel="noopener noreferrer">
            {renderInline(node.children)}
          </a>
        );
    }
  });
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return <p key={key}>{renderInline(block.children)}</p>;
    case 'heading': {
      // Chat answers sit inside the conversation, so headings are styled by
      // level rather than emitting h1-h4 into the page outline.
      return (
        <p key={key} className={`md-h md-h${block.level}`}>
          {renderInline(block.children)}
        </p>
      );
    }
    case 'list':
      return block.ordered ? (
        <ol key={key}>
          {block.items.map((item, i) => <li key={i}>{renderInline(item)}</li>)}
        </ol>
      ) : (
        <ul key={key}>
          {block.items.map((item, i) => <li key={i}>{renderInline(item)}</li>)}
        </ul>
      );
    case 'code':
      return (
        <pre key={key}>
          <code>{block.text}</code>
        </pre>
      );
  }
}

export function Markdown({ text }: { text: string }) {
  if (!text) return null;
  return <div className="md">{parseBlocks(text).map(renderBlock)}</div>;
}
