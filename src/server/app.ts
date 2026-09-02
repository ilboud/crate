import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Db } from '../db/index.js';
import { collectionRoutes } from './routes/collection.js';
import { adminRoutes } from './routes/admin.js';
import { chatRoutes, type ChatConfig } from './routes/chat.js';
import { libraryRoutes } from './routes/library.js';
import type { SyncRunner } from '../sync/runner.js';

export interface AppConfig {
  coversDir: string;
  webDir?: string;
  chat?: ChatConfig;
  /** Absent when no Discogs token reached the server; sync routes report why. */
  runner?: SyncRunner | null;
}

/**
 * Builds the Express app. Split from the listener so tests can drive it with
 * supertest without binding a port.
 */
export function createApp(db: Db, config: AppConfig): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.use('/api', collectionRoutes(db));
  app.use('/api/admin', adminRoutes(db));
  app.use('/api/admin', libraryRoutes(db, config.runner ?? null));
  app.use('/api/chat', chatRoutes(db, config.chat));

  // Mirrored art. immutable: a given release id's cover never changes, and
  // re-syncing writes the same filename, so the browser can cache hard.
  app.use(
    '/covers',
    express.static(resolve(config.coversDir), {
      maxAge: '30d',
      immutable: true,
      fallthrough: true,
    }),
  );

  if (config.webDir && existsSync(config.webDir)) {
    const webDir = resolve(config.webDir);
    app.use(express.static(webDir));
    // SPA fallback: any non-API path renders the app so client routing works
    // on a hard refresh.
    app.get(/^(?!\/api|\/covers).*/, (_req, res) => {
      res.sendFile(resolve(webDir, 'index.html'));
    });
  }

  return app;
}
