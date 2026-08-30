import {
  ChatBackendError,
  sseJson,
  type ChatBackend,
  type ChatMessage,
  type Delta,
  type ToolSpec,
} from './backend.js';

/** OpenAI Chat Completions with streaming and function calling. */
export class OpenAIBackend implements ChatBackend {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly model = 'gpt-4o',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  async *send(
    messages: ChatMessage[],
    tools: ToolSpec[],
    system: string,
  ): AsyncIterable<Delta> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        messages: [{ role: 'system', content: system }, ...toOpenAIMessages(messages)],
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      }),
    });

    if (!res.ok || !res.body) {
      throw new ChatBackendError(
        `OpenAI request failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300),
        res.status,
      );
    }

    // Tool calls arrive spread across chunks, keyed by index.
    const partial = new Map<number, { id: string; name: string; args: string }>();
    let stopReason = 'stop';

    for await (const event of sseJson(res.body)) {
      const choice = (event.choices as Array<Record<string, unknown>> | undefined)?.[0];
      if (!choice) continue;

      const delta = choice.delta as
        | { content?: string; tool_calls?: Array<Record<string, unknown>> }
        | undefined;

      if (delta?.content) yield { type: 'text', text: delta.content };

      for (const tc of delta?.tool_calls ?? []) {
        const index = (tc.index as number) ?? 0;
        const fn = tc.function as { name?: string; arguments?: string } | undefined;
        const acc = partial.get(index) ?? { id: '', name: '', args: '' };
        if (tc.id) acc.id = tc.id as string;
        if (fn?.name) acc.name = fn.name;
        if (fn?.arguments) acc.args += fn.arguments;
        partial.set(index, acc);
      }

      if (choice.finish_reason) {
        stopReason = choice.finish_reason as string;
        if (stopReason === 'tool_calls') {
          for (const acc of partial.values()) {
            yield {
              type: 'tool_call',
              call: {
                id: acc.id || `call_${acc.name}`,
                name: acc.name,
                arguments: acc.args ? (JSON.parse(acc.args) as Record<string, unknown>) : {},
              },
            };
          }
          partial.clear();
        }
      }
    }

    yield { type: 'done', stopReason };
  }
}

function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}
