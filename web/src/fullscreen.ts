import { useCallback, useEffect, useState } from 'react';

/**
 * Browser fullscreen, across the vendor prefixes that still matter.
 *
 * Safari only unprefixed this in 16.4 (iPadOS) and 17.4 (iPhone), and the
 * collection is browsed on an iPad, so the webkit spelling stays.
 *
 * The important rule: never track fullscreen state ourselves. The browser can
 * leave fullscreen without asking — Esc, the system gesture, and on iPadOS
 * merely focusing a text input, which this app does every time you touch the
 * search box. State is therefore read back from the document on every change
 * event, so the button always describes what you are actually looking at
 * rather than what we last requested.
 */

type FsElement = Element & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenEnabled?: boolean;
};

/** Both spellings; browsers fire one or the other, never both. */
const EVENTS = ['fullscreenchange', 'webkitfullscreenchange'] as const;

export function fullscreenSupported(doc: FsDocument = document): boolean {
  if (doc.fullscreenEnabled || doc.webkitFullscreenEnabled) return true;
  const el = doc.documentElement as FsElement;
  return typeof el?.requestFullscreen === 'function' ||
    typeof el?.webkitRequestFullscreen === 'function';
}

export function isFullscreen(doc: FsDocument = document): boolean {
  return Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement);
}

export async function enterFullscreen(
  el: FsElement,
  doc: FsDocument = document,
): Promise<void> {
  if (isFullscreen(doc)) return;
  if (typeof el.requestFullscreen === 'function') await el.requestFullscreen();
  else if (typeof el.webkitRequestFullscreen === 'function') await el.webkitRequestFullscreen();
}

export async function exitFullscreen(doc: FsDocument = document): Promise<void> {
  if (!isFullscreen(doc)) return;
  if (typeof doc.exitFullscreen === 'function') await doc.exitFullscreen();
  else if (typeof doc.webkitExitFullscreen === 'function') await doc.webkitExitFullscreen();
}

export async function toggleFullscreen(
  el: FsElement,
  doc: FsDocument = document,
): Promise<void> {
  if (isFullscreen(doc)) await exitFullscreen(doc);
  else await enterFullscreen(el, doc);
}

/** Subscribe to fullscreen changes. Returns the unsubscribe function. */
export function onFullscreenChange(
  handler: () => void,
  doc: FsDocument = document,
): () => void {
  for (const event of EVENTS) doc.addEventListener(event, handler);
  return () => {
    for (const event of EVENTS) doc.removeEventListener(event, handler);
  };
}

export interface Fullscreen {
  /** False on a browser that cannot do it, so the button can be hidden. */
  supported: boolean;
  active: boolean;
  toggle: () => void;
}

export function useFullscreen(): Fullscreen {
  const [active, setActive] = useState(() => isFullscreen());
  const [supported] = useState(() => fullscreenSupported());

  useEffect(() => onFullscreenChange(() => setActive(isFullscreen())), []);

  const toggle = useCallback(() => {
    // A rejection here is normal — the request must come from a user gesture,
    // and an embedded frame may forbid it outright. The change event decides
    // the state either way, so there is nothing to roll back.
    void toggleFullscreen(document.documentElement).catch(() => undefined);
  }, []);

  return { supported, active, toggle };
}
