import { useEffect, useState } from 'react';
import { api, type AdminSettings, type FeelSettings, type Momentum } from '../api';
import { AdminTaxonomy } from './AdminTaxonomy';

type Tab = 'feel' | 'chat' | 'genres';

const TABS: Array<[Tab, string]> = [
  ['feel', 'Feel'],
  ['chat', 'Chat'],
  ['genres', 'Genres'],
];

export function Settings({
  onFeelChange,
  onTaxonomyChange,
}: {
  onFeelChange: (feel: FeelSettings) => void;
  onTaxonomyChange: () => void;
}) {
  const [tab, setTab] = useState<Tab>('feel');

  return (
    <div className="admin">
      <div className="admin-inner">
        <nav className="tabs" aria-label="Settings sections">
          {TABS.map(([key, label]) => (
            <button key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </nav>

        {tab === 'feel' && <FeelPanel onChange={onFeelChange} />}
        {tab === 'chat' && <ChatPanel />}
      </div>

      {/* Rendered outside admin-inner: it brings its own layout. */}
      {tab === 'genres' && <AdminTaxonomy onChanged={onTaxonomyChange} embedded />}
    </div>
  );
}

/* ----------------------------------------------------------------- feel */

const MOMENTUM_LABELS: Array<[Momentum, string, string]> = [
  ['off', 'Off', 'Stops where you let go'],
  ['low', 'Low', 'A short coast'],
  ['medium', 'Medium', 'Carries a few records'],
  ['high', 'High', 'Throws across the crate'],
];

function FeelPanel({ onChange }: { onChange: (feel: FeelSettings) => void }) {
  const [feel, setFeel] = useState<FeelSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.settings().then((s) => setFeel(s.feel)).catch((e: Error) => setError(e.message));
  }, []);

  async function save(update: Partial<FeelSettings>) {
    setError(null);
    try {
      const next = await api.saveFeel(update);
      setFeel(next);
      onChange(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error && !feel) return <p className="empty">{error}</p>;
  if (!feel) return <p className="empty">Loading…</p>;

  return (
    <>
      <h2>How the crate moves</h2>
      <p className="lede">
        Changes apply straight away. Flip to the crate and try a flick — this is worth tuning on
        whichever screen you actually browse on.
      </p>
      {error && <div className="warn">{error}</div>}
      {saved && <p className="savedmark">Saved</p>}

      <section className="field">
        <label htmlFor="momentum">Flick momentum</label>
        <p className="fieldhelp">How far the crate keeps moving after you let go.</p>
        <div className="segmented" id="momentum">
          {MOMENTUM_LABELS.map(([value, label, help]) => (
            <button
              key={value}
              aria-pressed={feel.momentum === value}
              onClick={() => save({ momentum: value })}
              title={help}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="fieldhelp">
          {MOMENTUM_LABELS.find(([v]) => v === feel.momentum)?.[2]}
        </p>
      </section>

      <section className="field">
        <label htmlFor="sensitivity">Drag distance per record</label>
        <p className="fieldhelp">
          Lower means a shorter swipe moves further. Currently{' '}
          <b>{Math.round(feel.sensitivity * 100)}%</b> of a sleeve width.
        </p>
        <div className="sliderrow">
          <span className="count">Shorter</span>
          <input
            id="sensitivity"
            type="range"
            min={15}
            max={90}
            step={1}
            value={Math.round(feel.sensitivity * 100)}
            onChange={(e) => setFeel({ ...feel, sensitivity: Number(e.target.value) / 100 })}
            onPointerUp={() => save({ sensitivity: feel.sensitivity })}
            onKeyUp={() => save({ sensitivity: feel.sensitivity })}
          />
          <span className="count">Longer</span>
        </div>
      </section>

      <section className="field">
        <label htmlFor="neighbours">Covers either side</label>
        <p className="fieldhelp">
          Auto shows more on a bigger screen: 2 on a phone, 5 on a laptop.
        </p>
        <div className="segmented" id="neighbours">
          <button
            aria-pressed={feel.neighbours === 'auto'}
            onClick={() => save({ neighbours: 'auto' })}
          >
            Auto
          </button>
          {[2, 3, 4, 5, 6].map((n) => (
            <button key={n} aria-pressed={feel.neighbours === n} onClick={() => save({ neighbours: n })}>
              {n}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

/* ----------------------------------------------------------------- chat */

function ChatPanel() {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = () => api.settings().then(setSettings).catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);

  async function run(fn: () => Promise<unknown>, note: string) {
    setError(null);
    try {
      await fn();
      await load();
      setSaved(note);
      setTimeout(() => setSaved(null), 2400);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error && !settings) return <p className="empty">{error}</p>;
  if (!settings) return <p className="empty">Loading…</p>;

  return (
    <>
      <h2>Chat</h2>
      <p className="lede">
        Keys are stored on the server and never sent back to the browser — you can replace or clear
        one, but not read it. Anything set in the environment wins, and is shown as such.
      </p>
      {error && <div className="warn">{error}</div>}
      {saved && <p className="savedmark">{saved}</p>}

      <section className="field">
        <label>Provider</label>
        <p className="fieldhelp">
          {settings.chat.backendFromEnv
            ? 'Fixed by CHAT_BACKEND in the environment.'
            : 'Which service answers your questions.'}
        </p>
        <div className="segmented">
          {settings.chat.providers.map((p) => (
            <button
              key={p.provider}
              aria-pressed={settings.chat.backend === p.provider}
              disabled={settings.chat.backendFromEnv}
              onClick={() => run(() => api.saveChat({ backend: p.provider }), 'Provider changed')}
            >
              {p.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}
            </button>
          ))}
        </div>
      </section>

      {settings.chat.providers.map((p) => (
        <section className="field" key={p.provider}>
          <label>{p.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key</label>

          {p.configured ? (
            <p className="fieldhelp">
              <span className="keyhint">{p.hint}</span>{' '}
              {p.source === 'env' ? 'set in the environment' : 'stored on the server'}
            </p>
          ) : (
            <p className="fieldhelp">Not set — chat is off for this provider.</p>
          )}

          <div className="keyrow">
            <input
              type="password"
              autoComplete="off"
              placeholder={p.configured ? 'Paste a new key to replace it' : 'Paste your API key'}
              value={drafts[p.provider] ?? ''}
              onChange={(e) => setDrafts({ ...drafts, [p.provider]: e.target.value })}
              aria-label={`${p.provider} API key`}
              disabled={p.source === 'env'}
            />
            <button
              className="navbtn"
              disabled={!(drafts[p.provider] ?? '').trim() || p.source === 'env'}
              onClick={() =>
                run(async () => {
                  await api.saveKey(p.provider, (drafts[p.provider] ?? '').trim());
                  setDrafts({ ...drafts, [p.provider]: '' });
                }, 'Key saved')
              }
            >
              Save
            </button>
            {p.source === 'stored' && (
              <button
                className="navbtn"
                onClick={() => run(() => api.saveKey(p.provider, null), 'Key cleared')}
              >
                Clear
              </button>
            )}
          </div>

          {p.provider === 'anthropic' && (
            <>
              <p className="fieldhelp" style={{ margin: '12px 0 4px' }}>
                Workspace ID — needed only if your key covers <b>all workspaces</b>, since
                each request then has to say which one it acts in. A key scoped to a single
                workspace needs nothing here. Copy it from the ID column of Settings →
                Workspaces in the Claude Console.
              </p>
              <div className="keyrow">
                <input
                  type="text"
                  placeholder="wrkspc_…"
                  defaultValue={p.workspaceId ?? ''}
                  aria-label="Anthropic workspace ID"
                  onBlur={(e) =>
                    run(
                      () => api.saveChat({ workspaceId: e.target.value.trim() || null }),
                      'Workspace saved',
                    )
                  }
                />
              </div>
            </>
          )}

          <p className="fieldhelp" style={{ margin: '12px 0 4px' }}>
            Model
          </p>
          <div className="keyrow">
            <input
              type="text"
              value={p.model}
              aria-label={`${p.provider} model`}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  chat: {
                    ...settings.chat,
                    providers: settings.chat.providers.map((x) =>
                      x.provider === p.provider ? { ...x, model: e.target.value } : x,
                    ),
                  },
                })
              }
              onBlur={(e) =>
                run(() => api.saveChat({ provider: p.provider, model: e.target.value }), 'Model saved')
              }
            />
          </div>
        </section>
      ))}

      <section className="field">
        <label>Discogs tools</label>
        <p className="fieldhelp">
          {settings.chat.mcpUrl
            ? `Connected through ${settings.chat.mcpUrl}. Set by MCP_URL.`
            : 'No MCP server configured, so chat answers from the local index only. Set MCP_URL to add pressing and marketplace lookups.'}
        </p>
      </section>
    </>
  );
}
