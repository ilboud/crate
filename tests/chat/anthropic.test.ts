import { describe, it, expect } from 'vitest';
import { AnthropicBackend } from '../../src/chat/anthropic.js';

/** Captures the request the backend would send, without contacting the API. */
function capturingFetch(): { calls: RequestInit[]; fetch: typeof fetch } {
  const calls: RequestInit[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    calls.push(init ?? {});
    return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl };
}

const drain = async (backend: AnthropicBackend) => {
  for await (const _ of backend.send([{ role: 'user', content: 'hi' }], [], 'sys')) {
    // consume
  }
};

describe('AnthropicBackend headers', () => {
  it('sends the workspace header when a workspace id is configured', async () => {
    // Without it, an identity-linked key is rejected with:
    // "anthropic-workspace-id is required when authenticating with an
    // identity-linked API key".
    const { calls, fetch } = capturingFetch();
    await drain(new AnthropicBackend('sk-test', 'claude-sonnet-5', fetch, 'wrkspc_abc123'));

    const headers = calls[0]!.headers as Record<string, string>;
    expect(headers['anthropic-workspace-id']).toBe('wrkspc_abc123');
    expect(headers['x-api-key']).toBe('sk-test');
  });

  it('omits the header entirely when no workspace is set', async () => {
    // An ordinary key must not receive an empty workspace header.
    const { calls, fetch } = capturingFetch();
    await drain(new AnthropicBackend('sk-test', 'claude-sonnet-5', fetch));

    const headers = calls[0]!.headers as Record<string, string>;
    expect('anthropic-workspace-id' in headers).toBe(false);
  });
});
