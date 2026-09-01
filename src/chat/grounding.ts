import type { Db } from '../db/index.js';
import { normalise, similarity } from '../art/match.js';

/**
 * Keeping the assistant's answers tied to the actual collection.
 *
 * Two halves, split by size:
 *
 *   Albums (243 lines, ~3.6k tokens) go into the system prompt, cached. The
 *   model reads the library rather than recalling it, which is what stops
 *   "you have twelve Miles Davis records" when the answer is seven.
 *
 *   Songs (2,752 tracks, ~25k tokens) are too big to inline and would cost
 *   ~8x more per message, so they stay behind the FTS index. The prompt says
 *   so explicitly, which turns a song question into a tool call rather than
 *   a guess.
 *
 * A verification pass then checks what the answer actually claimed.
 */

export interface AlbumIndexEntry {
  id: number;
  artist: string;
  title: string;
  year: number | null;
  group: string | null;
}

export function loadAlbumIndex(db: Db): AlbumIndexEntry[] {
  return db
    .prepare(
      `SELECT r.id, r.title, r.year, r.primary_group AS "group",
              (SELECT GROUP_CONCAT(a.name, ' / ')
                 FROM release_artist ra JOIN artist a ON a.id = ra.artist_id
                WHERE ra.release_id = r.id) AS artist
         FROM release r
        ORDER BY artist COLLATE NOCASE, r.year`,
    )
    .all() as AlbumIndexEntry[];
}

/** The album list exactly as the model sees it. */
export function renderAlbumIndex(entries: AlbumIndexEntry[]): string {
  return entries
    .map((e) => `${e.artist ?? 'Unknown'} — ${e.title} (${e.year ?? '?'}) [${e.group ?? '—'}] #${e.id}`)
    .join('\n');
}

export interface CollectionCorpus {
  albums: string[];
  tracks: string[];
  artists: string[];
}

/** Normalised titles for checking what an answer claimed. */
export function loadCorpus(db: Db): CollectionCorpus {
  const col = <T extends string>(sql: string): string[] =>
    (db.prepare(sql).all() as Array<Record<string, T>>)
      .map((r) => normalise(String(Object.values(r)[0] ?? '')))
      .filter((s) => s.length > 0);

  return {
    albums: col('SELECT DISTINCT title FROM release'),
    tracks: col('SELECT DISTINCT title FROM track'),
    artists: col('SELECT DISTINCT name FROM artist'),
  };
}

export type ClaimKind = 'album' | 'track' | 'artist' | 'unknown';

export interface Claim {
  phrase: string;
  found: boolean;
  kind: ClaimKind;
}

export interface Verification {
  claims: Claim[];
  /** Phrases the answer presented as owned that are not in the collection. */
  unverified: string[];
}

/**
 * Words too generic to be worth checking even when quoted. Normalised on the
 * way in, because that is the form they are compared against — "Side A"
 * reduces to "side" once the article is stripped.
 */
const STOPWORDS = new Set(
  [
    'the', 'and', 'or', 'yes', 'no', 'ok', 'okay', 'side a', 'side b',
    'side c', 'side d', 'disc 1', 'disc 2', 'lp', 'ep', 'cd', 'vinyl',
    'jazz', 'rock', 'soul', 'funk', 'blues', 'pop', 'latin', 'classical',
    'electronic', 'hip hop', 'album', 'single', 'reissue', 'original',
  ].map(normalise),
);

const MATCH_THRESHOLD = 0.86;

function bestMatch(phrase: string, corpus: string[]): number {
  const n = normalise(phrase);
  if (n === '') return 0;
  let best = 0;
  for (const candidate of corpus) {
    if (candidate === n) return 1;
    const score = similarity(n, candidate);
    if (score > best) best = score;
    if (best >= 0.98) break;
  }
  return best;
}

/**
 * Pull out the phrases an answer presented as titles.
 *
 * Models quote or italicise titles, which is the only reliably parseable
 * signal in prose — so this checks quoted spans rather than guessing at
 * arbitrary capitalised runs, which would flag ordinary sentences.
 */
export function extractQuotedPhrases(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /"([^"\n]{2,80})"/g,          // straight quotes
    /[“”]([^“”\n]{2,80})[“”]/g,   // curly quotes
    /\*\*([^*\n]{2,80})\*\*/g,    // bold
    /(?<!\*)\*([^*\n]{2,80})\*(?!\*)/g, // italic
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const phrase = m[1]!.trim();
      if (phrase) out.push(phrase);
    }
  }
  return [...new Set(out)];
}

/**
 * Check an answer's title claims against the collection.
 *
 * Deliberately conservative: only quoted phrases are checked, and anything
 * matching an album, track or artist counts as found. The goal is to catch a
 * confidently invented record, not to police prose.
 */
export function verifyAnswer(text: string, corpus: CollectionCorpus): Verification {
  const claims: Claim[] = [];

  for (const phrase of extractQuotedPhrases(text)) {
    const n = normalise(phrase);
    if (n.length < 3 || STOPWORDS.has(n)) continue;
    // A bare number or a year is not a title claim.
    if (/^\d+$/.test(n)) continue;

    const album = bestMatch(phrase, corpus.albums);
    const track = bestMatch(phrase, corpus.tracks);
    const artist = bestMatch(phrase, corpus.artists);
    const best = Math.max(album, track, artist);

    const kind: ClaimKind =
      best < MATCH_THRESHOLD ? 'unknown'
        : best === album ? 'album'
          : best === track ? 'track'
            : 'artist';

    claims.push({ phrase, found: best >= MATCH_THRESHOLD, kind });
  }

  return {
    claims,
    unverified: claims.filter((c) => !c.found).map((c) => c.phrase),
  };
}

/**
 * The system prompt, with the album list embedded.
 *
 * Stated plainly to the model: the album list is complete, the song list is
 * not present. That asymmetry is the point — it makes a song question a tool
 * call rather than an invitation to recall.
 */
export function buildSystemPrompt(db: Db): string {
  const entries = loadAlbumIndex(db);
  const trackCount = (db.prepare('SELECT COUNT(*) AS n FROM track').get() as { n: number }).n;

  return `You help someone explore their own vinyl collection.

## What you know for certain

Below is their COMPLETE record collection: ${entries.length} releases. It is the whole
library — nothing is missing from it, and nothing outside it is owned.

Answer questions about which records they own directly from this list. Counting,
filtering by artist or genre, and "do I own X" need no tool call.

${renderAlbumIndex(entries)}

## What you do NOT know without asking

The list above has albums only. Their ${trackCount} individual TRACKS are not shown
here, and neither are tracklists, labels, catalogue numbers, pressing details or
recommendations.

For anything about a SONG — which record carries it, what is on a side, how long a
track runs — you MUST call search_my_collection or get_album_details first. Do not
answer a song question from memory, even for a famous record whose tracklist you
think you know: this collection holds specific pressings, and their contents differ.

## Rules

- Never say they own a record that is not in the list above.
- If something is not in the collection, say so plainly. That is a useful answer.
- When you name a record or a song, quote its title exactly as it appears in the
  list or in a tool result.
- Cite the release id (#12345) when it helps disambiguate a pressing.
- You cannot add, move or delete records. Those changes are made on Discogs.
- Be concise. Refer to records by artist and title.`;
}
