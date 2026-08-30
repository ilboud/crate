/**
 * One interface over the LLM providers so the chat feature is not tied to a
 * vendor. Anthropic and OpenAI both ship from day one; an Ollama backend can
 * be added later without touching callers.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on assistant turns that requested tools. */
  toolCalls?: ToolCall[];
  /** Present on tool results. */
  toolCallId?: string;
}

export type Delta =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; stopReason: string };

export interface ChatBackend {
  readonly name: string;
  send(messages: ChatMessage[], tools: ToolSpec[], system: string): AsyncIterable<Delta>;
}

export class ChatBackendError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ChatBackendError';
  }
}

/** Reads Server-Sent Events out of a fetch body as parsed JSON objects. */
export async function* sseJson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '' || payload === '[DONE]') continue;
      try {
        yield JSON.parse(payload) as Record<string, unknown>;
      } catch {
        // A partial frame; the next chunk completes it.
      }
    }
  }
}
