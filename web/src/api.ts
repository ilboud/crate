export interface AlbumCard {
  id: number;
  title: string;
  artist: string | null;
  year: number | null;
  primary_group: string | null;
  thumb_path: string | null;
  cover_path: string | null;
  /** Higher-resolution art from iTunes or Cover Art Archive, when one matched. */
  hi_path: string | null;
  art_source: string | null;
  copies: number;
  score?: number;
  reason?: string;
}

export interface Track {
  id: number;
  title: string;
  disc: number;
  side: string | null;
  index_on_side: number | null;
  duration_sec: number | null;
  position_raw: string | null;
}

export interface Album extends AlbumCard {
  master_id: number | null;
  genres: string[];
  styles: string[];
  labels: Array<{ name: string; catno: string | null }>;
  formats: Array<{ name: string; qty: number; descriptions: string[] }>;
  instances: Array<{ instance_id: number; folder_id: number | null; date_added: string | null }>;
  discs: Array<{ disc: number; sides: Array<{ side: string | null; tracks: Track[] }> }>;
  similar: AlbumCard[];
  moreByArtist: AlbumCard[];
}

export interface Group {
  name: string;
  count: number;
  hidden: boolean;
  sort_order: number;
}

export interface TrackHit extends Track {
  album: string;
  artist: string | null;
  release_id: number;
  year: number | null;
  thumb_path: string | null;
}

export interface SearchResults {
  albums: AlbumCard[];
  tracks: TrackHit[];
  artists: Array<{ name: string; count: number }>;
}

export interface Stats {
  releases: number;
  copies: number;
  tracks: number;
  artists: number;
  lastSync: { started_at: string; finished_at: string | null; ok_count: number; failed_ids: string } | null;
}

export type Momentum = 'off' | 'low' | 'medium' | 'high';

export interface FeelSettings {
  sensitivity: number;
  momentum: Momentum;
  neighbours: number | 'auto';
}

export const FEEL_DEFAULTS: FeelSettings = {
  sensitivity: 0.42,
  momentum: 'medium',
  neighbours: 'auto',
};

export interface ProviderStatus {
  provider: 'anthropic' | 'openai';
  configured: boolean;
  /** Where the key in force comes from; null when none is set. */
  source: 'env' | 'stored' | null;
  /** Masked, e.g. "••••4f2a". Never the key itself. */
  hint: string | null;
  model: string;
  modelFromEnv: boolean;
  /** Anthropic only. Identifies a workspace; not a secret. */
  workspaceId?: string | null;
}

export interface AdminSettings {
  feel: FeelSettings;
  chat: {
    backend: 'anthropic' | 'openai';
    backendFromEnv: boolean;
    providers: ProviderStatus[];
    mcpUrl: string | null;
  };
}

export interface TaxonomyGroup { id: number; name: string; sort_order: number; hidden: number }
export interface TaxonomyStyle { style: string; group_id: number; count: number }
export interface Taxonomy {
  groups: TaxonomyGroup[];
  styles: TaxonomyStyle[];
  unassigned: Array<{ style: string; count: number }>;
  hideGroupBelow: number;
}

export type SyncSchedule = 'off' | 'daily' | 'weekly' | 'monthly';

export interface SyncStatus {
  available: boolean;
  reason: string | null;
  running: boolean;
  startedAt: string | null;
  progress: { done: number; total: number; label: string } | null;
  schedule: SyncSchedule;
  nextRunAt: string | null;
  last: {
    startedAt: string;
    finishedAt: string | null;
    okCount: number;
    failedIds: number[];
  } | null;
  lastResult: {
    added: number;
    removed: number;
    unchanged: number;
    items: number;
    failed: number[];
    durationMs: number;
  } | null;
  error: string | null;
}

export type DoubleKind = 'same-copy' | 'same-pressing' | 'reissue';

export interface DoubleCopy {
  releaseId: number;
  title: string;
  artist: string;
  year: number | null;
  format: string;
  catnos: string[];
  art: string | null;
  instances: Array<{ instanceId: number; folderId: number | null; dateAdded: string | null }>;
}

export interface DoubleGroup {
  key: string;
  kind: DoubleKind;
  why: string;
  copies: DoubleCopy[];
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  stats: () => json<Stats>('/api/stats'),
  groups: () => json<Group[]>('/api/groups'),
  styles: (group?: string) => json<Array<{ style: string; count: number }>>(`/api/styles${qs({ group })}`),
  browse: (o: { group?: string; style?: string; artist?: string; sort?: string }) =>
    json<AlbumCard[]>(`/api/browse${qs(o)}`),
  album: (id: number) => json<Album>(`/api/albums/${id}`),
  search: (q: string) => json<SearchResults>(`/api/search${qs({ q })}`),
  chatStatus: () =>
    json<{ enabled: boolean; backend: string | null; localTools: number; mcpTools: number | null; mcpError: string | null }>(
      '/api/chat/status',
    ),

  settings: () => json<AdminSettings>('/api/admin/settings'),
  saveFeel: (update: Partial<FeelSettings>) =>
    json<{ feel: FeelSettings }>('/api/admin/settings/feel', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update),
    }).then((r) => r.feel),
  /** Send null to clear. The key is never readable afterwards. */
  saveKey: (provider: 'anthropic' | 'openai', key: string | null) =>
    json<unknown>('/api/admin/settings/key', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, key }),
    }),
  saveChat: (update: { backend?: string; provider?: string; model?: string; workspaceId?: string | null }) =>
    json<unknown>('/api/admin/settings/chat', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update),
    }),

  syncStatus: () => json<SyncStatus>('/api/admin/sync'),
  syncNow: () => json<SyncStatus & { already: boolean }>('/api/admin/sync', { method: 'POST' }),
  saveSchedule: (schedule: SyncSchedule) =>
    json<SyncStatus>('/api/admin/sync/schedule', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule }),
    }),

  doubles: () => json<{ groups: DoubleGroup[] }>('/api/admin/duplicates'),
  /** Mark a pair as owned on purpose, or put it back on the list. */
  ignoreDouble: (a: number, b: number, ignore = true) =>
    json<{ groups: DoubleGroup[] }>('/api/admin/duplicates/ignore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a, b, ignore }),
    }),

  taxonomy: () => json<Taxonomy>('/api/admin/taxonomy'),
  moveStyle: (style: string, groupId: number | null) =>
    json<unknown>('/api/admin/taxonomy/style', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ style, group_id: groupId }),
    }),
  setOverride: (releaseId: number, groupId: number | null) =>
    json<unknown>(`/api/admin/override/${releaseId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ group_id: groupId }),
    }),
  createGroup: (name: string) =>
    json<{ id: number }>('/api/admin/taxonomy/group', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  renameGroup: (id: number, name: string) =>
    json<unknown>(`/api/admin/taxonomy/group/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  deleteGroup: (id: number) => json<unknown>(`/api/admin/taxonomy/group/${id}`, { method: 'DELETE' }),
  setHideBelow: (value: number) =>
    json<unknown>('/api/admin/settings/hide-group-below', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    }),
};

export const coverUrl = (path: string | null): string | null => (path ? `/covers/${path}` : null);

/**
 * Best available art for a large rendering: the upgraded image if one was
 * verified, then the 600px Discogs cover, then the thumbnail.
 */
export const bestArt = (a: {
  hi_path?: string | null;
  cover_path?: string | null;
  thumb_path?: string | null;
}): string | null => coverUrl(a.hi_path ?? a.cover_path ?? a.thumb_path ?? null);

export function duration(sec: number | null): string {
  if (sec == null) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Total runtime of a side or disc, for the tracklist headings. */
export function totalDuration(tracks: Track[]): string {
  const known = tracks.filter((t) => t.duration_sec != null);
  if (known.length === 0) return '';
  const sum = known.reduce((t, x) => t + (x.duration_sec ?? 0), 0);
  return `${Math.round(sum / 60)} min`;
}
