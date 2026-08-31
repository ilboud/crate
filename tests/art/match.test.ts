import { describe, it, expect } from 'vitest';
import { normalise, similarity, verify, type Candidate } from '../../src/art/match.js';

const cand = (artist: string, title: string, extra: Partial<Candidate> = {}): Candidate => ({
  artist,
  title,
  imageUrl: 'https://example.test/a.jpg',
  source: 'itunes',
  ...extra,
});

describe('normalise', () => {
  it('strips edition noise that differs between services', () => {
    expect(normalise('Kind Of Blue (Remastered)')).toBe(normalise('Kind of Blue'));
    expect(normalise('Bitches Brew [Deluxe Edition]')).toBe(normalise('Bitches Brew'));
    expect(normalise('Time Out — 50th Anniversary Edition')).toBe(normalise('Time Out 50th'));
  });

  it('strips the Discogs same-name disambiguator', () => {
    expect(normalise('Sublime (2)')).toBe(normalise('Sublime'));
    expect(normalise('Barbara (5)')).toBe(normalise('Barbara'));
  });

  it('drops a trailing year that rides along with an edition note', () => {
    // Real rejection: "Acid" vs "Acid (Remastered 2024)" scored 0.55 because
    // the year survived, which is fatal on a short title.
    expect(normalise('Acid (Remastered 2024)')).toBe(normalise('Acid'));
    expect(normalise('Sahara [2019 Reissue]')).toBe(normalise('Sahara'));
  });

  it('keeps a title that is genuinely a year range', () => {
    expect(normalise('1973 - 1980')).toBe('1973 1980');
  });

  it('folds accents so ASCII and accented spellings match', () => {
    expect(normalise('Sigur Rós')).toBe(normalise('Sigur Ros'));
    expect(normalise('Amara Touré')).toBe(normalise('Amara Toure'));
  });
});

describe('similarity', () => {
  it('scores identical strings 1', () => {
    expect(similarity('Kind of Blue', 'Kind Of Blue')).toBe(1);
  });

  it('scores unrelated strings low', () => {
    expect(similarity('The Low End Theory', 'We got it from Here')).toBeLessThan(0.4);
  });

  it('is tolerant of small differences', () => {
    expect(similarity('Porgy and Bess', 'Porgy & Bess')).toBeGreaterThan(0.85);
  });
});

describe('verify', () => {
  const target = { artist: 'A Tribe Called Quest', title: 'The Low End Theory' };

  it('REJECTS the real-world false positive that motivated this check', () => {
    // iTunes returned this, top-ranked, when asked for The Low End Theory.
    const wrong = cand('A Tribe Called Quest', 'We got it from Here... Thank You 4 Your service');
    const v = verify(target, wrong);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('title');
  });

  it('accepts the correct album', () => {
    expect(verify(target, cand('A Tribe Called Quest', 'The Low End Theory')).ok).toBe(true);
  });

  it('accepts a remastered edition of the same album', () => {
    expect(verify(target, cand('A Tribe Called Quest', 'The Low End Theory (Remastered)')).ok).toBe(true);
  });

  it('accepts a short title carrying a remaster year', () => {
    const v = verify({ artist: 'Ray Barretto', title: 'Acid' },
      cand('Ray Barretto', 'Acid (Remastered 2024)'));
    expect(v.ok).toBe(true);
  });

  it('rejects the right title by the wrong artist', () => {
    const v = verify(
      { artist: 'Miles Davis', title: 'Kind of Blue' },
      cand('The Dave Brubeck Quartet', 'Kind of Blue'),
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('artist');
  });

  it('matches a collaboration when the service lists only the first credit', () => {
    const v = verify(
      { artist: 'Miles Davis / John Coltrane', title: 'The Final Tour' },
      cand('Miles Davis', 'The Final Tour'),
    );
    expect(v.ok).toBe(true);
  });

  it('trusts a barcode match without fuzzy scoring', () => {
    const v = verify(
      { artist: 'Whatever', title: 'Whatever' },
      cand('Different Name', 'Different Title', { exact: true, source: 'caa' }),
    );
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('barcode match');
  });

  it('rejects a compilation that merely contains the artist', () => {
    const v = verify(
      { artist: 'Aretha Franklin', title: 'Aretha Now' },
      cand('Aretha Franklin', 'The Very Best of Aretha Franklin, Vol. 1'),
    );
    expect(v.ok).toBe(false);
  });

  it('rejects a live album when the target is the studio record', () => {
    const v = verify(
      { artist: 'King Curtis', title: 'Live At Fillmore West' },
      cand('King Curtis', 'Instant Groove'),
    );
    expect(v.ok).toBe(false);
  });
});
