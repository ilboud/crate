import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, coverUrl, type AlbumCard, type Group, type Stats } from './api';
import { CoverFlow } from './components/CoverFlow';
import { AlbumDetail } from './components/AlbumDetail';
import { Search } from './components/Search';
import { Chat } from './components/Chat';
import { AdminTaxonomy } from './components/AdminTaxonomy';
import { Sleeve } from './components/Sleeve';

type View = 'crate' | 'grid' | 'search' | 'chat' | 'admin';
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
  const [query, setQuery] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshMeta = useCallback(() => {
    void api.groups().then(setGroups).catch(() => undefined);
    void api.stats().then(setStats).catch(() => undefined);
  }, []);

  useEffect(refreshMeta, [refreshMeta]);

  useEffect(() => {
    let live = true;
    setLoadError(null);
    api
      .browse({ group, artist, sort })
      .then((a) => {
        if (!live) return;
        setAlbums(a);
        setIndex(0);
      })
      .catch((e: Error) => { if (live) setLoadError(e.message); });
    return () => { live = false; };
  }, [group, artist, sort]);

  const open = useCallback((album: AlbumCard) => setOpenId(album.id), []);

  const visibleGroups = useMemo(() => groups.filter((g) => !g.hidden && g.count > 0), [groups]);

  const filterLabel = artist ?? group ?? 'The whole crate';

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
        <button className="navbtn" aria-pressed={view === 'admin'} onClick={() => { setView('admin'); setOpenId(null); }}>
          Genres
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

        {openId === null && view === 'admin' && (
          <AdminTaxonomy
            onChanged={() => {
              refreshMeta();
              void api.browse({ group, artist, sort }).then(setAlbums).catch(() => undefined);
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
                <CoverFlow albums={albums} index={index} onIndexChange={setIndex} onOpen={open} />
                <GenreRail
                  groups={visibleGroups}
                  active={group}
                  onPick={(name) => {
                    setArtist(undefined);
                    setGroup(name);
                  }}
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
            {(group || artist) && (
              <div style={{ padding: '10px 24px 0' }}>
                <button
                  className="navbtn"
                  onClick={() => { setGroup(undefined); setArtist(undefined); }}
                >
                  Clear filter
                </button>
              </div>
            )}
            <div className="grid">
              {albums.map((a) => (
                <button className="strip-card" key={a.id} onClick={() => open(a)}>
                  <Sleeve src={coverUrl(a.thumb_path ?? a.cover_path)} title={a.title} artist={a.artist} />
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
