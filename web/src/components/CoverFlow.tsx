import { useCallback, useEffect, useRef, useState } from 'react';
import type { AlbumCard } from '../api';
import { coverUrl } from '../api';
import { Sleeve } from './Sleeve';

/**
 * Cover flow. CSS 3D transforms driven by pointer events rather than a
 * carousel library — libraries fight touch handling on iOS, and the effect is
 * only rotateY + translateZ on the neighbours.
 *
 * Neighbour count adapts to the viewport: a phone shows 2 each side, a laptop
 * 5, so the shelf feels full without crowding a small screen.
 */

interface Props {
  albums: AlbumCard[];
  index: number;
  onIndexChange: (i: number) => void;
  onOpen: (album: AlbumCard) => void;
}

function useNeighbours(): { visible: number; sleeve: number } {
  const [state, setState] = useState({ visible: 3, sleeve: 260 });
  useEffect(() => {
    const measure = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const visible = w < 560 ? 2 : w < 1024 ? 4 : 5;
      // Leave room for the caption and genre rail below.
      // Tablet portrait is wide AND tall, so a desktop width ratio leaves the
      // crate floating in dead space; give it half the width instead.
      const widthFactor = w < 560 ? 0.74 : w < 1024 ? 0.5 : 0.38;
      const sleeve = Math.min(w * widthFactor, h * 0.42, 440);
      setState({ visible, sleeve: Math.round(sleeve) });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, []);
  return state;
}

export function CoverFlow({ albums, index, onIndexChange, onOpen }: Props) {
  const { visible, sleeve } = useNeighbours();
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; startIndex: number; moved: boolean; hit: number | null } | null>(null);
  const wheelAcc = useRef(0);

  const clamp = useCallback(
    (i: number) => Math.max(0, Math.min(albums.length - 1, i)),
    [albums.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowRight') { onIndexChange(clamp(index + 1)); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { onIndexChange(clamp(index - 1)); e.preventDefault(); }
      else if (e.key === 'Home') { onIndexChange(0); e.preventDefault(); }
      else if (e.key === 'End') { onIndexChange(albums.length - 1); e.preventDefault(); }
      else if (e.key === 'Enter' && albums[index]) { onOpen(albums[index]!); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, albums, clamp, onIndexChange, onOpen]);

  const onPointerDown = (e: React.PointerEvent) => {
    // Record which sleeve is under the pointer NOW: setPointerCapture
    // retargets every later event to the stage, so pointerup cannot tell.
    const card = (e.target as HTMLElement).closest('[data-index]');
    drag.current = {
      x: e.clientX,
      startIndex: index,
      moved: false,
      hit: card ? Number(card.getAttribute('data-index')) : null,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 6) d.moved = true;
    const step = sleeve * 0.42;
    onIndexChange(clamp(d.startIndex - Math.round(dx / step)));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    // A tap that never moved is a selection, not a flick. Tapping the
    // centred sleeve opens it; tapping a neighbour brings it to the front.
    if (d && !d.moved && d.hit !== null) {
      if (d.hit === index) { if (albums[d.hit]) onOpen(albums[d.hit]!); }
      else onIndexChange(d.hit);
    }
  };

  // Trackpads emit many small deltas; accumulate so one gesture is one step.
  const onWheel = (e: React.WheelEvent) => {
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    wheelAcc.current += delta;
    if (Math.abs(wheelAcc.current) > 40) {
      onIndexChange(clamp(index + Math.sign(wheelAcc.current)));
      wheelAcc.current = 0;
    }
  };

  const current = albums[index];

  return (
    <div className="flow">
      <div
        className="flow-stage"
        ref={stage}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        style={{ ['--sleeve' as string]: `${sleeve}px` }}
        role="listbox"
        aria-label="Records"
        aria-activedescendant={current ? `flow-${current.id}` : undefined}
        tabIndex={0}
      >
        {albums.map((album, i) => {
          const offset = i - index;
          if (Math.abs(offset) > visible) return null;

          const dir = Math.sign(offset);
          const abs = Math.abs(offset);
          // Neighbours angle away and recede; the centred sleeve stays flat
          // and forward so its art is never distorted.
          const x = dir * (sleeve * 0.31 + (abs - 1) * sleeve * 0.145) * (abs ? 1 : 0);
          const z = abs === 0 ? 0 : -140 - (abs - 1) * 60;
          const rot = abs === 0 ? 0 : dir * -52;

          return (
            <div
              key={album.id}
              id={`flow-${album.id}`}
              className="flow-item"
              data-index={i}
              role="option"
              aria-selected={abs === 0}
              style={{
                transform: `translate3d(${x}px, 0, ${z}px) rotateY(${rot}deg) scale(${abs === 0 ? 1 : 0.92})`,
                zIndex: 100 - abs,
                opacity: abs > visible - 1 ? 0.25 : 1,
              }}
            >
              <Sleeve
                src={coverUrl(album.thumb_path ?? album.cover_path)}
                title={album.title}
                artist={album.artist}
              />
            </div>
          );
        })}
      </div>

      <div className="flow-caption">
        {current && (
          <>
            <p className="artist">{current.artist ?? 'Unknown artist'}</p>
            <h1>{current.title}</h1>
            <p className="meta">
              {current.year ?? '—'}
              <i>/</i>
              {current.primary_group ?? 'Unsorted'}
              {current.copies > 1 && (
                <>
                  <i>/</i>
                  {current.copies} copies
                </>
              )}
            </p>
          </>
        )}
      </div>

      <div className="flow-scrub">
        <span className="count">{albums.length ? index + 1 : 0}</span>
        <input
          type="range"
          min={0}
          max={Math.max(0, albums.length - 1)}
          value={index}
          onChange={(e) => onIndexChange(Number(e.target.value))}
          aria-label="Scrub through the crate"
        />
        <span className="count">{albums.length}</span>
      </div>
    </div>
  );
}
