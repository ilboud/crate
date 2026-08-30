import { Router } from 'express';
import type { Db } from '../../db/index.js';
import { browse, getAlbum, listGroups, listStyles, search, stats, type SortKey } from '../queries.js';

const SORT_KEYS = new Set<SortKey>(['artist', 'year', 'added', 'title']);

function asSort(value: unknown): SortKey {
  return typeof value === 'string' && SORT_KEYS.has(value as SortKey) ? (value as SortKey) : 'artist';
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function collectionRoutes(db: Db): Router {
  const r = Router();

  r.get('/stats', (_req, res) => res.json(stats(db)));

  r.get('/groups', (_req, res) => res.json(listGroups(db)));

  r.get('/styles', (req, res) => res.json(listStyles(db, asString(req.query.group))));

  r.get('/browse', (req, res) => {
    res.json(
      browse(db, {
        group: asString(req.query.group),
        style: asString(req.query.style),
        artist: asString(req.query.artist),
        sort: asSort(req.query.sort),
      }),
    );
  });

  r.get('/albums/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const album = getAlbum(db, id);
    if (!album) return res.status(404).json({ error: 'not found' });
    return res.json(album);
  });

  r.get('/search', (req, res) => {
    const q = asString(req.query.q);
    if (!q) return res.json({ albums: [], tracks: [], artists: [] });
    return res.json(search(db, q));
  });

  return r;
}
