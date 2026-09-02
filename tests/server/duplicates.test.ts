import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, type Db } from '../../src/db/index.js';
import { storeRelease } from '../../src/sync/sync.js';
import {
  albumKey,
  findDoubles,
  ignorePair,
  normaliseCatno,
  unignorePair,
} from '../../src/server/duplicates.js';
import type { ReleaseDetail } from '../../src/shared/types.js';

/**
 * The cases here are the real ones from the collection. Two entries sharing a
 * catalogue number are one pressing filed twice; two entries with different
 * ones are an original and a reissue, which a collector owns on purpose.
 */

function release(
  id: number,
  title: string,
  artist: string,
  catno: string,
  year: number,
  descriptions: string[] = ['LP', 'Album'],
): ReleaseDetail {
  return {
    id,
    title,
    year,
    artists: [{ id: 900 + (id % 100), name: artist }],
    labels: [{ id: id % 50, name: 'A Label', catno }],
    formats: [{ name: 'Vinyl', qty: '1', descriptions }],
    genres: ['Rock'],
    styles: ['Alternative Rock'],
    tracklist: [{ position: 'A1', title: 'One', duration: '3:00' }],
  };
}

/** storeRelease always wants a covers argument; none of these cases use art. */
function store(db: Db, detail: ReleaseDetail): void {
  storeRelease(db, detail, { coverPath: null, thumbPath: null });
}

function own(db: Db, instanceId: number, releaseId: number, dateAdded: string): void {
  db.prepare(
    'INSERT INTO collection_item (instance_id, release_id, folder_id, date_added) VALUES (?,?,?,?)',
  ).run(instanceId, releaseId, 1, dateAdded);
}

describe('normaliseCatno', () => {
  it('sees through the ways a catalogue number gets written', () => {
    expect(normaliseCatno('SD 33-332')).toBe(normaliseCatno('sd33332'));
    expect(normaliseCatno('STH2065')).toBe(normaliseCatno('STH-2065'));
  });

  it('keeps different numbers different', () => {
    expect(normaliseCatno('CBS 25100')).not.toBe(normaliseCatno('19658704921'));
  });
});

describe('albumKey', () => {
  it('matches an original against its remastered reissue', () => {
    expect(albumKey('Bruce Springsteen', 'Nebraska')).toBe(
      albumKey('Bruce Springsteen', 'Nebraska (Remastered)'),
    );
  });

  it('does not collapse two different albums by one artist', () => {
    expect(albumKey('Miles Davis', 'Kind Of Blue')).not.toBe(
      albumKey('Miles Davis', 'Bitches Brew'),
    );
  });
});

describe('findDoubles', () => {
  let db: Db;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('finds nothing in a collection with no repeats', () => {
    store(db, release(1, 'Kind Of Blue', 'Miles Davis', 'CL 1355', 1959));
    own(db, 11, 1, '2023-01-01');
    expect(findDoubles(db)).toEqual([]);
  });

  it('flags one pressing filed under two release ids as the same pressing', () => {
    // Madvillainy: both entries carry STH2065.
    store(db, release(14922028, 'Madvillainy', 'Madvillain', 'STH2065', 2019));
    store(db, release(28277659, 'Madvillainy', 'Madvillain', 'STH-2065', 2011));
    own(db, 1, 14922028, '2023-01-01');
    own(db, 2, 28277659, '2024-06-01');

    const [group] = findDoubles(db);
    expect(group!.kind).toBe('same-pressing');
    expect(group!.copies.map((c) => c.releaseId).sort()).toEqual([14922028, 28277659]);
    expect(group!.why).toContain('2065');
  });

  it('treats an original and a reissue as different pressings, not an error', () => {
    // Nebraska: CBS 25100 (1982) against the 2022 Columbia club edition.
    store(db, release(877497, 'Nebraska', 'Bruce Springsteen', 'CBS 25100', 1982));
    store(
      db,
      release(24768692, 'Nebraska', 'Bruce Springsteen', '19658704921', 2022, [
        'LP',
        'Album',
        'Reissue',
      ]),
    );
    own(db, 1, 877497, '2026-08-30');
    own(db, 2, 24768692, '2023-05-14');

    const [group] = findDoubles(db);
    expect(group!.kind).toBe('reissue');
    expect(group!.why).toContain('different pressings');
  });

  it('orders the copies oldest pressing first', () => {
    store(db, release(2, 'Nebraska', 'Bruce Springsteen', '19658704921', 2022));
    store(db, release(1, 'Nebraska', 'Bruce Springsteen', 'CBS 25100', 1982));
    own(db, 1, 1, '2026-08-30');
    own(db, 2, 2, '2023-05-14');

    expect(findDoubles(db)[0]!.copies.map((c) => c.year)).toEqual([1982, 2022]);
  });

  it('reads the format the way a person writes it, not as stored JSON', () => {
    store(db, release(1, 'Nebraska', 'Bruce Springsteen', 'CBS 25100', 1982));
    store(db, release(2, 'Nebraska', 'Bruce Springsteen', 'X 1', 2022, ['LP', 'Album', 'Reissue']));
    own(db, 1, 1, '2026-08-30');
    own(db, 2, 2, '2023-05-14');

    const formats = findDoubles(db)[0]!.copies.map((c) => c.format);
    expect(formats).toEqual(['Vinyl (LP, Album)', 'Vinyl (LP, Album, Reissue)']);
    expect(formats.join()).not.toContain('[');
  });

  it('reports the same release owned twice as one group', () => {
    store(db, release(5, 'Money Talks', 'Bar-Kays', 'FS-1', 1978));
    own(db, 1, 5, '2023-01-01');
    own(db, 2, 5, '2023-01-02');

    const [group] = findDoubles(db);
    expect(group!.kind).toBe('same-copy');
    expect(group!.copies).toHaveLength(1);
    expect(group!.copies[0]!.instances).toHaveLength(2);
  });

  it('lets a record owned twice on purpose be dismissed too', () => {
    store(db, release(5, 'Money Talks', 'Bar-Kays', 'FS-1', 1978));
    own(db, 1, 5, '2023-01-01');
    own(db, 2, 5, '2023-01-02');
    expect(findDoubles(db)).toHaveLength(1);

    // One release dismissing itself, rather than a pair.
    ignorePair(db, 5, 5);
    expect(findDoubles(db)).toEqual([]);
  });

  it('puts the strongest signal first', () => {
    store(db, release(1, 'Nebraska', 'Bruce Springsteen', 'CBS 25100', 1982));
    store(db, release(2, 'Nebraska', 'Bruce Springsteen', '19658704921', 2022));
    store(db, release(3, 'Madvillainy', 'Madvillain', 'STH2065', 2019));
    store(db, release(4, 'Madvillainy', 'Madvillain', 'STH 2065', 2011));
    for (const [i, id] of [1, 2, 3, 4].entries()) own(db, 10 + i, id, '2023-01-01');

    expect(findDoubles(db).map((g) => g.kind)).toEqual(['same-pressing', 'reissue']);
  });

  it('ignores a release that is catalogued but no longer owned', () => {
    store(db, release(1, 'Nebraska', 'Bruce Springsteen', 'CBS 25100', 1982));
    store(db, release(2, 'Nebraska', 'Bruce Springsteen', '19658704921', 2022));
    expect(findDoubles(db)).toEqual([]);
  });

  it('stops reporting a pair the user marked as not a double', () => {
    store(db, release(1, 'Nebraska', 'Bruce Springsteen', 'CBS 25100', 1982));
    store(db, release(2, 'Nebraska', 'Bruce Springsteen', '19658704921', 2022));
    own(db, 1, 1, '2026-08-30');
    own(db, 2, 2, '2023-05-14');
    expect(findDoubles(db)).toHaveLength(1);

    ignorePair(db, 1, 2);
    expect(findDoubles(db)).toEqual([]);

    // And the same pair given in the other order is the same pair.
    unignorePair(db, 2, 1);
    expect(findDoubles(db)).toHaveLength(1);
  });
});
