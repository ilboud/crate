import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/index.js';
import { DiscogsClient } from './discogs.js';
import { runSync } from './sync.js';
import type { SyncResult } from '../shared/types.js';

/**
 * Runs the collection sync on behalf of the server.
 *
 * The CLI stays the way to do a first import; this exists so the app can also
 * refresh itself — on a button, and on a schedule — without a shell. Two
 * properties matter:
 *
 *   single-flight  a second request while a run is in progress joins the
 *                  running one rather than starting a competing writer
 *   non-blocking   a run takes seconds to minutes, so the HTTP request that
 *                  starts it returns immediately and the UI polls status
 *
 * The schedule is deliberately not a cron expression. The collection changes a
 * few times a year, so the useful question is "how stale may this get", which
 * daily/weekly/monthly answers. A tick compares now against the last finished
 * run rather than counting from process start, so restarting the server does
 * not reset the clock or trigger a burst of catch-up runs.
 */

export type SyncSchedule = 'off' | 'daily' | 'weekly' | 'monthly';

export const SCHEDULES: readonly SyncSchedule[] = ['off', 'daily', 'weekly', 'monthly'];

const DAY_MS = 24 * 60 * 60 * 1000;

const INTERVAL_MS: Record<SyncSchedule, number> = {
  off: 0,
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
  monthly: 30 * DAY_MS,
};

/** How often the scheduler wakes to ask whether a run is due. */
const TICK_MS = 15 * 60 * 1000;

export interface SyncProgress {
  done: number;
  total: number;
  label: string;
}

export interface SyncRunSummary {
  startedAt: string;
  finishedAt: string | null;
  okCount: number;
  failedIds: number[];
}

export interface SyncStatus {
  /** False when no Discogs token reached the server; `reason` says so. */
  available: boolean;
  reason: string | null;
  running: boolean;
  startedAt: string | null;
  progress: SyncProgress | null;
  schedule: SyncSchedule;
  nextRunAt: string | null;
  last: SyncRunSummary | null;
  /** Counts from the most recent run in this process, for the toast. */
  lastResult: SyncResult | null;
  error: string | null;
}

export interface SyncRunnerOptions {
  coversDir: string;
  token?: string | null;
  username?: string | null;
  /** Injected in tests so a run can be driven without touching the network. */
  syncImpl?: typeof runSync;
  clientFactory?: (token: string) => DiscogsClient;
}

export function readSchedule(db: Db): SyncSchedule {
  const stored = getSetting(db, 'sync_schedule', 'weekly') as SyncSchedule;
  return SCHEDULES.includes(stored) ? stored : 'weekly';
}

export function writeSchedule(db: Db, schedule: SyncSchedule): SyncSchedule {
  if (!SCHEDULES.includes(schedule)) {
    throw new Error(`schedule must be one of ${SCHEDULES.join(', ')}`);
  }
  setSetting(db, 'sync_schedule', schedule);
  return schedule;
}

export class SyncRunner {
  private readonly db: Db;
  private readonly opts: SyncRunnerOptions;
  private readonly token: string | null;
  private inFlight: Promise<SyncResult> | null = null;
  private startedAt: string | null = null;
  private progress: SyncProgress | null = null;
  private lastResult: SyncResult | null = null;
  private lastError: string | null = null;
  private username: string | null;
  private timer: NodeJS.Timeout | null = null;

  constructor(db: Db, opts: SyncRunnerOptions) {
    this.db = db;
    this.opts = opts;
    this.token = opts.token ?? process.env.DISCOGS_PERSONAL_ACCESS_TOKEN ?? null;
    this.username =
      opts.username ?? process.env.DISCOGS_USERNAME ?? (getSetting(db, 'discogs_username', '') || null);
  }

  get available(): boolean {
    return Boolean(this.token);
  }

  get running(): boolean {
    return this.inFlight !== null;
  }

  status(): SyncStatus {
    const row = this.db
      .prepare(
        'SELECT started_at, finished_at, ok_count, failed_ids FROM sync_run ORDER BY id DESC LIMIT 1',
      )
      .get() as
      | { started_at: string; finished_at: string | null; ok_count: number; failed_ids: string }
      | undefined;

    const last: SyncRunSummary | null = row
      ? {
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          okCount: row.ok_count,
          failedIds: JSON.parse(row.failed_ids) as number[],
        }
      : null;

    const schedule = readSchedule(this.db);
    return {
      available: this.available,
      reason: this.available
        ? null
        : 'No Discogs token reached the server. Set DISCOGS_PERSONAL_ACCESS_TOKEN and restart.',
      running: this.running,
      startedAt: this.startedAt,
      progress: this.progress,
      schedule,
      nextRunAt: this.nextRunAt(schedule, last),
      last,
      lastResult: this.lastResult,
      error: this.lastError,
    };
  }

  private nextRunAt(schedule: SyncSchedule, last: SyncRunSummary | null): string | null {
    const interval = INTERVAL_MS[schedule];
    if (!interval || !this.available) return null;
    // No run at all: due now, which is what makes a fresh install sync itself.
    if (!last) return new Date().toISOString();
    // A run that started but never finished is a failed one. Counting from
    // when it started means a failure waits for the next ordinary slot instead
    // of being retried every tick for as long as Discogs stays down; the
    // manual button covers the case where waiting is not acceptable.
    const from = last.finishedAt ?? last.startedAt;
    return new Date(Date.parse(from) + interval).toISOString();
  }

  /** True when the schedule says a run is overdue. */
  isDue(now = Date.now()): boolean {
    if (!this.available || this.running) return false;
    const next = this.nextRunAt(readSchedule(this.db), this.status().last);
    return next !== null && Date.parse(next) <= now;
  }

  /**
   * Start a run, or return the one already going. Resolves when the run
   * finishes; callers that must not block simply do not await it.
   */
  start(): Promise<SyncResult> {
    if (this.inFlight) return this.inFlight;
    if (!this.token) return Promise.reject(new Error('sync is not configured'));

    this.startedAt = new Date().toISOString();
    this.progress = { done: 0, total: 0, label: 'reading collection' };
    this.lastError = null;

    const run = this.execute(this.token)
      .then((result) => {
        this.lastResult = result;
        return result;
      })
      .catch((err: unknown) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      })
      .finally(() => {
        this.inFlight = null;
        this.progress = null;
        this.startedAt = null;
      });

    this.inFlight = run;
    // A rejected in-flight promise with no listener would take the process
    // down; the error is already recorded in `lastError` for the UI.
    run.catch(() => {});
    return run;
  }

  private async execute(token: string): Promise<SyncResult> {
    const client = this.opts.clientFactory?.(token) ?? new DiscogsClient({ token });

    if (!this.username) {
      const identity = await client.getIdentity();
      this.username = identity.username;
      setSetting(this.db, 'discogs_username', identity.username);
    }

    const sync = this.opts.syncImpl ?? runSync;
    return sync(
      this.db,
      {
        client,
        coversDir: this.opts.coversDir,
        onProgress: (done, total, label) => {
          this.progress = { done, total, label };
        },
      },
      { username: this.username },
    );
  }

  /** Begin ticking. Only the long-lived server calls this. */
  startScheduler(): void {
    if (this.timer || !this.available) return;
    const tick = () => {
      if (this.isDue()) this.start().catch(() => {});
    };
    this.timer = setInterval(tick, TICK_MS);
    // Not keeping the event loop alive on its own: the HTTP listener does that,
    // and a lingering timer would stop the process exiting on SIGTERM.
    this.timer.unref?.();
    tick();
  }

  stopScheduler(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
