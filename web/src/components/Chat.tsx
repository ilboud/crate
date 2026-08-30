import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface Turn {
  role: 'you' | 'assistant';
  text: string;
  tools: string[];
}

/**
 * Chat over the collection. Streams SSE from the server, which holds the API
 * keys and decides which tools may run. Tool activity is shown as it happens
 * so it is clear when the answer came from the local index versus Discogs.
 */
export function Chat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ enabled: boolean; backend: string | null; mcpTools: number | null } | null>(null);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.chatStatus().then(setStatus).catch(() => setStatus({ enabled: false, backend: null, mcpTools: null }));
  }, []);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || busy) return;

    const history = [...turns, { role: 'you' as const, text: question, tools: [] }];
    setTurns([...history, { role: 'assistant', text: '', tools: [] }]);
    setInput('');
    setBusy(true);

    const update = (fn: (t: Turn) => Turn) =>
      setTurns((prev) => prev.map((t, i) => (i === prev.length - 1 ? fn(t) : t)));

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: history.map((t) => ({
            role: t.role === 'you' ? 'user' : 'assistant',
            content: t.text,
          })),
        }),
      });

      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({ error: 'Chat is unavailable.' }));
        update((t) => ({ ...t, text: (body as { error?: string }).error ?? 'Chat is unavailable.' }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let event = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
          if (!line.startsWith('data:')) continue;

          const data = JSON.parse(line.slice(5).trim()) as Record<string, string>;
          if (event === 'text') update((t) => ({ ...t, text: t.text + data.text }));
          else if (event === 'tool') update((t) => ({ ...t, tools: [...t.tools, data.name!] }));
          else if (event === 'warning' || event === 'error') {
            update((t) => ({ ...t, text: `${t.text}\n\n${data.message}` }));
          }
        }
      }
    } catch (err) {
      update((t) => ({ ...t, text: `Chat failed: ${err instanceof Error ? err.message : String(err)}` }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat">
      <div className="chat-log" ref={log}>
        {turns.length === 0 && (
          <p className="empty">
            {status && !status.enabled
              ? 'Chat needs an API key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY and restart.'
              : 'Ask about the collection — “what modal jazz do I own?”, “which records have Blue In Green?”, “what should I play after Bitches Brew?”'}
          </p>
        )}

        {turns.map((t, i) => (
          <div className={`bubble ${t.role === 'you' ? 'you' : ''}`} key={i}>
            <div className="who">{t.role === 'you' ? 'You' : status?.backend ?? 'Assistant'}</div>
            {t.tools.map((name, j) => (
              <div className="toolnote" key={j}>
                {name.startsWith('search_my') || name.startsWith('browse_my') || name.startsWith('get_album') || name.startsWith('collection_')
                  ? `Looked in your collection · ${name}`
                  : `Asked Discogs · ${name}`}
              </div>
            ))}
            <p>{t.text || (busy && i === turns.length - 1 ? '…' : '')}</p>
          </div>
        ))}
      </div>

      <form className="chat-form" onSubmit={send}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your records"
          disabled={busy || (status !== null && !status.enabled)}
          aria-label="Ask about your records"
        />
        <button type="submit" disabled={busy || !input.trim()}>
          {busy ? 'Thinking' : 'Ask'}
        </button>
      </form>
    </div>
  );
}
