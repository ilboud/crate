# Discogs Collection App — Design

**Date:** 2026-08-30
**Status:** Approved, ready for implementation planning
**Discogs user:** Ilboud (id 16645087) — 245 collection items covering 244
distinct releases (one record is owned twice), 248 vinyl, 67 multi-disc

## Purpose

A browsing app for a personal vinyl collection, run on a home Synology NAS.
The primary moment it serves is standing at the shelf deciding what to play:
flip through cover art the way an iPod flipped through album covers, drill in
by genre or artist, find which record holds a given song, and ask questions in
plain language.

Phase 1 recommends *inward* — records already owned. Phase 2 (not in this
spec) adds *outward* discovery of records not owned. The data model is
designed so phase 2 does not require restructuring.

## Constraints

| Constraint | Decision |
|---|---|
| Devices | iPad, Android phone, laptop browser — responsive, touch-first |
| Access | LAN only. No authentication, no public exposure |
| Collection volatility | Near-static; a few additions per month at most |
| Discogs rate limit | 60 requests/min authenticated |
| Secrets | Discogs token and LLM API keys stay server-side |

The static collection is load-bearing: it makes a periodic sync viable and
removes any need for cache invalidation or live Discogs calls when browsing.

## Architecture

One container serves the app; a second runs the Discogs MCP server.

```
┌─ Synology (docker compose) ───────────────────┐
│  discogs-app                                  │
│    ├─ SPA (cover flow, browse, search, chat)  │
│    ├─ /api/search   → SQLite + FTS5           │
│    ├─ /covers/*     → mirrored art            │
│    └─ /api/chat     → SSE stream              │
│          ├─ ChatBackend ─┬─ Anthropic         │
│          │               └─ OpenAI            │
│          └─ MCP client ──────────┐            │
│  discogs-mcp  (stream mode :3001)◄┘           │
└───────────────────────────────────────────────┘
   volumes: ./data (sqlite)  ./covers
```

Responsibilities are split by what each component is actually good at:

- **SQLite + FTS5** — all browse and search queries. Indexed, local, instant.
- **MCP** — chat tool-calling only. It returns LLM-shaped payloads, so it is
  the wrong transport for bulk data; sync talks to the Discogs REST API
  directly.
- **SPA** — presentation only. No Discogs knowledge.

### Rejected alternatives

- *Static JSON bundle, no database.* Simpler, but searching ~3,000 tracks
  client-side on a phone is poor, and phase 2 would need a rewrite.
- *All traffic through MCP.* Uniform but slower: an extra JSON-RPC hop per
  query, LLM-shaped text re-parsed into structured data, clumsy bulk sync.

## Genre taxonomy

Discogs genres are too coarse (`Funk / Soul` covers everything) and its styles
too granular (136 distinct styles, 60+ appearing once). The app defines twelve
curated top-level groups that roll up styles, with styles as the second level.

Every album belongs to exactly **one** primary group, assigned by four tiers:

| Tier | Rule | Albums |
|---|---|---:|
| 1 | Manual override in `release_override`, keyed by release id | as needed |
| 2 | Style majority — group matching the most of the album's styles | 202 |
| 3 | Genre tie-break — Discogs' coarse `genre` field breaks style ties | 11 |
| 4 | Fixed precedence, or genre alone for the 20 style-less releases | 32 |

Tier 3 matters: without it, *Blonde On Blonde* files under Soul/Funk and
*De-Loused In The Comatorium* under Electronic. Tier 1 exists because rules
plateau — roughly 12 albums remain genuinely ambiguous, and a short hand-edited
list is clearer than heuristics that would still be wrong sometimes.

### Groups

| Group | Albums | Rolls up |
|---|---:|---|
| Jazz | 62 | Hard Bop, Modal, Post Bop, Cool, Free, Fusion, Soul-Jazz, Jazz-Funk |
| Rock | 54 | Indie, Alternative, Psychedelic, Hard, Punk, Garage, Prog, Post-Punk |
| Soul / Funk | 36 | Soul, Funk, Rhythm & Blues, Disco, Neo Soul, Gospel, Boogaloo |
| Hip-Hop / R&B | 20 | Conscious, Boom Bap, Jazzy Hip-Hop, Pop Rap, Contemporary R&B |
| Electronic | 18 | Downtempo, Ambient, Abstract, IDM, House, Techno, Trip Hop |
| Folk / World | 18 | Folk, African, Afrobeat, Chanson, Country, Highlife |
| Blues | 11 | Electric, Chicago, Texas, Country, Memphis |
| Soundtracks | 10 | Soundtrack, Score, Spoken Word, Anison |
| Latin | 6 | Afro-Cuban, Son, Salsa, Mambo, Bossa Nova, Cumbia |
| Classical | 5 | Modern Classical, Baroque, Romantic, Opera |
| Pop | 3 | Indie Pop, Dream Pop, Alt-Pop, Lounge |
| Reggae / Dub | 1 | Dub, Roots Reggae, Ska, Dancehall |

Totals sum to 244 — the distinct releases. Groups holding fewer than 3 albums
are hidden from top-level navigation and reachable through search.

### Editing the taxonomy

The taxonomy is **runtime-editable through an admin settings screen**, not a
file that requires a redeploy. It is stored in the database:

```
taxonomy_group(id PK, name, sort_order, hidden)
taxonomy_style(style PK, group_id FK)
release_override(release_id PK, group_id FK, note)
```

The admin screen supports:

- Create, rename, reorder and delete groups
- Move a style from one group to another (drag or select); unassigned styles
  are listed so nothing silently falls through
- Set a per-album override, which is tier 1 and wins over every rule
- Toggle the "hide groups with fewer than N albums" threshold

Saving triggers immediate reassignment of every release — a sub-second
operation at this collection size — and the affected `similar` rows are
recomputed. No sync or restart is needed.

Seed data ships as a migration containing the twelve groups above, so a fresh
install is useful before any editing. An export/import action writes the whole
taxonomy as JSON, which keeps it diffable in git and portable between installs.

## Data model

SQLite via `better-sqlite3`, one file on a mounted volume.

```
release(id PK, master_id, title, year, primary_group, assign_method,
        cover_path, thumb_path, raw_json)
collection_item(instance_id PK, release_id FK, folder_id, date_added)
artist(id PK, name)
release_artist(release_id, artist_id, seq, join_str)
label(id PK, name)
release_label(release_id, label_id, catno)
release_genre(release_id, genre)
release_style(release_id, style)
track(id PK, release_id, seq, position_raw, disc, side,
      index_on_side, title, duration_sec)
similar(release_id, other_id, score, reason)
sync_run(id PK, started_at, finished_at, ok_count, failed_ids)

taxonomy_group(id PK, name, sort_order, hidden)
taxonomy_style(style PK, group_id FK)
release_override(release_id PK, group_id FK, note)
setting(key PK, value)
```

`release.primary_group` is derived, not authoritative — it is recomputed from
the taxonomy tables whenever the taxonomy or the collection changes.

An FTS5 virtual table indexes `track.title` with denormalized artist and album
names, making song search a single indexed query across ~3,000 tracks.

A release can be owned more than once — the collection holds two copies of
Bar-Kays *Money Talks* — so physical copies live in `collection_item` rather
than as columns on `release`. Browsing lists distinct releases; the copy count
comes from that table. Group totals therefore sum to 244, not 245.

### Track positions

Discogs encodes vinyl position as a side letter with an optional index, and
never states the disc number. Two cases must both be handled:

```
"A"   → disc 1, side A, whole side      (Pharaoh's Dance, 20:07)
"C2"  → disc 2, side C, track 2         (John McLaughlin, 4:23)
```

Parse with `^([A-Z]+)(\d*)$`; derive `disc = ceil(letterIndex / 2)`. A parser
requiring a digit silently drops whole-side tracks. Non-vinyl forms (`1-1`,
plain `1`) fall back to sequential numbering.

## Sync

`npm run sync` — incremental and idempotent.

1. Page the collection → current set of release ids (2 API calls)
2. Diff against the database → new, removed, unchanged
3. For new ids only: fetch release detail, parse tracklist, mirror cover art
4. Remove rows for releases no longer in the collection
5. Recompute primary groups, rebuild FTS index, recompute `similar`

Throttled to ~50 req/min, under the 60 limit. Per-release failures are
recorded in `sync_run.failed_ids` and retried on the next run — a failed
release must never abort the run or corrupt the index. Observed in testing:
individual `get_release` calls do fail under sustained load.

First run takes roughly 5 minutes for 245 releases. Subsequent runs touch only
what changed. `--force` re-fetches everything, needed after taxonomy edits.

Cover art mirrors to `covers/{id}-full.jpg` and `covers/{id}-thumb.jpg` and is
served locally, so browsing never waits on Discogs and works when Discogs does
not.

## User interface

Responsive across three device classes; touch-first, no fixed-width layouts.

### Cover flow

The landing screen. Implemented with CSS 3D transforms (`rotateY` +
`translateZ` on neighbours) and pointer events — no carousel library, which
would fight touch handling on iOS. Driven by swipe, trackpad and arrow keys.
Renders thumbnails; prefetches the full image only for the centred album.

| Device | Neighbours visible | Detail presentation |
|---|---|---|
| Phone (portrait) | 2 each side | full-screen sheet |
| iPad | 3–4 each side | side panel |
| Laptop | 5+ each side | side panel |

### Album detail

Tracks group by disc, then side. Whole-side tracks render without a phantom
track number:

```
Disc 1   Side A    Pharaoh's Dance             20:07
         Side B    Bitches Brew                27:00
Disc 2   Side C  1 Spanish Key                 17:30
                 2 John McLaughlin              4:23
         Side D  1 Miles Runs The Voodoo Down  14:03
                 2 Sanctuary                   10:54
```

Also shows label, catalogue number, year, format descriptors, primary group and
styles.

### Search

One input, three result segments: **Albums**, **Tracks**, **Artists**. A track
result names the album, disc and side holding it — satisfying "search by song,
see every album that includes it". A song appearing on several pressings
returns all of them.

### Browse

Twelve groups → styles → albums. Sortable by artist, year released, or date
added.

## Recommendations

Content-based scoring between owned releases, precomputed at sync into the
`similar` table. All pairs is only ~30,000 comparisons, so recommendations are
a lookup at request time.

Score components:

| Signal | Weight |
|---|---|
| Shared styles, IDF-weighted | `Σ log(N / (1 + df(style)))` |
| Shared Discogs genres | 0.6 each |
| Shared label | 1.4 |
| Era proximity | `max(0, 1.2 − abs(yearA − yearB) / 15)` |

IDF weighting is essential at this collection size: sharing `Modal` (9 albums)
scores ~3.3 while sharing `Soul` (28 albums) scores ~2.2, so rare overlaps
surface instead of drowning.

Results present as two rails:

- **You might also like** — different artists only
- **More by this artist** — same artist, listed separately

The split is deliberate. With same-artist scored in one list, every Miles Davis
record simply recommends five other Miles Davis records, which the owner
already knows about.

Each suggestion carries its reason (`"Modal; on Columbia"`), so the
recommendation is explainable rather than opaque.

Known tunable: a shared style tag can produce a musically poor match
(*Bitches Brew* → *Check Your Head*, both tagged `Fusion`). Requiring a shared
top-level group as a tiebreaker suppresses these.

## Chat

Server-side only; browsers never receive API keys. Responses stream over SSE.

Backends sit behind one interface, with **Anthropic and OpenAI both available
from day one**, selected by environment variable:

```
interface ChatBackend {
  send(messages, tools): AsyncIterable<Delta>
}
```

A third `OllamaBackend` may be added later without touching callers.

The assistant receives two tool sets:

- **Local tools** backed by SQLite (`search_my_collection`, `get_album_tracks`)
  — answer common questions instantly with no Discogs round-trip
- **MCP tools** from the Discogs MCP server — anything only Discogs knows
  (pressing variants, marketplace, artist discographies)

### Tool policy

Of the MCP server's 53 tools, 17 mutate the collection. The assistant is
allowed **reads plus low-risk writes**:

| Allowed | Blocked |
|---|---|
| all 36 read tools | `add_release_to_user_collection_folder` |
| `rate_release_in_user_collection` | `delete_release_from_user_collection_folder` |
| `edit_user_collection_custom_field_value` | `move_release_in_user_collection` |
| | folder create / edit / delete |

Rating a record conversationally is useful and reversible. Adding, moving and
deleting are not, and are done through Discogs directly.

The allowlist is enforced server-side, in the app — never by prompt
instructions alone.

## Deployment

`docker-compose.yml` with two services, deployed through Synology Container
Manager:

- `discogs-mcp` — `discogs-mcp-server` in `stream` mode on port 3001, holding
  `DISCOGS_PERSONAL_ACCESS_TOKEN`
- `discogs-app` — the web app, holding the LLM keys, reaching the MCP service
  over the Docker network

Volumes: `./data` (SQLite), `./covers` (mirrored art). Bound to the LAN
interface only. Sync runs as a manual command or a weekly cron in the app
container.

## Testing

| Layer | Approach |
|---|---|
| Position parser | Unit tests over real fixtures: `"A"`, `"C2"`, `"1-1"`, `"1"` |
| Taxonomy assignment | Fixture-based; asserts all 245 assign and totals match |
| Sync | Mocked Discogs responses; asserts idempotency, failure isolation, deletion handling |
| Search | FTS queries against a seeded database, including multi-pressing songs |
| Recommendations | Asserts same-artist exclusion and IDF ordering |
| Chat | Mocked backends; asserts the mutating-tool allowlist is enforced |

Sync failure isolation deserves particular care: it is the one path that can
corrupt the index, and real API failures were observed during design.

## Out of scope (phase 2)

- Outward discovery of records not owned
- Wantlist and marketplace integration
- Authentication and public exposure
- Play history and statistics
- Ollama backend

## Open item

The collection currently contains one known data error: *Porgy And Bess*
(instance 2179103464) is recorded as the 1997 CD `CK 65141` but the physical
copy is a mono LP, catalogue `CL 1274`, two-eye "360 Sound" label. Three
candidate releases remain (8233787, 9084425, 36745756), distinguished by
whether "360 Sound" runs around the rim or sits at the bottom, and whether
"unbreakable" appears under the catalogue number. Correcting this is
independent of the app build.
