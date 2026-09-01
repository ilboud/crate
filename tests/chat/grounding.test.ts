import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, type Db } from '../../src/db/index.js';
import { storeRelease } from '../../src/sync/sync.js';
import {
  buildSystemPrompt,
  extractQuotedPhrases,
  loadAlbumIndex,
  loadCorpus,
  renderAlbumIndex,
  verifyAnswer,
} from '../../src/chat/grounding.js';
import { reassignAll } from '../../src/sync/taxonomy.js';
import type { ReleaseDetail } from '../../src/shared/types.js';

function release(
  id: number, title: string, artist: string,
  tracks: Array<[string, string]> = [['A1', 'A Track']],
): ReleaseDetail {
  return {
    id, title, year: 1959,
    artists: [{ id: 900 + id, name: artist }],
    labels: [{ id: 1, name: 'Columbia', catno: `CL ${id}` }],
    genres: ['Jazz'], styles: ['Modal'],
    formats: [{ name: 'Vinyl', qty: '1', descriptions: ['LP'] }],
    tracklist: tracks.map(([position, t]) => ({ position, title: t, duration: '5:00' })),
  };
}

describe('album index', () => {
  let db: Db;
  beforeEach(() => {
    db = initDb(':memory:');
    storeRelease(db, release(1, 'Kind Of Blue', 'Miles Davis',
      [['A1', 'So What'], ['A2', 'Freddie Freeloader'], ['B1', 'Blue In Green']]),
      { coverPath: null, thumbPath: null });
    storeRelease(db, release(2, 'Time Out', 'The Dave Brubeck Quartet',
      [['A1', 'Blue Rondo A La Turk'], ['A2', 'Take Five']]),
      { coverPath: null, thumbPath: null });
    reassignAll(db);
  });
  afterEach(() => db.close());

  it('lists every release', () => {
    const entries = loadAlbumIndex(db);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.title).sort()).toEqual(['Kind Of Blue', 'Time Out']);
  });

  it('renders artist, title, year, group and id on one line', () => {
    const line = renderAlbumIndex(loadAlbumIndex(db)).split('\n')[0]!;
    expect(line).toContain('Miles Davis');
    expect(line).toContain('Kind Of Blue');
    expect(line).toContain('1959');
    expect(line).toContain('Jazz');
    expect(line).toContain('#1');
  });
});

describe('system prompt', () => {
  let db: Db;
  beforeEach(() => {
    db = initDb(':memory:');
    storeRelease(db, release(1, 'Kind Of Blue', 'Miles Davis',
      [['A1', 'So What'], ['B1', 'Blue In Green']]),
      { coverPath: null, thumbPath: null });
    reassignAll(db);
  });
  afterEach(() => db.close());

  it('embeds the whole album list', () => {
    const prompt = buildSystemPrompt(db);
    expect(prompt).toContain('Kind Of Blue');
    expect(prompt).toContain('COMPLETE');
    expect(prompt).toContain('1 releases');
  });

  it('states that tracks are NOT present, so song questions need a tool', () => {
    // This asymmetry is the whole grounding strategy: albums are known,
    // songs must be looked up.
    const prompt = buildSystemPrompt(db);
    expect(prompt).toContain('albums only');
    expect(prompt).toMatch(/MUST call search_my_collection/);
    expect(prompt).toContain('2 individual TRACKS');
  });

  it('does not leak individual track titles into the prompt', () => {
    // Inlining 2,752 tracks would cost ~8x more per message.
    const prompt = buildSystemPrompt(db);
    expect(prompt).not.toContain('Blue In Green');
    expect(prompt).not.toContain('So What');
  });

  it('changes when the collection changes, so a sync is reflected', () => {
    const before = buildSystemPrompt(db);
    storeRelease(db, release(2, 'Sketches Of Spain', 'Miles Davis'),
      { coverPath: null, thumbPath: null });
    reassignAll(db);
    const after = buildSystemPrompt(db);
    expect(after).not.toBe(before);
    expect(after).toContain('Sketches Of Spain');
  });
});

describe('extractQuotedPhrases', () => {
  it('finds straight-quoted titles', () => {
    expect(extractQuotedPhrases('You own "Kind Of Blue" and "Time Out".'))
      .toEqual(['Kind Of Blue', 'Time Out']);
  });

  it('finds curly quotes, bold and italics', () => {
    const found = extractQuotedPhrases('Try **Bitches Brew**, *Milestones*, or “Sketches Of Spain”.');
    expect(found).toContain('Bitches Brew');
    expect(found).toContain('Milestones');
    expect(found).toContain('Sketches Of Spain');
  });

  it('returns nothing from prose with no titles', () => {
    expect(extractQuotedPhrases('You have seven records by this artist.')).toEqual([]);
  });

  it('does not choke on unmatched quotes', () => {
    expect(() => extractQuotedPhrases('an unclosed " quote and *stray asterisk')).not.toThrow();
  });
});

describe('verifyAnswer', () => {
  let db: Db;
  let corpus: ReturnType<typeof loadCorpus>;
  beforeEach(() => {
    db = initDb(':memory:');
    storeRelease(db, release(1, 'Kind Of Blue', 'Miles Davis',
      [['A1', 'So What'], ['A2', 'Freddie Freeloader'], ['B1', 'Blue In Green']]),
      { coverPath: null, thumbPath: null });
    storeRelease(db, release(2, 'Bitches Brew', 'Miles Davis', [['A', "Pharaoh's Dance"]]),
      { coverPath: null, thumbPath: null });
    reassignAll(db);
    corpus = loadCorpus(db);
  });
  afterEach(() => db.close());

  it('accepts an album that is owned', () => {
    const v = verifyAnswer('You own "Kind Of Blue".', corpus);
    expect(v.unverified).toEqual([]);
    expect(v.claims[0]).toMatchObject({ found: true, kind: 'album' });
  });

  it('accepts a track that is owned', () => {
    const v = verifyAnswer('"Blue In Green" is on side B.', corpus);
    expect(v.unverified).toEqual([]);
    expect(v.claims[0]!.kind).toBe('track');
  });

  it('FLAGS an album the collection does not contain', () => {
    // The failure this whole feature exists to catch.
    const v = verifyAnswer('You also own "Sketches Of Spain" and "Milestones".', corpus);
    expect(v.unverified).toEqual(['Sketches Of Spain', 'Milestones']);
  });

  it('flags an invented track', () => {
    const v = verifyAnswer('Side A opens with "Flamenco Sketches".', corpus);
    expect(v.unverified).toContain('Flamenco Sketches');
  });

  it('tolerates small differences in a real title', () => {
    const v = verifyAnswer('Your copy of "Kind of Blue" is a reissue.', corpus);
    expect(v.unverified).toEqual([]);
  });

  it('accepts an artist name', () => {
    const v = verifyAnswer('Records by "Miles Davis" dominate the jazz shelf.', corpus);
    expect(v.unverified).toEqual([]);
  });

  it('ignores generic quoted words rather than flagging prose', () => {
    const v = verifyAnswer('Filed under "Jazz", on "Side A", pressed on "vinyl".', corpus);
    expect(v.unverified).toEqual([]);
  });

  it('ignores bare numbers', () => {
    const v = verifyAnswer('You own "7" of them.', corpus);
    expect(v.unverified).toEqual([]);
  });

  it('returns nothing to check for an answer with no quoted titles', () => {
    const v = verifyAnswer('You have two records by that artist.', corpus);
    expect(v.claims).toEqual([]);
    expect(v.unverified).toEqual([]);
  });

  it('reports both the good and the bad in a mixed answer', () => {
    const v = verifyAnswer('You own "Bitches Brew" but not "On The Corner".', corpus);
    expect(v.unverified).toEqual(['On The Corner']);
    expect(v.claims.filter((c) => c.found)).toHaveLength(1);
  });
});
