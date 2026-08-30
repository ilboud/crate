import type { Db } from '../db/index.js';
import { browse, getAlbum, listGroups, search, stats } from '../server/queries.js';
import type { ToolSpec } from './backend.js';

/**
 * Tool policy for the chat assistant.
 *
 * The Discogs MCP server exposes 53 tools, 17 of which mutate the collection.
 * The assistant gets every read plus the two low-risk writes: rating a record
 * and editing a custom field. Both are reversible and useful conversationally.
 *
 * Adding, moving, deleting and folder management stay blocked — those are not
 * reversible, and are done through Discogs directly.
 *
 * This is enforced here, in code, before dispatch. A prompt instruction is not
 * a control: the model can be talked out of it, and a tool the model can name
 * is a tool it can call.
 */

export const ALLOWED_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'rate_release_in_user_collection',
  'edit_user_collection_custom_field_value',
]);

/** Anything matching these is a mutation unless explicitly allowed above. */
const MUTATION_PATTERNS: readonly RegExp[] = [
  /^add_/,
  /^create_/,
  /^delete_/,
  /^edit_/,
  /^move_/,
  /^rate_/,
  /^update_/,
  /^post_/,
  /^remove_/,
];

export function isMutatingTool(name: string): boolean {
  return MUTATION_PATTERNS.some((p) => p.test(name));
}

export function isToolAllowed(name: string): boolean {
  if (!isMutatingTool(name)) return true;
  return ALLOWED_MUTATING_TOOLS.has(name);
}

/** Filter an MCP tool list down to what policy permits. */
export function filterAllowedTools<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => isToolAllowed(t.name));
}

export interface LocalTool extends ToolSpec {
  run(db: Db, args: Record<string, unknown>): unknown;
}

/**
 * Tools backed by the local index. These answer the common questions with no
 * Discogs round-trip, so "what modal jazz do I own?" is instant.
 */
export const LOCAL_TOOLS: LocalTool[] = [
  {
    name: 'search_my_collection',
    description:
      'Search the local record collection by album title, song title, or artist. ' +
      'Returns matching albums, tracks (with the disc and side they are on), and artists. ' +
      'Use this for any question about what the user already owns.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text: album, song or artist name' },
      },
      required: ['query'],
    },
    run: (db, args) => search(db, String(args.query ?? ''), 15),
  },
  {
    name: 'browse_my_collection',
    description:
      'List owned albums filtered by genre group (e.g. "Jazz", "Soul / Funk"), style ' +
      '(e.g. "Modal", "Hard Bop"), or artist name. Use when asked what the user owns ' +
      'in a category rather than for a specific record.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Top-level genre group' },
        style: { type: 'string', description: 'Discogs style tag' },
        artist: { type: 'string', description: 'Exact artist name' },
        sort: { type: 'string', enum: ['artist', 'year', 'added', 'title'] },
      },
    },
    run: (db, args) =>
      browse(db, {
        group: args.group ? String(args.group) : undefined,
        style: args.style ? String(args.style) : undefined,
        artist: args.artist ? String(args.artist) : undefined,
        sort: args.sort as 'artist' | 'year' | 'added' | 'title' | undefined,
      }).slice(0, 60),
  },
  {
    name: 'get_album_details',
    description:
      'Full detail for one owned album by its Discogs release id: tracklist grouped by ' +
      'disc and side, labels, catalogue numbers, formats, and similar records owned.',
    inputSchema: {
      type: 'object',
      properties: { release_id: { type: 'number', description: 'Discogs release id' } },
      required: ['release_id'],
    },
    run: (db, args) => getAlbum(db, Number(args.release_id)) ?? { error: 'not in collection' },
  },
  {
    name: 'collection_overview',
    description:
      'Summary of the collection: how many records, copies, tracks and artists, plus the ' +
      'genre groups and how many records each holds.',
    inputSchema: { type: 'object', properties: {} },
    run: (db) => ({ ...stats(db), groups: listGroups(db) }),
  },
];

export const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOLS.map((t) => t.name));

export function runLocalTool(db: Db, name: string, args: Record<string, unknown>): unknown {
  const tool = LOCAL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown local tool: ${name}`);
  return tool.run(db, args);
}

export const SYSTEM_PROMPT = `You help someone explore their personal vinyl record collection.

Prefer the local tools (search_my_collection, browse_my_collection, get_album_details,
collection_overview) for anything about what they own — those are instant and authoritative.
Use the Discogs tools only for information the local index cannot answer: pressing variants,
other releases by an artist, marketplace data, or details of records not in the collection.

Be concise and concrete. Refer to records by artist and title. When you mention a specific
copy the user owns, include the label and catalogue number if it helps distinguish pressings.
If a search returns nothing, say so plainly rather than guessing.

You cannot add, move or delete records. If asked to, explain that those changes are made on
Discogs directly.`;
