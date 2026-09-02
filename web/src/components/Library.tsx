import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  coverUrl,
  type DoubleGroup,
  type SyncSchedule,
  type SyncStatus,
} from '../api';

/**
 * Library upkeep: bringing the index level with Discogs, and pointing out
 * records that look like doubles.
 *
 * The screen never edits the collection. Discogs is where a record is added or
 * removed, so each copy links straight to it — the app's job is to notice the
 * double and hand over the link, then sync afterwards.
 */

const SCHEDULES: Array<[SyncSchedule, string]> = [
  ['off', 'Never'],
  ['daily', 'Daily'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
];

/** "3 days ago" reads better than a timestamp for something this coarse. */
function ago(iso: string | null): string {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 90) return 'just now';
  const units: Array<[number, string]> = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
  ];
  let best = units[0]!;
  for (const unit of units) if (seconds >= unit[0]) best = unit;
  const n = Math.round(seconds / best[0]);
  return `${n} ${best[1]}${n === 1 ? '' : 's'} ago`;
}

function when(iso: string | null): string {
  if (!iso) return 'soon';
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'due now';
  const days = Math.round(ms / 86400000);
  if (days >= 1) return `in ${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.max(1, Math.round(ms / 3600000));
  return `in ${hours} hour${hours === 1 ? '' : 's'}`;
}

export function Library({ onSynced }: { onSynced: () => void }) {
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [groups, setGroups] = useState<DoubleGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const wasRunning = useRef(false);

  const loadDoubles = useCallback(
    () => api.doubles().then((d) => setGroups(d.groups)).catch((e: Error) => setError(e.message)),
    [],
  );

  const loadSync = useCallback(
    () => api.syncStatus().then(setSync).catch((e: Error) => setError(e.message)),
    [],
  );

  useEffect(() => {
    void loadSync();
    void loadDoubles();
  }, [loadSync, loadDoubles]);

  // Poll only while a run is going, and refresh everything the moment it ends:
  // a sync can change which records are doubles.
  useEffect(() => {
    if (!sync?.running) {
      if (wasRunning.current) {
        wasRunning.current = false;
        void loadDoubles();
        onSynced();
      }
      return;
    }
    wasRunning.current = true;
    const timer = setTimeout(() => void loadSync(), 1500);
    return () => clearTimeout(timer);
  }, [sync, loadSync, loadDoubles, onSynced]);

  async function runSync() {
    setError(null);
    try {
      const res = await api.syncNow();
      setSync(res);
      setNote(res.already ? 'A sync was already running' : 'Syncing…');
      setTimeout(() => setNote(null), 2400);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function setSchedule(schedule: SyncSchedule) {
    setError(null);
    try {
      setSync(await api.saveSchedule(schedule));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function notADouble(group: DoubleGroup) {
    const [a, b] = group.copies;
    if (!a) return;
    // A record owned twice is one release, so it dismisses itself.
    try {
      setGroups((await api.ignoreDouble(a.releaseId, (b ?? a).releaseId)).groups);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <h2>Library</h2>
      <p className="lede">
        Discogs is the record of what you own. This screen keeps the app level with it and points
        out anything that looks filed twice — add and remove records on Discogs itself.
      </p>
      {error && <div className="warn">{error}</div>}
      {note && <p className="savedmark">{note}</p>}

      <SyncPanel sync={sync} onSync={runSync} onSchedule={setSchedule} />

      <h3 className="sectionhead">Possible doubles</h3>
      <Doubles groups={groups} onDismiss={notADouble} />
    </>
  );
}

function SyncPanel({
  sync,
  onSync,
  onSchedule,
}: {
  sync: SyncStatus | null;
  onSync: () => void;
  onSchedule: (s: SyncSchedule) => void;
}) {
  if (!sync) return <p className="empty">Loading…</p>;

  if (!sync.available) {
    return (
      <section className="field">
        <label>Sync</label>
        <div className="warn">{sync.reason}</div>
      </section>
    );
  }

  const progress = sync.progress;
  const pct = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : null;

  return (
    <section className="field syncpanel">
      <label>Sync with Discogs</label>

      <div className="syncrow">
        <button className="navbtn primary" onClick={onSync} disabled={sync.running}>
          {sync.running ? 'Syncing…' : 'Sync now'}
        </button>
        <div className="syncstate">
          {sync.running ? (
            <span className="mono">{progress?.label ?? 'working'}</span>
          ) : (
            <>
              Last synced <b>{ago(sync.last?.finishedAt ?? null)}</b>
              {sync.schedule !== 'off' && <> · next {when(sync.nextRunAt)}</>}
            </>
          )}
        </div>
      </div>

      {sync.running && (
        <div className="progress" role="progressbar" aria-label="Sync progress">
          {/* Indeterminate until the collection listing says how many there are. */}
          <span style={pct === null ? undefined : { width: `${pct}%` }} className={pct === null ? 'indet' : ''} />
        </div>
      )}

      {!sync.running && sync.lastResult && (
        <p className="fieldhelp">
          {sync.lastResult.added} fetched, {sync.lastResult.unchanged} unchanged,{' '}
          {sync.lastResult.removed} removed in {(sync.lastResult.durationMs / 1000).toFixed(1)}s.
        </p>
      )}
      {sync.error && <div className="warn">Last run failed: {sync.error}</div>}
      {!!sync.last?.failedIds.length && (
        <p className="fieldhelp">
          {sync.last.failedIds.length} release(s) could not be fetched and will be retried next run.
        </p>
      )}

      <label className="sublabel">Check automatically</label>
      <div className="segmented">
        {SCHEDULES.map(([value, text]) => (
          <button
            key={value}
            aria-pressed={sync.schedule === value}
            onClick={() => onSchedule(value)}
          >
            {text}
          </button>
        ))}
      </div>
      <p className="fieldhelp">
        A check costs a few requests when nothing has changed, so weekly suits a collection that
        grows a few records a year.
      </p>
    </section>
  );
}

const KIND_LABEL: Record<DoubleGroup['kind'], string> = {
  'same-copy': 'Two copies',
  'same-pressing': 'Filed twice',
  reissue: 'Two pressings',
};

function Doubles({
  groups,
  onDismiss,
}: {
  groups: DoubleGroup[] | null;
  onDismiss: (g: DoubleGroup) => void;
}) {
  if (!groups) return <p className="empty">Loading…</p>;
  if (!groups.length) {
    return <p className="empty">Nothing looks doubled. Every record appears once.</p>;
  }

  return (
    <div className="doubles">
      {groups.map((group) => (
        <article key={group.key} className={`double double-${group.kind}`}>
          <header>
            <span className="kind">{KIND_LABEL[group.kind]}</span>
            <h4>
              {group.copies[0]!.artist} — {group.copies[0]!.title}
            </h4>
          </header>
          <p className="why">{group.why}</p>

          <div className="pressings">
            {group.copies.map((copy) => (
              <a
                key={copy.releaseId}
                className="pressing"
                href={`https://www.discogs.com/release/${copy.releaseId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {coverUrl(copy.art) ? (
                  <img src={coverUrl(copy.art)!} alt="" loading="lazy" />
                ) : (
                  <div className="pressing-blank" />
                )}
                <div className="pressing-meta">
                  <b>{copy.year ?? '—'}</b>
                  <span>{copy.format}</span>
                  {copy.catnos.length > 0 && <span className="mono">{copy.catnos.join(' · ')}</span>}
                  {copy.instances.length > 1 && (
                    <span className="mono">{copy.instances.length} copies owned</span>
                  )}
                  <span className="golink">Open on Discogs →</span>
                </div>
              </a>
            ))}
          </div>

          <button className="navbtn quiet" onClick={() => onDismiss(group)}>
            {group.kind === 'same-copy'
              ? 'I meant to own two — stop showing this'
              : 'I own both — stop showing this'}
          </button>
        </article>
      ))}
    </div>
  );
}
