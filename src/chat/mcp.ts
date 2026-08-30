import type { ToolSpec } from './backend.js';
import { filterAllowedTools, isToolAllowed } from './tools.js';

/**
 * Minimal MCP client speaking JSON-RPC over the server's HTTP stream
 * transport. The Discogs MCP server runs as a peer container, so this is a
 * plain HTTP hop on the Docker network — no stdio subprocess to manage.
 *
 * Only the handful of methods the chat loop needs are implemented: initialize,
 * tools/list and tools/call.
 */

interface JsonRpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpError';
  }
}

export class McpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private initialized = false;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async rpc(method: string, params: unknown, notify = false): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // The streamable-HTTP transport may answer with either content type.
      accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(
        notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params },
      ),
    });

    const session = res.headers.get('mcp-session-id');
    if (session) this.sessionId = session;

    if (!res.ok) throw new McpError(`MCP ${method} failed: ${res.status}`);
    if (notify) return {};

    const text = await res.text();
    if (text.trim() === '') return {};

    // An SSE-framed reply carries the JSON on data: lines.
    const payload = text.includes('data:')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .filter((l) => l && l !== '[DONE]')
          .pop() ?? '{}'
      : text;

    const body = JSON.parse(payload) as JsonRpcResponse;
    if (body.error) throw new McpError(`MCP ${method}: ${body.error.message}`);
    return body;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'discogs-collection-app', version: '0.1.0' },
    });
    await this.rpc('notifications/initialized', {}, true);
    this.initialized = true;
  }

  /** Tools the policy permits, in the shape the LLM backends expect. */
  async listTools(): Promise<ToolSpec[]> {
    await this.initialize();
    const body = await this.rpc('tools/list', {});
    const tools = (body.result?.tools ?? []) as McpToolDefinition[];
    return filterAllowedTools(tools).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    // Defence in depth: the tool list is already filtered, but a model can
    // name a tool that was never offered.
    if (!isToolAllowed(name)) {
      throw new McpError(`tool ${name} is not permitted`);
    }
    await this.initialize();
    const body = await this.rpc('tools/call', { name, arguments: args });
    const content = (body.result?.content ?? []) as Array<{ type: string; text?: string }>;
    return content
      .map((c) => c.text ?? '')
      .join('\n')
      .trim();
  }
}
