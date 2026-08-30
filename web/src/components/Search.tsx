import { useEffect, useState } from 'react';
import { api, coverUrl, duration, type AlbumCard, type SearchResults } from '../api';

/**
 * One query, three answers. A song hit names the record, disc and side it
 * lives on — the same song on two pressings returns both, which is the point.
 */
export function Search({
  query,
  onOpen,
  onArtist,
}: {
  query: string;
  onOpen: (album: AlbumCard) => void;
  onArtist: (name: string) => void;
}) {
  const [results, setResults] = useState<SearchResults | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) { setResults(null); return; }
    let live = true;
    setBusy(true);
    // Debounced so typing does not fire a query per keystroke.
    const t = setTimeout(() => {
      api
        .search(query)
        .then((r) => { if (live) setResults(r); })
        .catch(() => { if (live) setResults(null); })
        .finally(() => { if (live) setBusy(false); });
    }, 180);
    return () => { live = false; clearTimeout(t); };
  }, [query]);

  if (query.trim().length < 2) {
    return <p className="empty">Search for a record, a song, or an artist.</p>;
  }
  if (!results) {
    return <p className="empty">{busy ? 'Searching…' : 'Nothing found.'}</p>;
  }

  const total = results.albums.length + results.tracks.length + results.artists.length;
  if (total === 0) {
    return <p className="empty">Nothing in the crate matches “{query}”.</p>;
  }

  return (
    <div className="results">
      {results.albums.length > 0 && (
        <section className="res-group">
          <h2 className="shelf-head">Records</h2>
          <p className="shelf-why">{results.albums.length} found</p>
          {results.albums.map((a) => (
            <button className="res-row" key={a.id} onClick={() => onOpen(a)}>
              <Thumb path={a.thumb_path ?? a.cover_path} alt={a.title} />
              <span>
                <span className="who">{a.title}</span>
                <span className="where">{a.artist} · {a.year ?? '—'}</span>
              </span>
              <span className="side">{a.primary_group ?? ''}</span>
            </button>
          ))}
        </section>
      )}

      {results.tracks.length > 0 && (
        <section className="res-group">
          <h2 className="shelf-head">Songs</h2>
          <p className="shelf-why">Every record in the crate that carries the track</p>
          {results.tracks.map((t) => (
            <button
              className="res-row"
              key={t.id}
              onClick={() => onOpen({ id: t.release_id } as AlbumCard)}
            >
              <Thumb path={t.thumb_path} alt={t.album} />
              <span>
                <span className="who">{t.title}</span>
                <span className="where">
                  {t.artist} · {t.album}
                  {t.year ? ` · ${t.year}` : ''}
                  {t.duration_sec != null ? ` · ${duration(t.duration_sec)}` : ''}
                </span>
              </span>
              <span className="side">
                {t.side ? `Side ${t.side}` : `Disc ${t.disc}`}
                {t.index_on_side != null ? ` · ${t.index_on_side}` : ''}
              </span>
            </button>
          ))}
        </section>
      )}

      {results.artists.length > 0 && (
        <section className="res-group">
          <h2 className="shelf-head">Artists</h2>
          <p className="shelf-why">{results.artists.length} found</p>
          {results.artists.map((a) => (
            <button className="res-row" key={a.name} onClick={() => onArtist(a.name)}>
              <span aria-hidden="true" />
              <span><span className="who">{a.name}</span></span>
              <span className="side">{a.count} {a.count === 1 ? 'record' : 'records'}</span>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

function Thumb({ path, alt }: { path: string | null; alt: string }) {
  const src = coverUrl(path);
  if (!src) return <span aria-hidden="true" />;
  return <img src={src} alt={alt} loading="lazy" />;
}
