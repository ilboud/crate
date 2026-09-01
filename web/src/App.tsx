import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, bestArt, FEEL_DEFAULTS, type AlbumCard, type FeelSettings, type Group, type Stats } from './api';
import { CoverFlow } from './components/CoverFlow';
import { AlbumDetail } from './components/AlbumDetail';
import { Search } from './components/Search';
import { Chat } from './components/Chat';
import { Settings } from './components/Settings';
import { Sleeve } from './components/Sleeve';

type View = 'crate' | 'grid' | 'search' | 'chat' | 'settings';
type Sort = 'artist' | 'year' | 'added' | 'title';

const SORT_LABELS: Array<[Sort, string]> = [
  ['artist', 'Artist'],
  ['year', 'Year'],
  ['added', 'Added'],
  ['title', 'Title'],
];

export default function App() {
  const [view, setView] = useState<View>('crate');
  const [groups, setGroups] = useState<Group[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [albums, setAlbums] = useState<AlbumCard[]>([]);
  const [group, setGroup] = useState<string | undefined>();
  const [artist, setArtist] = useState<string | undefined>();
  const [sort, setSort] = useState<Sort>('artist');
  const [index, setIndex] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const [style, setStyle] = useState<string | undefined>();
  const [styles, setStyles] = useState<Array<{ style: string; count: number }>>([]);
  const [query, setQuery] = useState('');
  const [feel, setFeel] = useState<FeelSettings>(FEEL_DEFAULTS);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshMeta = useCallback(() => {
    void api.groups().then(setGroups).catch(() => undefined);
    void api.stats().then(setStats).catch(() => undefined);
  }, []);

  // Crate feel is server-side so it follows you between the phone and laptop.
  useEffect(() => {
    void api.settings().then((s) => setFeel(s.feel)).catch(() => undefined);
  }, []);

  useEffect(refreshMeta, [refreshMeta]);

  useEffect(() => {
    let live = true;
    setLoadError(null);
    api
      .browse({ group, style, artist, sort })
      .then((a) => {
        if (!live) return;
        setAlbums(a);
        setIndex(0);
      })
      .catch((e: Error) => { if (live) setLoadError(e.message); });
    return () => { live = false; };
  }, [group, style, artist, sort]);

  // Styles are scoped to the chosen group, so the second dropdown only ever
  // offers styles that can actually narrow the current list.
  useEffect(() => {
    let live = true;
    api.styles(group).then((s) => { if (live) setStyles(s); }).catch(() => undefined);
    return () => { live = false; };
  }, [group]);

  /** Changing the group invalidates the style under it. */
  const pickGroup = useCallback((name: string | undefined) => {
    setArtist(undefined);
    setStyle(undefined);
    setGroup(name);
  }, []);

  const open = useCallback((album: AlbumCard) => setOpenId(album.id), []);

  const visibleGroups = useMemo(() => groups.filter((g) => !g.hidden && g.count > 0), [groups]);

  const filterLabel = artist ?? style ?? group ?? 'The whole crate';

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">
          Records<span>.</span>
        </div>
        {stats && (
          <div className="count">
            {stats.releases}
            {stats.copies !== stats.releases && ` · ${stats.copies} copies`}
          </div>
        )}

        <div className="spacer" />

        <div className="searchbox">
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value.trim().length >= 2) setView('search');
              else if (view === 'search') setView('crate');
            }}
            placeholder="Search records, songs, artists"
            aria-label="Search records, songs and artists"
            type="search"
          />
        </div>

        <button className="navbtn" aria-pressed={view === 'crate'} onClick={() => { setView('crate'); setOpenId(null); }}>
          Crate
        </button>
        <button className="navbtn" aria-pressed={view === 'grid'} onClick={() => { setView('grid'); setOpenId(null); }}>
          Shelf
        </button>
        <button className="navbtn" aria-pressed={view === 'chat'} onClick={() => { setView('chat'); setOpenId(null); }}>
          Ask
        </button>
        <button className="navbtn" aria-pressed={view === 'settings'} onClick={() => { setView('settings'); setOpenId(null); }}>
          Settings
        </button>
      </header>

      <main className="main">
        {openId !== null && (
          <AlbumDetail id={openId} onClose={() => setOpenId(null)} onOpen={open} />
        )}

        {openId === null && view === 'search' && (
          <div className="grid-page">
            <Search
              query={query}
              onOpen={open}
              onArtist={(name) => {
                setArtist(name);
                setGroup(undefined);
                setQuery('');
                setView('grid');
              }}
            />
          </div>
        )}

        {openId === null && view === 'chat' && <Chat />}

        {openId === null && view === 'settings' && (
          <Settings
            onFeelChange={setFeel}
            onTaxonomyChange={() => {
              refreshMeta();
              void api.browse({ group, style, artist, sort }).then(setAlbums).catch(() => undefined);
            }}
          />
        )}

        {openId === null && view === 'crate' && (
          <>
            {loadError && <p className="empty">{loadError}</p>}
            {!loadError && albums.length === 0 && (
              <p className="empty">
                Nothing here yet. Run <code>npm run sync</code> to pull the collection in.
              </p>
            )}
            {!loadError && albums.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <CoverFlow albums={albums} index={index} onIndexChange={setIndex} onOpen={open} feel={feel} />
                <GenreRail
                  groups={visibleGroups}
                  active={group}
                  onPick={pickGroup}
                />
              </div>
            )}
          </>
        )}

        {openId === null && view === 'grid' && (
          <div className="grid-page">
            <div className="section-head">
              <h2>{filterLabel}</h2>
              <em>{albums.length} records</em>
              <div className="sortbar">
                {SORT_LABELS.map(([key, label]) => (
                  <button key={key} aria-pressed={sort === key} onClick={() => setSort(key)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="filterbar">
              <label>
                <span>Genre</span>
                <select
                  value={group ?? ''}
                  onChange={(e) => pickGroup(e.target.value || undefined)}
                >
                  <option value="">All genres</option>
                  {groups
                    .filter((g) => g.count > 0)
                    .map((g) => (
                      <option key={g.name} value={g.name}>
                        {g.name} ({g.count})
                      </option>
                    ))}
                </select>
              </label>

              <label>
                <span>Style</span>
                <select
                  value={style ?? ''}
                  onChange={(e) => setStyle(e.target.value || undefined)}
                  disabled={styles.length === 0}
                >
                  <option value="">{group ? `All ${group} styles` : 'All styles'}</option>
                  {styles.map((s) => (
                    <option key={s.style} value={s.style}>
                      {s.style} ({s.count})
                    </option>
                  ))}
                </select>
              </label>

              {artist && <span className="activefilter">Artist: {artist}</span>}

              {(group || style || artist) && (
                <button
                  className="navbtn"
                  onClick={() => { setGroup(undefined); setStyle(undefined); setArtist(undefined); }}
                >
                  Clear
                </button>
              )}
            </div>
            <div className="grid">
              {albums.map((a) => (
                <button className="strip-card" key={a.id} onClick={() => open(a)}>
                  <Sleeve src={bestArt(a)} title={a.title} artist={a.artist} />
                  <b>{a.title}</b>
                  <span>{a.artist}</span>
                  <span>{a.year ?? ''}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function GenreRail({
  groups,
  active,
  onPick,
}: {
  groups: Group[];
  active: string | undefined;
  onPick: (name: string | undefined) => void;
}) {
  return (
    <nav className="rail" aria-label="Filter by genre">
      <button aria-pressed={active === undefined} onClick={() => onPick(undefined)}>
        All
      </button>
      {groups.map((g) => (
        <button
          key={g.name}
          aria-pressed={active === g.name}
          onClick={() => onPick(active === g.name ? undefined : g.name)}
        >
          {g.name} <em>{g.count}</em>
        </button>
      ))}
    </nav>
  );
}
