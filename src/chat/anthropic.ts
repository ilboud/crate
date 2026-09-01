import {
  ChatBackendError,
  sseJson,
  type ChatBackend,
  type ChatMessage,
  type Delta,
  type ToolSpec,
} from './backend.js';

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** Anthropic Messages API with streaming and tool use. */
export class AnthropicBackend implements ChatBackend {
  readonly name = 'anthropic';
  /** Populated per request; lets the caller confirm the cache is being hit. */
  lastUsage: Record<string, number> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly model = 'claude-opus-5',
    private readonly fetchImpl: typeof fetch = fetch,
    /**
     * Identity-linked keys are scoped to a workspace and the API rejects them
     * without this header: "anthropic-workspace-id is required when
     * authenticating with an identity-linked API key". Ordinary keys ignore it.
     */
    private readonly workspaceId?: string,
  ) {}

  async *send(
    messages: ChatMessage[],
    tools: ToolSpec[],
    system: string,
  ): AsyncIterable<Delta> {
    const res = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        ...(this.workspaceId ? { 'anthropic-workspace-id': this.workspaceId } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        stream: true,
        // The system prompt carries the whole album index, so caching it is
        // what keeps this affordable: a cache read is ~0.1x the input rate,
        // turning ~1.8c per message into ~0.18c.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: toAnthropicMessages(messages),
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
      }),
    });

    if (!res.ok || !res.body) {
      throw new ChatBackendError(
        `Anthropic request failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300),
        res.status,
      );
    }

    // tool_use arguments stream in as JSON fragments; accumulate per block.
    const partial = new Map<number, { id: string; name: string; json: string }>();
    let stopReason = 'end_turn';

    for await (const event of sseJson(res.body)) {
      const type = event.type as string;

      if (type === 'content_block_start') {
        const block = event.content_block as AnthropicBlock;
        if (block?.type === 'tool_use') {
          partial.set(event.index as number, { id: block.id!, name: block.name!, json: '' });
        }
      } else if (type === 'content_block_delta') {
        const delta = event.delta as { type: string; text?: string; partial_json?: string };
        if (delta.type === 'text_delta' && delta.text) {
          yield { type: 'text', text: delta.text };
        } else if (delta.type === 'input_json_delta') {
          const acc = partial.get(event.index as number);
          if (acc) acc.json += delta.partial_json ?? '';
        }
      } else if (type === 'content_block_stop') {
        const acc = partial.get(event.index as number);
        if (acc) {
          partial.delete(event.index as number);
          yield {
            type: 'tool_call',
            call: {
              id: acc.id,
              name: acc.name,
              arguments: acc.json ? (JSON.parse(acc.json) as Record<string, unknown>) : {},
            },
          };
        }
      } else if (type === 'message_delta') {
        const delta = event.delta as { stop_reason?: string };
        if (delta?.stop_reason) stopReason = delta.stop_reason;
      } else if (type === 'message_start') {
        const usage = (event.message as { usage?: Record<string, number> })?.usage;
        if (usage) this.lastUsage = usage;
      }
    }

    yield { type: 'done', stopReason };
  }
}

/**
 * Anthropic wants tool results as a user turn containing tool_result blocks,
 * and tool calls as assistant turns containing tool_use blocks.
 */
function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
      });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}
