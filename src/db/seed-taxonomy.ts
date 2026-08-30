import type { Database } from 'better-sqlite3';

/**
 * Seed taxonomy, derived from the real 245-record collection: 12 groups
 * covering all 136 distinct styles it contains. Editable at runtime through
 * the admin screen — this is only the starting point for a fresh install.
 *
 * Order here is also the tie-break precedence (specific -> general), used when
 * neither style majority nor the coarse genre can settle a group.
 */
export const SEED_GROUPS: Array<{ name: string; styles: string[] }> = [
  {
    name: 'Classical',
    styles: ['Modern Classical', 'Neo-Classical', 'Baroque', 'Romantic', 'Opera', 'Piano', 'Modern'],
  },
  {
    name: 'Reggae / Dub',
    styles: ['Dub', 'Roots Reggae', 'Dancehall', 'Ska'],
  },
  {
    name: 'Latin',
    styles: [
      'Afro-Cuban', 'Son', 'Salsa', 'Pachanga', 'Cubano', 'Rumba', 'Danzon', 'Guajira',
      'Mambo', 'Bolero', 'Cumbia', 'Latin Pop', 'MPB', 'Bossa Nova',
    ],
  },
  {
    name: 'Blues',
    styles: [
      'Electric Blues', 'Chicago Blues', 'Texas Blues', 'Country Blues', 'Memphis Blues',
      'Harmonica Blues', 'Modern Electric Blues',
    ],
  },
  {
    name: 'Jazz',
    styles: [
      'Hard Bop', 'Modal', 'Post Bop', 'Cool Jazz', 'Bop', 'Free Jazz', 'Swing', 'Big Band',
      'Fusion', 'Latin Jazz', 'Avant-garde Jazz', 'Contemporary Jazz', 'Afro-Cuban Jazz',
      'Future Jazz', 'Cape Jazz', 'Soul-Jazz', 'Jazz-Funk',
    ],
  },
  {
    name: 'Hip-Hop / R&B',
    styles: [
      'Conscious', 'Pop Rap', 'Jazzy Hip-Hop', 'Boom Bap', 'Hardcore Hip-Hop', 'Gangsta',
      'Hip Hop', 'Contemporary R&B', 'Grime', 'Cut-up/DJ',
    ],
  },
  {
    name: 'Soul / Funk',
    styles: [
      'Soul', 'Funk', 'Rhythm & Blues', 'Disco', 'Neo Soul', 'Gospel', 'Bayou Funk', 'Boogaloo',
    ],
  },
  {
    name: 'Soundtracks',
    styles: [
      'Soundtrack', 'Score', 'Theme With Variations', 'Story', 'Anison', 'Spoken Word',
      'Poetry', 'Field Recording',
    ],
  },
  {
    name: 'Electronic',
    styles: [
      'Downtempo', 'Ambient', 'Abstract', 'Leftfield', 'IDM', 'House', 'Deep House',
      'French House', 'Techno', 'Electro', 'Electro House', 'Synth-pop', 'UK Garage',
      'Trip Hop', 'Lo-Fi', 'Chiptune', 'Experimental', 'Avantgarde',
    ],
  },
  {
    name: 'Folk / World',
    styles: ['Folk', 'African', 'Afrobeat', 'Chanson', 'Country', 'Acoustic', 'Highlife', 'Vocal'],
  },
  {
    name: 'Rock',
    styles: [
      'Indie Rock', 'Alternative Rock', 'Psychedelic Rock', 'Hard Rock', 'Pop Rock',
      'Classic Rock', 'Punk', 'Garage Rock', 'Blues Rock', 'Folk Rock', 'Post Rock',
      'New Wave', 'Grunge', 'Prog Rock', 'Art Rock', 'Arena Rock', 'Heavy Metal',
      'Stoner Rock', 'Space Rock', 'Acid Rock', 'Rock & Roll', 'Post-Punk', 'Glam',
      'Country Rock', 'Jazz-Rock',
    ],
  },
  {
    name: 'Pop',
    styles: [
      'Indie Pop', 'Alt-Pop', 'Dream Pop', 'Ballad', 'Easy Listening', 'Lounge',
      'Space-Age', 'Ethereal', 'Instrumental', 'Indo-Pop',
    ],
  },
];

/** Discogs' coarse genre -> group. Breaks style ties and covers style-less releases. */
export const SEED_GENRES: Record<string, string> = {
  'Rock': 'Rock',
  'Jazz': 'Jazz',
  'Funk / Soul': 'Soul / Funk',
  'Hip Hop': 'Hip-Hop / R&B',
  'Electronic': 'Electronic',
  'Blues': 'Blues',
  'Latin': 'Latin',
  'Folk, World, & Country': 'Folk / World',
  'Reggae': 'Reggae / Dub',
  'Stage & Screen': 'Soundtracks',
  'Classical': 'Classical',
  'Pop': 'Pop',
  "Children's": 'Soundtracks',
};

/** Idempotent: skips entirely if any group already exists. */
export function seedTaxonomy(db: Database): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM taxonomy_group').get() as { n: number };
  if (existing.n > 0) return;

  const insertGroup = db.prepare(
    'INSERT INTO taxonomy_group (name, sort_order, hidden) VALUES (?, ?, 0)',
  );
  const insertStyle = db.prepare(
    'INSERT OR REPLACE INTO taxonomy_style (style, group_id) VALUES (?, ?)',
  );
  const insertGenre = db.prepare(
    'INSERT OR REPLACE INTO taxonomy_genre (genre, group_id) VALUES (?, ?)',
  );

  db.transaction(() => {
    const ids = new Map<string, number>();
    SEED_GROUPS.forEach((g, i) => {
      const info = insertGroup.run(g.name, i);
      ids.set(g.name, Number(info.lastInsertRowid));
    });
    for (const g of SEED_GROUPS) {
      const gid = ids.get(g.name)!;
      for (const s of g.styles) insertStyle.run(s, gid);
    }
    for (const [genre, groupName] of Object.entries(SEED_GENRES)) {
      const gid = ids.get(groupName);
      if (gid !== undefined) insertGenre.run(genre, gid);
    }
    db.prepare('INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)').run(
      'hide_group_below',
      '3',
    );
  })();
}
