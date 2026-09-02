import { Router } from 'express';
import type { Db } from '../../db/index.js';
import { findDoubles, ignorePair, unignorePair } from '../duplicates.js';
import { SCHEDULES, writeSchedule, type SyncRunner, type SyncSchedule } from '../../sync/runner.js';

/**
 * Keeping the local index level with Discogs, and pointing out records the
 * collection appears to hold twice.
 *
 * Discogs is the source of truth and the only place the collection is edited.
 * Nothing here adds or removes a record — the app finds the doubles, links to
 * them, and syncs afterwards, which means it can never drift into claiming
 * something Discogs would contradict.
 */

export function libraryRoutes(db: Db, runner: SyncRunner | null): Router {
  const r = Router();

  const unavailable = (res: Parameters<Parameters<Router['get']>[1]>[1]) =>
    res.status(503).json({
      error: 'Sync is not configured on the server. Set DISCOGS_PERSONAL_ACCESS_TOKEN and restart.',
    });

  /* ---------------------------------------------------------------- sync */

  r.get('/sync', (_req, res) => {
    if (!runner) return unavailable(res);
    return res.json(runner.status());
  });

  r.post('/sync', (_req, res) => {
    if (!runner || !runner.available) return unavailable(res);
    // A run already in progress is not an error: the button asked for the
    // collection to be up to date, and it is on its way to being so.
    const already = runner.running;
    runner.start().catch(() => {});
    return res.status(already ? 200 : 202).json({ already, ...runner.status() });
  });

  r.put('/sync/schedule', (req, res) => {
    const schedule = req.body?.schedule as SyncSchedule;
    if (!SCHEDULES.includes(schedule)) {
      return res.status(400).json({ error: `schedule must be one of ${SCHEDULES.join(', ')}` });
    }
    writeSchedule(db, schedule);
    return res.json(runner ? runner.status() : { schedule });
  });

  /* ---------------------------------------------------------- duplicates */

  r.get('/duplicates', (_req, res) => {
    res.json({ groups: findDoubles(db) });
  });

  /** Marks a pair as owned on purpose, or takes that mark back off. */
  r.post('/duplicates/ignore', (req, res) => {
    // a === b is the "I own two copies of this one pressing" case, which is a
    // single release dismissing itself rather than a pair.
    const { a, b, ignore } = req.body ?? {};
    if (!Number.isInteger(a) || !Number.isInteger(b)) {
      return res.status(400).json({ error: 'a and b must be release ids' });
    }
    if (ignore === false) unignorePair(db, a, b);
    else ignorePair(db, a, b);
    return res.json({ groups: findDoubles(db) });
  });

  return r;
}
