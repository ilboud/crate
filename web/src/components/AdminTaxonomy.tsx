import { useEffect, useState, type ReactNode } from 'react';
import { api, type Taxonomy } from '../api';

/**
 * Taxonomy editor. Deliberately plain — this is a workbench, not a showpiece,
 * and the crate itself is where the design lives.
 *
 * Every change re-derives group assignment for the whole collection
 * immediately, so what you see in the crate always matches these rules.
 */
export function AdminTaxonomy({
  onChanged,
  embedded = false,
}: {
  onChanged: () => void;
  /** Rendered inside Settings, which already provides the scroll container. */
  embedded?: boolean;
}) {
  const [tax, setTax] = useState<Taxonomy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState('');

  const load = () => api.taxonomy().then(setTax).catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);

  async function mutate(fn: () => Promise<unknown>, note: string) {
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
      setSaved(note);
      setTimeout(() => setSaved(null), 2400);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Settings already supplies the scroll container, so when embedded this
  // renders only the inner column.
  const Frame = ({ children }: { children: ReactNode }) =>
    embedded ? (
      <div className="admin-inner">{children}</div>
    ) : (
      <div className="admin">
        <div className="admin-inner">{children}</div>
      </div>
    );

  if (error && !tax) return <Frame><p className="empty">{error}</p></Frame>;
  if (!tax) return <Frame><p className="empty">Loading the taxonomy…</p></Frame>;

  const stylesOf = (groupId: number) =>
    tax.styles.filter((s) => s.group_id === groupId).sort((a, b) => b.count - a.count);

  return (
    <Frame>
        <h2>Genre groups</h2>
        <p className="lede">
          Records are filed by the styles Discogs assigns them. Move a style to a different group
          and every record carrying it is re-filed straight away.
        </p>

        {error && <div className="warn">{error}</div>}
        {saved && <p className="savedmark">{saved}</p>}

        {tax.unassigned.length > 0 && (
          <div className="warn">
            <b>{tax.unassigned.length} style(s) belong to no group.</b> Records carrying only these
            fall back to their Discogs genre.
            <div className="grp-styles" style={{ padding: '8px 0 0' }}>
              {tax.unassigned.map((u) => (
                <span className="style-pill" key={u.style}>
                  {u.style} <em>{u.count}</em>
                  <select
                    defaultValue=""
                    aria-label={`Assign ${u.style} to a group`}
                    onChange={(e) =>
                      e.target.value &&
                      mutate(() => api.moveStyle(u.style, Number(e.target.value)), `${u.style} filed`)
                    }
                  >
                    <option value="">File under…</option>
                    {tax.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </span>
              ))}
            </div>
          </div>
        )}

        {tax.groups.map((g) => (
          <div className="grp" key={g.id}>
            <div className="grp-head">
              <b>{g.name}</b>
              <em>{stylesOf(g.id).length} styles</em>
              <span style={{ flex: 1 }} />
              <button
                className="navbtn"
                onClick={() => {
                  const name = prompt(`Rename “${g.name}” to:`, g.name);
                  if (name && name !== g.name) void mutate(() => api.renameGroup(g.id, name), 'Group renamed');
                }}
              >
                Rename
              </button>
              <button
                className="navbtn"
                onClick={() => {
                  if (confirm(`Delete “${g.name}”? Its styles become unassigned and its records are re-filed.`)) {
                    void mutate(() => api.deleteGroup(g.id), 'Group deleted');
                  }
                }}
              >
                Delete
              </button>
            </div>
            <div className="grp-styles">
              {stylesOf(g.id).length === 0 && <span className="style-pill">No styles</span>}
              {stylesOf(g.id).map((s) => (
                <span className="style-pill" key={s.style}>
                  {s.style} <em>{s.count}</em>
                  <select
                    value={g.id}
                    aria-label={`Group for ${s.style}`}
                    onChange={(e) =>
                      mutate(
                        () => api.moveStyle(s.style, e.target.value ? Number(e.target.value) : null),
                        `${s.style} moved`,
                      )
                    }
                  >
                    {tax.groups.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    <option value="">— unassign —</option>
                  </select>
                </span>
              ))}
            </div>
          </div>
        ))}

        <h2 style={{ marginTop: 26 }}>Add a group</h2>
        <form
          className="chat-form"
          style={{ padding: 0, border: 0, maxWidth: 460, marginInline: 0 }}
          onSubmit={(e) => {
            e.preventDefault();
            const name = newGroup.trim();
            if (!name) return;
            void mutate(() => api.createGroup(name), `“${name}” added`);
            setNewGroup('');
          }}
        >
          <input
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
            placeholder="e.g. Spiritual Jazz"
            aria-label="New group name"
          />
          <button type="submit" disabled={!newGroup.trim()}>Add</button>
        </form>

        <h2 style={{ marginTop: 26 }}>Hide small groups</h2>
        <p className="lede">
          Groups holding fewer than this many records are kept out of the crate’s genre bar. They
          stay findable through search. Currently {tax.hideGroupBelow}.
        </p>
        <div className="sortbar" style={{ marginLeft: 0 }}>
          {[0, 2, 3, 5, 10].map((n) => (
            <button
              key={n}
              aria-pressed={tax.hideGroupBelow === n}
              onClick={() => mutate(() => api.setHideBelow(n), `Threshold set to ${n}`)}
            >
              {n === 0 ? 'Show all' : `Under ${n}`}
            </button>
          ))}
        </div>
    </Frame>
  );
}
