import { useState } from 'react';

/**
 * An album sleeve. Falls back to a printed-looking blank when art is missing
 * rather than an icon — a record with no cover on file still reads as a record
 * in the crate.
 */
export function Sleeve({
  src,
  title,
  artist,
}: {
  src: string | null;
  title: string;
  artist: string | null;
}) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div className="sleeve">
        <div className="sleeve-blank">
          <b>{title}</b>
          <span>{artist ?? '—'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="sleeve">
      <img
        src={src}
        alt={`${title} by ${artist ?? 'unknown artist'}`}
        loading="lazy"
        draggable={false}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
