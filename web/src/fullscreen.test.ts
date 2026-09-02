import { describe, it, expect, vi } from 'vitest';
import {
  enterFullscreen,
  exitFullscreen,
  fullscreenSupported,
  isFullscreen,
  onFullscreenChange,
  toggleFullscreen,
} from './fullscreen';

/**
 * A stand-in document. The point of these tests is the prefix handling and,
 * more importantly, that state is always read back from the document rather
 * than remembered — iPadOS drops out of fullscreen on its own when a text
 * input takes focus, and this app focuses one every time you search.
 */
function fakeDoc(options: {
  prefixed?: boolean;
  enabled?: boolean;
  element?: Element | null;
} = {}) {
  const { prefixed = false, enabled = true, element = null } = options;
  const request = vi.fn(async () => undefined);
  const exit = vi.fn(async () => undefined);
  const listeners = new Map<string, Set<() => void>>();

  const documentElement = prefixed
    ? { webkitRequestFullscreen: request }
    : { requestFullscreen: request };

  const doc = {
    documentElement,
    ...(prefixed
      ? { webkitFullscreenEnabled: enabled, webkitFullscreenElement: element, webkitExitFullscreen: exit }
      : { fullscreenEnabled: enabled, fullscreenElement: element, exitFullscreen: exit }),
    addEventListener: (name: string, fn: () => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
    },
    removeEventListener: (name: string, fn: () => void) => listeners.get(name)?.delete(fn),
  } as unknown as Document;

  const fire = (name: string) => listeners.get(name)?.forEach((fn) => fn());
  const listenerCount = () =>
    [...listeners.values()].reduce((total, set) => total + set.size, 0);

  return { doc, request, exit, fire, listenerCount };
}

describe('fullscreenSupported', () => {
  it('sees the unprefixed API', () => {
    expect(fullscreenSupported(fakeDoc().doc)).toBe(true);
  });

  it('sees the webkit API, which is what older iPads have', () => {
    expect(fullscreenSupported(fakeDoc({ prefixed: true }).doc)).toBe(true);
  });

  it('falls back to the method when the enabled flag is missing', () => {
    // Some browsers expose requestFullscreen without fullscreenEnabled.
    const { doc } = fakeDoc({ enabled: false });
    expect(fullscreenSupported(doc)).toBe(true);
  });

  it('reports no support when neither spelling exists', () => {
    const bare = { documentElement: {} } as unknown as Document;
    expect(fullscreenSupported(bare)).toBe(false);
  });
});

describe('isFullscreen', () => {
  it('is false with no fullscreen element', () => {
    expect(isFullscreen(fakeDoc().doc)).toBe(false);
  });

  it('is true when the document says so', () => {
    const el = {} as Element;
    expect(isFullscreen(fakeDoc({ element: el }).doc)).toBe(true);
    expect(isFullscreen(fakeDoc({ prefixed: true, element: el }).doc)).toBe(true);
  });
});

describe('entering and leaving', () => {
  it('requests fullscreen on the element', async () => {
    const { doc, request } = fakeDoc();
    await enterFullscreen(doc.documentElement, doc);
    expect(request).toHaveBeenCalledOnce();
  });

  it('uses the webkit spelling when that is all there is', async () => {
    const { doc, request } = fakeDoc({ prefixed: true });
    await enterFullscreen(doc.documentElement, doc);
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not re-request when already fullscreen', async () => {
    const { doc, request } = fakeDoc({ element: {} as Element });
    await enterFullscreen(doc.documentElement, doc);
    expect(request).not.toHaveBeenCalled();
  });

  it('does not exit when not fullscreen', async () => {
    const { doc, exit } = fakeDoc();
    await exitFullscreen(doc);
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits when it is', async () => {
    const { doc, exit } = fakeDoc({ element: {} as Element });
    await exitFullscreen(doc);
    expect(exit).toHaveBeenCalledOnce();
  });

  it('does nothing at all on a browser without the API', async () => {
    const bare = { documentElement: {} } as unknown as Document;
    await expect(enterFullscreen(bare.documentElement, bare)).resolves.toBeUndefined();
    await expect(exitFullscreen(bare)).resolves.toBeUndefined();
  });
});

describe('toggle', () => {
  it('enters from windowed', async () => {
    const { doc, request, exit } = fakeDoc();
    await toggleFullscreen(doc.documentElement, doc);
    expect(request).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  /**
   * The one that matters. If the toggle flipped a remembered boolean instead
   * of reading the document, a fullscreen exit the app never asked for — Esc,
   * or an iPad input taking focus — would leave the button one press out of
   * step, and it would try to exit something already exited.
   */
  it('reads the document rather than a remembered flag', async () => {
    const { doc, request, exit } = fakeDoc({ element: {} as Element });
    await toggleFullscreen(doc.documentElement, doc);
    expect(exit).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('onFullscreenChange', () => {
  it('hears both event spellings', () => {
    const { doc, fire } = fakeDoc();
    const seen = vi.fn();
    onFullscreenChange(seen, doc);

    fire('fullscreenchange');
    fire('webkitfullscreenchange');
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes cleanly, leaving nothing behind', () => {
    const { doc, fire, listenerCount } = fakeDoc();
    const seen = vi.fn();
    const off = onFullscreenChange(seen, doc);
    expect(listenerCount()).toBe(2);

    off();
    expect(listenerCount()).toBe(0);
    fire('fullscreenchange');
    expect(seen).not.toHaveBeenCalled();
  });
});
