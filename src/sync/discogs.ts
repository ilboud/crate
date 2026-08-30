import type { CollectionItem, ReleaseDetail } from '../shared/types.js';

/**
 * Minimal Discogs REST client.
 *
 * Sync talks to REST rather than the MCP server on purpose: MCP returns
 * payloads shaped for an LLM, which would have to be re-parsed into structured
 * data, and it adds a JSON-RPC hop to every one of ~250 calls.
 *
 * Discogs allows 60 authenticated requests/minute and returns 403 without a
 * User-Agent. Requests are spaced to stay under the limit, and 429s back off
 * rather than failing the run.
 */

const API = 'https://api.discogs.com';
const USER_AGENT = 'DiscogsCollectionApp/0.1 (+https://github.com/local/discogs)';

export interface DiscogsClientOptions {
  token: string;
  /** Requests per minute. Kept under the documented 60 to leave headroom. */
  rateLimit?: number;
  fetchImpl?: typeof fetch;
}

export class DiscogsError extends Error {
  constructor(message: string, readonly status: number, readonly releaseId?: number) {
    super(message);
    this.name = 'DiscogsError';
  }
}

export class DiscogsClient {
  private readonly token: string;
  private readonly minIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private lastRequestAt = 0;

  constructor(opts: DiscogsClientOptions) {
    this.token = opts.token;
    this.minIntervalMs = 60_000 / (opts.rateLimit ?? 50);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  private async get<T>(path: string, attempt = 0): Promise<T> {
    await this.throttle();
    const res = await this.fetchImpl(`${API}${path}`, {
      headers: {
        Authorization: `Discogs token=${this.token}`,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });

    // Rate limited: back off and retry, since the whole run would otherwise
    // fail partway through a several-minute sync.
    if (res.status === 429 && attempt < 4) {
      const backoff = 2 ** attempt * 2000;
      await new Promise((r) => setTimeout(r, backoff));
      return this.get<T>(path, attempt + 1);
    }
    if (!res.ok) {
      throw new DiscogsError(`GET ${path} failed: ${res.status} ${res.statusText}`, res.status);
    }
    return (await res.json()) as T;
  }

  /** Every item in the collection, following pagination. Folder 0 is "All". */
  async getCollection(username: string, folderId = 0): Promise<CollectionItem[]> {
    const items: CollectionItem[] = [];
    let page = 1;
    let pages = 1;
    do {
      const body = await this.get<{
        releases: CollectionItem[];
        pagination: { page: number; pages: number };
      }>(
        `/users/${encodeURIComponent(username)}/collection/folders/${folderId}` +
          `/releases?page=${page}&per_page=100&sort=artist&sort_order=asc`,
      );
      items.push(...body.releases);
      pages = body.pagination.pages;
      page += 1;
    } while (page <= pages);
    return items;
  }

  async getRelease(releaseId: number): Promise<ReleaseDetail> {
    try {
      return await this.get<ReleaseDetail>(`/releases/${releaseId}`);
    } catch (err) {
      if (err instanceof DiscogsError) {
        throw new DiscogsError(err.message, err.status, releaseId);
      }
      throw err;
    }
  }

  async getIdentity(): Promise<{ username: string; id: number }> {
    return this.get('/oauth/identity');
  }
}
