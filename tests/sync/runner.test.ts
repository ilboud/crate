import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initDb, type Db } from '../../src/db/index.js';
import { readSchedule, SyncRunner, writeSchedule } from '../../src/sync/runner.js';
import type { SyncResult } from '../../src/shared/types.js';

const RESULT: SyncResult = {
  added: 0,
  removed: 0,
  unchanged: 243,
  items: 243,
  failed: [],
  durationMs: 10,
};

/** What the real runSync records; the scheduler reads it back. */
function recordRun(db: Db, finished = true): void {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO sync_run (started_at, finished_at, ok_count, failed_ids) VALUES (?,?,?,?)',
  ).run(now, finished ? now : null, 243, '[]');
}

/** A runner whose sync never touches the network. */
function runner(db: Db, syncImpl?: ReturnType<typeof vi.fn>) {
  syncImpl =
    syncImpl ??
    vi.fn(async () => {
      recordRun(db);
      return RESULT;
    });
  const r = new SyncRunner(db, {
    coversDir: 'covers',
    token: 'test-token',
    username: 'Ilboud',
    syncImpl: syncImpl as never,
  });
  return { r, syncImpl };
}

describe('sync schedule', () => {
  let db: Db;
  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('defaults to weekly, which suits a collection that changes a few times a year', () => {
    expect(readSchedule(db)).toBe('weekly');
  });

  it('round-trips a chosen schedule', () => {
    writeSchedule(db, 'monthly');
    expect(readSchedule(db)).toBe('monthly');
  });

  it('rejects anything else rather than silently falling back', () => {
    expect(() => writeSchedule(db, 'hourly' as never)).toThrow(/must be one of/);
  });

  it('falls back to weekly if the stored value is somehow unusable', () => {
    db.prepare("INSERT OR REPLACE INTO setting (key, value) VALUES ('sync_schedule', 'yearly')").run();
    expect(readSchedule(db)).toBe('weekly');
  });
});

describe('SyncRunner', () => {
  let db: Db;
  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('reports itself unavailable without a token, and says what is missing', () => {
    const r = new SyncRunner(db, { coversDir: 'covers', token: null, username: 'x' });
    const status = r.status();
    expect(status.available).toBe(false);
    expect(status.reason).toContain('DISCOGS_PERSONAL_ACCESS_TOKEN');
  });

  it('runs the sync and reports the result', async () => {
    const { r, syncImpl } = runner(db);
    const result = await r.start();
    expect(result).toEqual(RESULT);
    expect(syncImpl).toHaveBeenCalledOnce();
    expect(r.status().lastResult).toEqual(RESULT);
    expect(r.status().running).toBe(false);
  });

  it('joins a run already in progress rather than starting a second writer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const syncImpl = vi.fn(async () => {
      await gate;
      return RESULT;
    });
    const { r } = runner(db, syncImpl);

    const first = r.start();
    const second = r.start();
    expect(r.status().running).toBe(true);

    release();
    await Promise.all([first, second]);
    // Two presses of the button, one sync — concurrent writers would race on
    // the same tables.
    expect(syncImpl).toHaveBeenCalledOnce();
  });

  it('surfaces a failure as status rather than taking the process down', async () => {
    const syncImpl = vi.fn(async () => {
      throw new Error('Discogs is having a day');
    });
    const { r } = runner(db, syncImpl);

    await expect(r.start()).rejects.toThrow('Discogs is having a day');
    expect(r.status().running).toBe(false);
    expect(r.status().error).toContain('Discogs is having a day');
  });

  it('clears the error when a later run succeeds', async () => {
    const syncImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(RESULT);
    const { r } = runner(db, syncImpl);
    await expect(r.start()).rejects.toThrow();
    await r.start();
    expect(r.status().error).toBeNull();
  });

  describe('being due', () => {
    it('is due immediately when it has never run', () => {
      const { r } = runner(db);
      expect(r.isDue()).toBe(true);
    });

    it('is not due right after a run', async () => {
      const { r } = runner(db);
      await r.start();
      expect(r.isDue()).toBe(false);
    });

    it('is due again once the interval has passed', async () => {
      const { r } = runner(db);
      writeSchedule(db, 'daily');
      await r.start();
      const tomorrow = Date.now() + 25 * 60 * 60 * 1000;
      expect(r.isDue(tomorrow)).toBe(true);
    });

    it('respects the longer intervals', async () => {
      const { r } = runner(db);
      writeSchedule(db, 'monthly');
      await r.start();
      const inAWeek = Date.now() + 7 * 24 * 60 * 60 * 1000;
      expect(r.isDue(inAWeek)).toBe(false);
    });

    it('waits a full interval after a failed run rather than retrying every tick', () => {
      const { r } = runner(db);
      writeSchedule(db, 'daily');
      // A run that started and never finished — Discogs was down.
      recordRun(db, false);
      expect(r.isDue()).toBe(false);
      expect(r.isDue(Date.now() + 25 * 60 * 60 * 1000)).toBe(true);
    });

    it('is never due when the schedule is off', () => {
      const { r } = runner(db);
      writeSchedule(db, 'off');
      expect(r.isDue()).toBe(false);
      expect(r.status().nextRunAt).toBeNull();
    });

    it('measures from the last finished run, so a restart does not reset the clock', async () => {
      const { r } = runner(db);
      writeSchedule(db, 'weekly');
      await r.start();

      // A fresh runner over the same database — as after a container restart.
      const restarted = new SyncRunner(db, {
        coversDir: 'covers',
        token: 'test-token',
        username: 'Ilboud',
        syncImpl: (async () => RESULT) as never,
      });
      expect(restarted.isDue()).toBe(false);
    });
  });
});
