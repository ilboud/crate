import { useEffect, useState } from 'react';
import { api, coverUrl, duration, totalDuration, type Album, type AlbumCard } from '../api';
import { Sleeve } from './Sleeve';

/**
 * One record, opened.
 *
 * The signature: the disc slides out of the sleeve. A multi-disc set fans one
 * disc per record, so the format is legible before you read a word — and it is
 * exactly what the per-side tracklist beneath describes.
 */

/** Deterministic label colour per release, in the register of real labels. */
const LABEL_COLOURS = ['#b5442c', '#1d3f6e', '#1f5c3a', '#7a2f4e', '#8a6a1f', '#2f2f2f'];
const labelColour = (id: number) => LABEL_COLOURS[id % LABEL_COLOURS.length]!;

function discCount(album: Album): number {
  const fromFormat = album.formats.reduce((max, f) => Math.max(max, f.qty || 1), 1);
  const fromTracks = album.discs.length;
  return Math.max(1, Math.min(Math.max(fromFormat, fromTracks), 4));
}

export function AlbumDetail({
  id,
  onClose,
  onOpen,
}: {
  id: number;
  onClose: () => void;
  onOpen: (album: AlbumCard) => void;
}) {
  const [album, setAlbum] = useState<Album | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setAlbum(null);
    setError(null);
    api
      .album(id)
      .then((a) => { if (live) setAlbum(a); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (error) {
    return (
      <div className="sheet">
        <div className="sheet-inner">
          <button className="backbtn" onClick={onClose}>&larr; Back to the crate</button>
          <p className="empty">{error}</p>
        </div>
      </div>
    );
  }

  if (!album) {
    return (
      <div className="sheet">
        <div className="sheet-inner">
          <button className="backbtn" onClick={onClose}>&larr; Back to the crate</button>
          <p className="empty">Pulling the record…</p>
        </div>
      </div>
    );
  }

  const catno = album.labels.find((l) => l.catno)?.catno ?? null;
  const discs = discCount(album);

  return (
    <div className="sheet">
      <div className="sheet-inner">
        <button className="backbtn" onClick={onClose}>&larr; Back to the crate</button>

        <div className="hero">
          <div className="package">
            {Array.from({ length: discs }, (_, i) => (
              <div
                key={i}
                className="disc"
                aria-hidden="true"
                style={{ ['--label-color' as string]: labelColour(album.id + i) }}
              >
                <span>{catno ?? album.title}</span>
              </div>
            ))}
            <Sleeve
              src={coverUrl(album.cover_path ?? album.thumb_path)}
              title={album.title}
              artist={album.artist}
            />
          </div>

          <div className="facts">
            <p className="artist">{album.artist ?? 'Unknown artist'}</p>
            <h1>{album.title}</h1>

            <dl className="specs">
              {album.year != null && (<><dt>Year</dt><dd>{album.year}</dd></>)}
              {album.labels.length > 0 && (
                <>
                  <dt>Label</dt>
                  <dd>
                    {album.labels.map((l) => l.name).join(' / ')}
                    {catno && <> · {catno}</>}
                  </dd>
                </>
              )}
              {album.formats.length > 0 && (
                <>
                  <dt>Format</dt>
                  <dd>
                    {album.formats
                      .map((f) => [f.qty > 1 ? `${f.qty}×` : '', f.name, f.descriptions.join(', ')]
                        .filter(Boolean).join(' '))
                      .join(' + ')}
                  </dd>
                </>
              )}
              {album.copies > 1 && (<><dt>Copies</dt><dd>{album.copies} owned</dd></>)}
            </dl>

            <div className="chips">
              {album.primary_group && <span className="chip group">{album.primary_group}</span>}
              {album.styles.map((s) => <span className="chip" key={s}>{s}</span>)}
            </div>
          </div>
        </div>

        {album.discs.map((disc) => (
          <section className="disc-block" key={disc.disc}>
            {album.discs.length > 1 && <h2 className="disc-head">Disc {disc.disc}</h2>}
            {disc.sides.map((side) => (
              <div key={`${disc.disc}-${side.side ?? 'x'}`}>
                <h3 className="side-head">
                  {side.side ? `Side ${side.side}` : `Disc ${disc.disc}`}
                  {totalDuration(side.tracks) && <> · {totalDuration(side.tracks)}</>}
                </h3>
                {side.tracks.map((t) => (
                  <div className={`track${t.index_on_side == null ? ' whole' : ''}`} key={t.id}>
                    {/* A track filling a whole side carries no number. */}
                    <span className="no">{t.index_on_side ?? '—'}</span>
                    <span className="title">{t.title}</span>
                    <span className="dur">{duration(t.duration_sec)}</span>
                  </div>
                ))}
              </div>
            ))}
          </section>
        ))}

        {album.similar.length > 0 && (
          <section className="shelf">
            <h2 className="shelf-head">You might also like</h2>
            <p className="shelf-why">From your own shelves, by other artists</p>
            <Strip albums={album.similar} onOpen={onOpen} />
          </section>
        )}

        {album.moreByArtist.length > 0 && (
          <section className="shelf">
            <h2 className="shelf-head">More by {album.artist}</h2>
            <p className="shelf-why">{album.moreByArtist.length} more in the crate</p>
            <Strip albums={album.moreByArtist} onOpen={onOpen} />
          </section>
        )}
      </div>
    </div>
  );
}

function Strip({ albums, onOpen }: { albums: AlbumCard[]; onOpen: (a: AlbumCard) => void }) {
  return (
    <div className="strip">
      {albums.map((a) => (
        <button className="strip-card" key={a.id} onClick={() => onOpen(a)}>
          <Sleeve src={coverUrl(a.cover_path ?? a.thumb_path)} title={a.title} artist={a.artist} />
          <b>{a.title}</b>
          <span>{a.artist}</span>
          {a.reason && <span>{a.reason}</span>}
        </button>
      ))}
    </div>
  );
}
