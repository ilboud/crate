import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, type Db } from '../../src/db/index.js';
import { createApp } from '../../src/server/app.js';
import {
  backendFromEnv,
  clampSensitivity,
  maskKey,
  providerStatus,
  readBackendChoice,
  readFeel,
  resolveKey,
  resolveModel,
  readWorkspaceId,
  storeKey,
  storeModel,
  storeWorkspaceId,
  writeFeel,
} from '../../src/server/settings.js';
import type { Express } from 'express';

const SECRET = 'sk-ant-api03-abcdefghijklmnop4f2a';

describe('maskKey', () => {
  it('reveals only the last four characters', () => {
    expect(maskKey(SECRET)).toBe('••••4f2a');
  });

  it('reveals nothing from a short value', () => {
    // Four characters of a six-character secret is most of it.
    expect(maskKey('abc123')).toBe('••••');
  });

  it('is null when nothing is stored', () => {
    expect(maskKey(null)).toBeNull();
    expect(maskKey('')).toBeNull();
  });
});

describe('feel settings', () => {
  let db: Db;
  beforeEach(() => { db = initDb(':memory:'); });
  afterEach(() => db.close());

  it('returns defaults on a fresh database', () => {
    expect(readFeel(db)).toEqual({ sensitivity: 0.42, momentum: 'medium', neighbours: 'auto' });
  });

  it('round-trips a change', () => {
    writeFeel(db, { sensitivity: 0.3, momentum: 'high', neighbours: 4 });
    expect(readFeel(db)).toEqual({ sensitivity: 0.3, momentum: 'high', neighbours: 4 });
  });

  it('applies only the fields given', () => {
    writeFeel(db, { momentum: 'off' });
    expect(readFeel(db)).toEqual({ sensitivity: 0.42, momentum: 'off', neighbours: 'auto' });
  });

  it('clamps a sensitivity that would make the crate unusable', () => {
    expect(clampSensitivity(0.01)).toBe(0.15);
    expect(clampSensitivity(5)).toBe(0.9);
  });

  it('rejects an unknown momentum', () => {
    expect(() => writeFeel(db, { momentum: 'ludicrous' })).toThrow(/momentum/);
  });

  it('rejects a non-numeric sensitivity', () => {
    expect(() => writeFeel(db, { sensitivity: 'fast' })).toThrow(/sensitivity/);
  });

  it('accepts auto for neighbours', () => {
    writeFeel(db, { neighbours: 4 });
    writeFeel(db, { neighbours: 'auto' });
    expect(readFeel(db).neighbours).toBe('auto');
  });

  it('survives a corrupted stored value', () => {
    db.prepare("INSERT OR REPLACE INTO setting (key, value) VALUES ('flow_momentum', 'nonsense')").run();
    db.prepare("INSERT OR REPLACE INTO setting (key, value) VALUES ('flow_sensitivity', 'abc')").run();
    expect(readFeel(db)).toEqual({ sensitivity: 0.42, momentum: 'medium', neighbours: 'auto' });
  });
});

describe('key storage', () => {
  let db: Db;
  const saved = { ...process.env };
  beforeEach(() => {
    db = initDb(':memory:');
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CHAT_BACKEND;
  });
  afterEach(() => {
    db.close();
    process.env = { ...saved };
  });

  it('reports nothing configured on a fresh database', () => {
    const s = providerStatus(db, 'anthropic');
    expect(s.configured).toBe(false);
    expect(s.source).toBeNull();
    expect(s.hint).toBeNull();
  });

  it('reports a stored key without revealing it', () => {
    storeKey(db, 'anthropic', SECRET);
    const s = providerStatus(db, 'anthropic');
    expect(s.configured).toBe(true);
    expect(s.source).toBe('stored');
    expect(s.hint).toBe('••••4f2a');
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });

  it('lets the environment win over a stored key', () => {
    storeKey(db, 'anthropic', SECRET);
    process.env.ANTHROPIC_API_KEY = 'sk-from-the-environment';
    expect(resolveKey(db, 'anthropic')).toBe('sk-from-the-environment');
    expect(providerStatus(db, 'anthropic').source).toBe('env');
  });

  it('clears a stored key', () => {
    storeKey(db, 'anthropic', SECRET);
    storeKey(db, 'anthropic', null);
    expect(resolveKey(db, 'anthropic')).toBeNull();
    expect(providerStatus(db, 'anthropic').configured).toBe(false);
  });

  it('takes the backend choice from the environment when set', () => {
    process.env.CHAT_BACKEND = 'openai';
    expect(readBackendChoice(db)).toBe('openai');
  });
});

describe('anthropic workspace id', () => {
  let db: Db;
  const saved = { ...process.env };
  beforeEach(() => {
    db = initDb(':memory:');
    delete process.env.ANTHROPIC_WORKSPACE_ID;
  });
  afterEach(() => { db.close(); process.env = { ...saved }; });

  it('is absent until set', () => {
    expect(providerStatus(db, 'anthropic').workspaceId).toBeNull();
  });

  it('round-trips, and is returned since it is not a secret', () => {
    storeWorkspaceId(db, 'wrkspc_abc123');
    expect(providerStatus(db, 'anthropic').workspaceId).toBe('wrkspc_abc123');
  });

  it('lets the environment win', () => {
    storeWorkspaceId(db, 'wrkspc_stored');
    process.env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_env';
    expect(readWorkspaceId(db)).toBe('wrkspc_env');
  });

  it('is not offered for OpenAI', () => {
    expect(providerStatus(db, 'openai').workspaceId).toBeUndefined();
  });
});

describe('settings API', () => {
  let db: Db;
  let app: Express;
  let coversDir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    db = initDb(':memory:');
    coversDir = mkdtempSync(join(tmpdir(), 'covers-set-'));
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CHAT_BACKEND;
    app = createApp(db, { coversDir });
  });
  afterEach(() => {
    db.close();
    rmSync(coversDir, { recursive: true, force: true });
    process.env = { ...saved };
  });

  it('returns feel settings and chat status', async () => {
    const res = await request(app).get('/api/admin/settings').expect(200);
    expect(res.body.feel).toEqual({ sensitivity: 0.42, momentum: 'medium', neighbours: 'auto' });
    expect(res.body.chat.providers).toHaveLength(2);
    expect(res.body.chat.providers[0].configured).toBe(false);
  });

  it('saves a key and NEVER returns it in any response', async () => {
    await request(app)
      .put('/api/admin/settings/key')
      .send({ provider: 'anthropic', key: SECRET })
      .expect(200);

    // The write response, the settings read, and the chat status must all be
    // clean. This is the whole point of the write-only design.
    for (const path of ['/api/admin/settings', '/api/chat/status', '/api/admin/taxonomy']) {
      const res = await request(app).get(path).expect(200);
      expect(JSON.stringify(res.body), `${path} leaked the key`).not.toContain(SECRET);
    }

    const settings = await request(app).get('/api/admin/settings').expect(200);
    const anthropic = settings.body.chat.providers.find(
      (p: { provider: string }) => p.provider === 'anthropic',
    );
    expect(anthropic.configured).toBe(true);
    expect(anthropic.hint).toBe('••••4f2a');
  });

  it('enables chat once a key is saved, without a restart', async () => {
    const before = await request(app).get('/api/chat/status').expect(200);
    expect(before.body.enabled).toBe(false);

    await request(app)
      .put('/api/admin/settings/key')
      .send({ provider: 'anthropic', key: SECRET })
      .expect(200);

    const after = await request(app).get('/api/chat/status').expect(200);
    expect(after.body.enabled).toBe(true);
    expect(after.body.backend).toBe('anthropic');
  });

  it('clears a key', async () => {
    await request(app).put('/api/admin/settings/key').send({ provider: 'anthropic', key: SECRET });
    await request(app).put('/api/admin/settings/key').send({ provider: 'anthropic', key: null }).expect(200);
    const res = await request(app).get('/api/chat/status').expect(200);
    expect(res.body.enabled).toBe(false);
  });

  it('rejects an unknown provider', async () => {
    await request(app)
      .put('/api/admin/settings/key')
      .send({ provider: 'gemini', key: SECRET })
      .expect(400);
  });

  it('rejects something too short to be a key', async () => {
    await request(app)
      .put('/api/admin/settings/key')
      .send({ provider: 'anthropic', key: 'abc' })
      .expect(400);
  });

  it('updates feel settings', async () => {
    const res = await request(app)
      .put('/api/admin/settings/feel')
      .send({ momentum: 'high', sensitivity: 0.25 })
      .expect(200);
    expect(res.body.feel.momentum).toBe('high');
    expect(res.body.feel.sensitivity).toBe(0.25);
  });

  it('rejects an invalid feel value', async () => {
    await request(app).put('/api/admin/settings/feel').send({ momentum: 'nope' }).expect(400);
  });

  it('saves a workspace id for an identity-linked key', async () => {
    await request(app)
      .put('/api/admin/settings/chat')
      .send({ workspaceId: 'wrkspc_abc123' })
      .expect(200);
    const res = await request(app).get('/api/admin/settings').expect(200);
    const anthropic = res.body.chat.providers.find(
      (p: { provider: string }) => p.provider === 'anthropic',
    );
    expect(anthropic.workspaceId).toBe('wrkspc_abc123');
  });

  it('clears a workspace id', async () => {
    await request(app).put('/api/admin/settings/chat').send({ workspaceId: 'wrkspc_x' });
    await request(app).put('/api/admin/settings/chat').send({ workspaceId: '' }).expect(200);
    const res = await request(app).get('/api/admin/settings').expect(200);
    const anthropic = res.body.chat.providers.find(
      (p: { provider: string }) => p.provider === 'anthropic',
    );
    expect(anthropic.workspaceId).toBeNull();
  });

  it('switches the chat provider', async () => {
    const res = await request(app)
      .put('/api/admin/settings/chat')
      .send({ backend: 'openai' })
      .expect(200);
    expect(res.body.backend).toBe('openai');
  });

  it('sets a model for a provider', async () => {
    await request(app)
      .put('/api/admin/settings/chat')
      .send({ provider: 'openai', model: 'gpt-4o-mini' })
      .expect(200);
    const res = await request(app).get('/api/admin/settings').expect(200);
    const openai = res.body.chat.providers.find((p: { provider: string }) => p.provider === 'openai');
    expect(openai.model).toBe('gpt-4o-mini');
  });
});

/**
 * Compose passes every declared variable through, empty ones included. That
 * turned "optional override" into "always in force": the provider switch was
 * greyed out on every container deployment because CHAT_BACKEND existed as an
 * empty string.
 */
describe('an empty environment variable means unset', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('does not treat a blank CHAT_BACKEND as the environment deciding', () => {
    process.env.CHAT_BACKEND = '';
    expect(backendFromEnv()).toBe(false);
  });

  it('does not treat a value it cannot use as the environment deciding', () => {
    // Greying out the control for a typo the app then ignores is worse than
    // ignoring the typo alone.
    process.env.CHAT_BACKEND = 'claude';
    expect(backendFromEnv()).toBe(false);
  });

  it('reports the environment as deciding for a real provider', () => {
    process.env.CHAT_BACKEND = 'openai';
    expect(backendFromEnv()).toBe(true);
  });

  it('lets a blank model fall through to the stored one', () => {
    const db = initDb(':memory:');
    process.env.ANTHROPIC_MODEL = '';
    storeModel(db, 'anthropic', 'claude-sonnet-5');
    expect(resolveModel(db, 'anthropic')).toEqual({
      model: 'claude-sonnet-5',
      fromEnv: false,
    });
  });

  it('lets a set model win over the stored one, and says so', () => {
    const db = initDb(':memory:');
    process.env.ANTHROPIC_MODEL = 'claude-opus-5';
    storeModel(db, 'anthropic', 'claude-sonnet-5');
    expect(resolveModel(db, 'anthropic')).toEqual({
      model: 'claude-opus-5',
      fromEnv: true,
    });
    expect(providerStatus(db, 'anthropic').modelFromEnv).toBe(true);
  });
});

/** One key per provider. They are never the same setting. */
describe('keys stay in their own provider', () => {
  it('storing an Anthropic key leaves OpenAI unconfigured', () => {
    const db = initDb(':memory:');
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    storeKey(db, 'anthropic', 'sk-ant-api03-abcdefghijklmnop4f2a');

    expect(providerStatus(db, 'anthropic').configured).toBe(true);
    const openai = providerStatus(db, 'openai');
    expect(openai.configured).toBe(false);
    expect(openai.hint).toBeNull();
  });
});
