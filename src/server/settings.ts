import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/index.js';

/**
 * Runtime settings, and the rules for handling the secret ones.
 *
 * The app has no login and sits on a LAN, so a stored API key is never sent
 * back over HTTP — a GET returns only whether a key exists and its last four
 * characters. Keys can be written and cleared, but not read.
 *
 * Environment variables still win over stored values, so an existing Docker
 * deployment behaves exactly as before and the UI reports which is in force.
 */

export type Momentum = 'off' | 'low' | 'medium' | 'high';

export interface FeelSettings {
  /** Fraction of the sleeve width that advances one record while dragging. */
  sensitivity: number;
  momentum: Momentum;
  /** Covers visible each side, or 'auto' to derive from the viewport. */
  neighbours: number | 'auto';
}

export const FEEL_DEFAULTS: FeelSettings = {
  sensitivity: 0.42,
  momentum: 'medium',
  neighbours: 'auto',
};

const MOMENTUMS: readonly Momentum[] = ['off', 'low', 'medium', 'high'];

export function readFeel(db: Db): FeelSettings {
  const sensitivity = Number(getSetting(db, 'flow_sensitivity', String(FEEL_DEFAULTS.sensitivity)));
  const momentum = getSetting(db, 'flow_momentum', FEEL_DEFAULTS.momentum) as Momentum;
  const neighbours = getSetting(db, 'flow_neighbours', 'auto');

  return {
    sensitivity: Number.isFinite(sensitivity) ? clampSensitivity(sensitivity) : FEEL_DEFAULTS.sensitivity,
    momentum: MOMENTUMS.includes(momentum) ? momentum : FEEL_DEFAULTS.momentum,
    neighbours: neighbours === 'auto' ? 'auto' : clampNeighbours(Number(neighbours)),
  };
}

export function clampSensitivity(value: number): number {
  // Below ~0.15 a stray thumb movement skips records; above ~0.9 the crate
  // barely responds to a full swipe.
  return Math.max(0.15, Math.min(0.9, value));
}

export function clampNeighbours(value: number): number | 'auto' {
  if (!Number.isFinite(value)) return 'auto';
  return Math.max(1, Math.min(8, Math.round(value)));
}

export interface FeelUpdate {
  sensitivity?: unknown;
  momentum?: unknown;
  neighbours?: unknown;
}

/** Applies only the fields present, rejecting anything malformed. */
export function writeFeel(db: Db, update: FeelUpdate): FeelSettings {
  if (update.sensitivity !== undefined) {
    const n = Number(update.sensitivity);
    if (!Number.isFinite(n)) throw new Error('sensitivity must be a number');
    setSetting(db, 'flow_sensitivity', String(clampSensitivity(n)));
  }
  if (update.momentum !== undefined) {
    const m = String(update.momentum) as Momentum;
    if (!MOMENTUMS.includes(m)) throw new Error(`momentum must be one of ${MOMENTUMS.join(', ')}`);
    setSetting(db, 'flow_momentum', m);
  }
  if (update.neighbours !== undefined) {
    const raw = update.neighbours;
    if (raw === 'auto' || raw === null) setSetting(db, 'flow_neighbours', 'auto');
    else {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error('neighbours must be a number or "auto"');
      setSetting(db, 'flow_neighbours', String(clampNeighbours(n)));
    }
  }
  return readFeel(db);
}

/* --------------------------------------------------------------- secrets */

export type Provider = 'anthropic' | 'openai';

const KEY_SETTING: Record<Provider, string> = {
  anthropic: 'anthropic_api_key',
  openai: 'openai_api_key',
};

const ENV_VAR: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

const MODEL_ENV_VAR: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_MODEL',
  openai: 'OPENAI_MODEL',
};

/**
 * Never the key itself — only enough to recognise which one is stored.
 * A short value is reported as set without a hint, since four characters of a
 * six-character secret is most of it.
 */
export function maskKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length < 12) return '••••';
  return `••••${key.slice(-4)}`;
}

export interface ProviderStatus {
  provider: Provider;
  configured: boolean;
  /** 'env' when an environment variable supplies it, 'stored' when the DB does. */
  source: 'env' | 'stored' | null;
  hint: string | null;
  model: string;
  /** True when the model is pinned by the environment and the UI cannot change it. */
  modelFromEnv: boolean;
  /** Anthropic only: workspace id for an identity-linked key, if set. */
  workspaceId?: string | null;
}

export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-4o',
};

/** The key actually in force: environment first, then the stored value. */
export function resolveKey(db: Db, provider: Provider): string | null {
  const fromEnv = process.env[ENV_VAR[provider]];
  if (fromEnv) return fromEnv;
  const stored = getSetting(db, KEY_SETTING[provider], '');
  return stored === '' ? null : stored;
}

/**
 * The model actually used, environment first — the same precedence as the key,
 * so a deployment can pin one. An empty variable counts as unset: Compose
 * passes every declared variable through, so blank has to mean "not set" or
 * every containerised deployment would be pinned to nothing.
 */
export function resolveModel(db: Db, provider: Provider): { model: string; fromEnv: boolean } {
  const fromEnv = (process.env[MODEL_ENV_VAR[provider]] ?? '').trim();
  if (fromEnv) return { model: fromEnv, fromEnv: true };
  return {
    model: getSetting(db, `${provider}_model`, DEFAULT_MODELS[provider]),
    fromEnv: false,
  };
}

export function providerStatus(db: Db, provider: Provider): ProviderStatus {
  const fromEnv = process.env[ENV_VAR[provider]];
  const stored = getSetting(db, KEY_SETTING[provider], '');
  const key = fromEnv || stored || null;
  const model = resolveModel(db, provider);

  return {
    provider,
    configured: key !== null,
    source: key === null ? null : fromEnv ? 'env' : 'stored',
    hint: maskKey(key),
    model: model.model,
    modelFromEnv: model.fromEnv,
    // Not a secret — it identifies a workspace, it does not authenticate.
    ...(provider === 'anthropic' ? { workspaceId: readWorkspaceId(db) } : {}),
  };
}

export function storeKey(db: Db, provider: Provider, key: string | null): void {
  setSetting(db, KEY_SETTING[provider], key ?? '');
}

export function storeModel(db: Db, provider: Provider, model: string): void {
  setSetting(db, `${provider}_model`, model.trim() || DEFAULT_MODELS[provider]);
}

/**
 * Workspace id for an identity-linked Anthropic key. Optional: ordinary keys
 * do not need one, and the API rejects identity-linked keys without it.
 */
export function readWorkspaceId(db: Db): string | null {
  const fromEnv = process.env.ANTHROPIC_WORKSPACE_ID;
  if (fromEnv) return fromEnv;
  const stored = getSetting(db, 'anthropic_workspace_id', '');
  return stored === '' ? null : stored;
}

export function storeWorkspaceId(db: Db, id: string | null): void {
  setSetting(db, 'anthropic_workspace_id', id ?? '');
}

/**
 * True only when CHAT_BACKEND names a provider the app recognises.
 *
 * Not `Boolean(process.env.CHAT_BACKEND)`: Compose passes declared variables
 * through as empty strings, and a typo like CHAT_BACKEND=claude is ignored by
 * readBackendChoice below. Either would grey out the provider switch while the
 * environment was not in fact deciding anything — a control disabled for a
 * reason the user cannot see or fix.
 */
export function backendFromEnv(): boolean {
  const fromEnv = (process.env.CHAT_BACKEND ?? '').trim().toLowerCase();
  return fromEnv === 'anthropic' || fromEnv === 'openai';
}

export function readBackendChoice(db: Db): Provider {
  const fromEnv = (process.env.CHAT_BACKEND ?? '').trim().toLowerCase();
  if (fromEnv === 'anthropic' || fromEnv === 'openai') return fromEnv;
  const stored = getSetting(db, 'chat_backend', 'anthropic');
  return stored === 'openai' ? 'openai' : 'anthropic';
}

export function writeBackendChoice(db: Db, provider: Provider): void {
  setSetting(db, 'chat_backend', provider);
}
