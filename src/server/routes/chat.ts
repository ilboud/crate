import { Router } from 'express';
import type { Db } from '../../db/index.js';
import { AnthropicBackend } from '../../chat/anthropic.js';
import { OpenAIBackend } from '../../chat/openai.js';
import { McpClient } from '../../chat/mcp.js';
import {
  LOCAL_TOOLS,
  LOCAL_TOOL_NAMES,
  SYSTEM_PROMPT,
  isToolAllowed,
  runLocalTool,
} from '../../chat/tools.js';
import type { ChatBackend, ChatMessage, ToolSpec } from '../../chat/backend.js';
import { providerStatus, readBackendChoice, resolveKey, type Provider } from '../settings.js';

export interface ChatConfig {
  backend?: ChatBackend;
  mcp?: McpClient;
  /** Guards against a runaway tool loop. */
  maxTurns?: number;
}

/**
 * Build the configured backend. Keys come from the environment first, then
 * from the admin screen, so an existing Docker deployment is unaffected.
 *
 * Resolved per request rather than cached at boot, so saving a key in the
 * admin screen takes effect without a restart.
 */
export function resolveBackend(db: Db): ChatBackend | null {
  const choice = readBackendChoice(db);
  const key = resolveKey(db, choice);
  if (!key) {
    // Fall back to whichever provider does have a key.
    const other: Provider = choice === 'anthropic' ? 'openai' : 'anthropic';
    const otherKey = resolveKey(db, other);
    if (!otherKey) return null;
    return build(other, otherKey, db);
  }
  return build(choice, key, db);
}

function build(provider: Provider, key: string, db: Db): ChatBackend {
  const model = providerStatus(db, provider).model;
  return provider === 'openai'
    ? new OpenAIBackend(key, model)
    : new AnthropicBackend(key, model);
}

export function mcpFromEnv(): McpClient | null {
  const url = process.env.MCP_URL;
  return url ? new McpClient(url) : null;
}

export function chatRoutes(db: Db, config: ChatConfig = {}): Router {
  const r = Router();
  // Resolved per request so a key saved in the admin screen works immediately.
  const currentBackend = (): ChatBackend | null => config.backend ?? resolveBackend(db);
  const mcp = config.mcp ?? mcpFromEnv();
  const maxTurns = config.maxTurns ?? 6;

  r.get('/status', async (_req, res) => {
    const backend = currentBackend();
    let mcpTools: number | null = null;
    let mcpError: string | null = null;
    if (mcp) {
      try {
        mcpTools = (await mcp.listTools()).length;
      } catch (err) {
        mcpError = err instanceof Error ? err.message : String(err);
      }
    }
    res.json({
      enabled: backend !== null,
      backend: backend?.name ?? null,
      localTools: LOCAL_TOOLS.length,
      mcpTools,
      mcpError,
    });
  });

  r.post('/', async (req, res) => {
    const backend = currentBackend();
    if (!backend) {
      return res.status(503).json({
        error: 'No chat backend configured. Add an API key under Settings, or set ANTHROPIC_API_KEY.',
      });
    }

    const incoming = Array.isArray(req.body?.messages) ? req.body.messages : null;
    if (!incoming) return res.status(400).json({ error: 'messages array required' });

    const messages: ChatMessage[] = incoming
      .filter((m: unknown): m is { role: string; content: string } =>
        typeof m === 'object' && m !== null && 'role' in m && 'content' in m)
      .map((m: { role: string; content: string }) => ({
        role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: String(m.content),
      }));

    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const tools: ToolSpec[] = [
        ...LOCAL_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      ];
      if (mcp) {
        try {
          tools.push(...(await mcp.listTools()));
        } catch (err) {
          // The collection index alone still answers most questions, so a
          // dead MCP container degrades the feature rather than breaking it.
          send('warning', {
            message: `Discogs tools unavailable: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      for (let turn = 0; turn < maxTurns; turn++) {
        const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
        let text = '';

        for await (const delta of backend.send(messages, tools, SYSTEM_PROMPT)) {
          if (delta.type === 'text') {
            text += delta.text;
            send('text', { text: delta.text });
          } else if (delta.type === 'tool_call') {
            calls.push(delta.call);
          }
        }

        if (calls.length === 0) {
          send('done', { turns: turn + 1 });
          return res.end();
        }

        messages.push({ role: 'assistant', content: text, toolCalls: calls });

        for (const call of calls) {
          send('tool', { name: call.name, arguments: call.arguments });

          let result: string;
          if (!isToolAllowed(call.name)) {
            result = `Refused: ${call.name} modifies the collection and is not permitted. ` +
              `Adding, moving and deleting records are done on Discogs directly.`;
          } else if (LOCAL_TOOL_NAMES.has(call.name)) {
            try {
              result = JSON.stringify(runLocalTool(db, call.name, call.arguments));
            } catch (err) {
              result = `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
          } else if (mcp) {
            try {
              result = await mcp.callTool(call.name, call.arguments);
            } catch (err) {
              result = `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
          } else {
            result = `Error: no MCP server configured for ${call.name}`;
          }

          // Very large tool payloads waste context without adding much.
          const trimmed = result.length > 12000 ? `${result.slice(0, 12000)}\n…truncated` : result;
          messages.push({ role: 'tool', content: trimmed, toolCallId: call.id });
          send('tool_result', { name: call.name, bytes: trimmed.length });
        }
      }

      send('done', { turns: maxTurns, note: 'reached the tool-call limit' });
      return res.end();
    } catch (err) {
      send('error', { message: err instanceof Error ? err.message : String(err) });
      return res.end();
    }
  });

  return r;
}
