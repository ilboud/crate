# Discogs Collection App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a LAN-only web app for browsing a 245-record vinyl collection on a Synology NAS — cover-flow browsing, genre/artist navigation, song-level search, recommendations, and a chat interface backed by the Discogs MCP server.

**Architecture:** A single Node/TypeScript container serves a React SPA, a read-only search API over SQLite (FTS5 for track search), and a chat proxy that attaches both local SQLite tools and remote MCP tools to an LLM. A separate container runs `discogs-mcp-server` in HTTP stream mode. Sync is a CLI command that pulls the collection from the Discogs REST API into SQLite and mirrors cover art to disk.

**Tech Stack:** Node 20+, TypeScript (ESM), better-sqlite3, Express, Vitest, React 18, Vite, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-30-discogs-collection-app-design.md`

## Global Constraints

- Node 20+; TypeScript ESM (`"type": "module"`), `moduleResolution: "bundler"`.
- Discogs user is `Ilboud` (id 16645087); collection folder `0` is "All".
- Discogs API rate limit is 60 req/min authenticated — sync throttles to 50/min.
- Discogs API requires a `User-Agent` header or it returns 403.
- Secrets (`DISCOGS_PERSONAL_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) are read from the environment server-side only and must never reach the browser.
- The app binds to LAN only; there is no authentication layer.
- The mutating-MCP-tool allowlist is enforced in server code, never by prompt text alone.
- All 245 releases must receive exactly one primary group; group counts sum to 245.
- Track position parsing must handle whole-side positions (`"A"`) as well as indexed (`"C2"`).

---

## File Structure

```
package.json                     workspace root, scripts
tsconfig.json                    shared TS config
vitest.config.ts

src/shared/types.ts              domain types shared server/sync/web

src/db/schema.sql                full DDL incl. FTS5
src/db/seed-taxonomy.ts          the 12 groups + style mappings
src/db/index.ts                  openDb(), migrate(), transaction helpers

src/sync/position.ts             parsePosition() — pure
src/sync/taxonomy.ts             assignGroup(), reassignAll() — pure + db
src/sync/similar.ts             computeSimilar() — pure + db
src/sync/discogs.ts              rate-limited REST client
src/sync/covers.ts               cover mirroring
src/sync/sync.ts                 orchestrator
src/sync/cli.ts                  `npm run sync` entry

src/server/index.ts              express bootstrap
src/server/routes/search.ts      /api/search
src/server/routes/browse.ts      /api/browse, /api/groups
src/server/routes/albums.ts      /api/albums/:id
src/server/routes/admin.ts       /api/admin/taxonomy/*
src/server/routes/chat.ts        /api/chat (SSE)

src/chat/backend.ts              ChatBackend interface + types
src/chat/anthropic.ts            AnthropicBackend
src/chat/openai.ts               OpenAIBackend
src/chat/mcp.ts                  MCP client (HTTP stream)
src/chat/tools.ts                local SQLite tools + allowlist

web/                             Vite React SPA
  src/App.tsx, src/api.ts
  src/components/CoverFlow.tsx
  src/components/AlbumDetail.tsx
  src/components/Browse.tsx
  src/components/Search.tsx
  src/components/Chat.tsx
  src/components/AdminTaxonomy.tsx

tests/                           mirrors src/
docker/Dockerfile
docker-compose.yml
.env.example
```

Rationale: pure logic (`position`, `taxonomy`, `similar`) is separated from I/O so it can be unit-tested against fixtures with no database or network. Routes are one file per resource so each stays small.

---

### Task 1: Project scaffold and database schema

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/db/schema.sql`, `src/db/index.ts`, `src/db/seed-taxonomy.ts`
- Create: `src/shared/types.ts`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Produces: `openDb(path: string): Database`, `migrate(db: Database): void`, `seedTaxonomy(db: Database): void`

- [ ] **Step 1: Write the failing test** — assert migrate creates every table, the FTS5 table works, and seeding yields 12 groups with 136 style mappings.
- [ ] **Step 2: Run test, verify it fails** (`npx vitest run tests/db`)
- [ ] **Step 3: Write `schema.sql`, `db/index.ts`, `seed-taxonomy.ts`**
- [ ] **Step 4: Run test, verify pass**
- [ ] **Step 5: Commit** — `feat: add database schema and taxonomy seed`

### Task 2: Track position parser

**Files:**
- Create: `src/sync/position.ts`
- Test: `tests/sync/position.test.ts`

**Interfaces:**
- Produces: `parsePosition(raw: string, seq: number): { disc: number; side: string | null; indexOnSide: number | null }`

Cases that must pass, taken from real releases:

| Input | disc | side | indexOnSide |
|---|---|---|---|
| `"A"` | 1 | `"A"` | `null` |
| `"B"` | 1 | `"B"` | `null` |
| `"C1"` | 2 | `"C"` | 1 |
| `"D4"` | 2 | `"D"` | 4 |
| `"E1"` | 3 | `"E"` | 1 |
| `"1-1"` | 1 | `null` | 1 |
| `"1"` | 1 | `null` | 1 |
| `""` | 1 | `null` | seq |

- [ ] **Step 1: Write the failing test** covering the table above
- [ ] **Step 2: Run, verify fail**
- [ ] **Step 3: Implement** using `^([A-Z]+)(\d*)$`, `disc = ceil(letterIndex / 2)`
- [ ] **Step 4: Run, verify pass**
- [ ] **Step 5: Commit** — `feat: parse Discogs vinyl track positions`

### Task 3: Taxonomy assignment engine

**Files:**
- Create: `src/sync/taxonomy.ts`
- Test: `tests/sync/taxonomy.test.ts`, `tests/fixtures/collection.json`

**Interfaces:**
- Consumes: taxonomy tables from Task 1
- Produces: `assignGroup(release, taxonomy): { group: string; how: AssignMethod }`, `reassignAll(db): void`

Four tiers in order: override → style majority → genre tie-break → precedence/genre-only.

Known-correct assertions (verified against the real collection during design):

- `Blonde On Blonde` → Rock (genre tie-break, not Soul/Funk)
- `De-Loused In The Comatorium` → Rock (genre tie-break, not Electronic)
- `King Curtis — Live At Fillmore West` → Soul / Funk
- All 245 fixtures assign; totals sum to 245

- [ ] **Step 1: Write failing tests** including the four assertions above
- [ ] **Step 2: Run, verify fail**
- [ ] **Step 3: Implement the four tiers**
- [ ] **Step 4: Run, verify pass**
- [ ] **Step 5: Commit** — `feat: assign primary genre groups`

### Task 4: Discogs client and sync

**Files:**
- Create: `src/sync/discogs.ts`, `src/sync/covers.ts`, `src/sync/sync.ts`, `src/sync/cli.ts`
- Test: `tests/sync/sync.test.ts`

**Interfaces:**
- Consumes: `parsePosition`, `reassignAll`
- Produces: `runSync(db, opts: { force?: boolean }): Promise<SyncResult>`

Requirements: incremental (fetch details only for new ids), idempotent (second run is a no-op), failure-isolating (a failed release is recorded in `sync_run.failed_ids` and does not abort), and deletion-aware (removed releases are pruned).

- [ ] **Step 1: Write failing tests** with a mocked Discogs client: fresh sync, re-sync no-op, one release failing, one release removed
- [ ] **Step 2: Run, verify fail**
- [ ] **Step 3: Implement client (throttle, User-Agent, retry/backoff), covers, orchestrator, CLI**
- [ ] **Step 4: Run, verify pass**
- [ ] **Step 5: Commit** — `feat: sync collection from Discogs`

### Task 5: Recommendations

**Files:**
- Create: `src/sync/similar.ts`
- Test: `tests/sync/similar.test.ts`

**Interfaces:**
- Produces: `computeSimilar(releases): SimilarRow[]`, `storeSimilar(db, rows): void`

Scoring: IDF-weighted shared styles + 0.6 per shared genre + 1.4 shared label + `max(0, 1.2 - abs(Δyear)/15)`. Same-artist pairs are stored with a flag so the API can split the two rails.

Assertions: `Kind Of Blue` recommends Brubeck/Tyner/Marsalis (modal) ahead of unrelated records; no same-artist entry appears in the "also like" rail.

- [ ] **Step 1: Write failing tests**
- [ ] **Step 2: Run, verify fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, verify pass**
- [ ] **Step 5: Commit** — `feat: compute collection recommendations`

### Task 6: HTTP API

**Files:**
- Create: `src/server/index.ts` and `src/server/routes/{search,browse,albums,admin}.ts`
- Test: `tests/server/api.test.ts`

Endpoints:

| Method | Path | Returns |
|---|---|---|
| GET | `/api/groups` | groups with counts, hidden flag |
| GET | `/api/browse?group=&style=&sort=` | album cards |
| GET | `/api/albums/:id` | album + tracks grouped by disc/side + both recommendation rails |
| GET | `/api/search?q=` | `{ albums, tracks, artists }` |
| GET | `/api/admin/taxonomy` | groups, style mappings, unassigned styles |
| PUT | `/api/admin/taxonomy/style` | move a style to a group, then reassign |
| POST/PATCH/DELETE | `/api/admin/taxonomy/group` | create/rename/reorder/delete |
| PUT | `/api/admin/override/:releaseId` | per-album override, then reassign |

- [ ] **Step 1: Write failing supertest tests against a seeded temp DB**
- [ ] **Step 2: Run, verify fail**
- [ ] **Step 3: Implement routes**
- [ ] **Step 4: Run, verify pass**
- [ ] **Step 5: Commit** — `feat: add collection HTTP API`

### Task 7: Chat backends and MCP

**Files:**
- Create: `src/chat/{backend,anthropic,openai,mcp,tools}.ts`, `src/server/routes/chat.ts`
- Test: `tests/chat/tools.test.ts`, `tests/chat/allowlist.test.ts`

**Interfaces:**
- Produces: `interface ChatBackend { send(messages, tools): AsyncIterable<Delta> }`, `isToolAllowed(name: string): boolean`

Allowlist: all 36 read tools plus `rate_release_in_user_collection` and `edit_user_collection_custom_field_value`. Everything matching add/delete/move/folder-mutation is denied. The denial happens before dispatch.

- [ ] **Step 1: Write failing tests** — allowlist denies `delete_release_from_user_collection_folder`, permits `rate_release_in_user_collection`; local tools return real rows
- [ ] **Step 2: Run, verify fail**
- [ ] **Step 3: Implement interface, both backends, MCP client, local tools, SSE route**
- [ ] **Step 4: Run, verify pass**
- [ ] **Step 5: Commit** — `feat: add chat with MCP tool access`

### Task 8: Web frontend

**Files:**
- Create: `web/` Vite React app and the components listed in File Structure

Cover flow uses CSS 3D transforms and pointer events, no carousel library. Responsive breakpoints: phone (2 neighbours, full-screen detail sheet), iPad (3–4, side panel), laptop (5+, side panel).

- [ ] **Step 1: Scaffold Vite React app, wire dev proxy to the API**
- [ ] **Step 2: Build CoverFlow with keyboard + swipe + trackpad**
- [ ] **Step 3: Build AlbumDetail with disc/side grouping and both recommendation rails**
- [ ] **Step 4: Build Browse, Search, Chat, AdminTaxonomy**
- [ ] **Step 5: Verify responsive at 390px, 820px, 1440px**
- [ ] **Step 6: Commit** — `feat: add web frontend`

### Task 9: Docker deployment

**Files:**
- Create: `docker/Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`

Two services: `discogs-app` (built image, holds LLM keys) and `discogs-mcp` (`node:20-alpine` running `npx -y discogs-mcp-server stream`, holds the Discogs token). Volumes `./data` and `./covers`. Ports bound to the LAN interface.

- [ ] **Step 1: Write multi-stage Dockerfile (build web + server, run node)**
- [ ] **Step 2: Write docker-compose.yml with both services and healthchecks**
- [ ] **Step 3: Write .env.example and README deployment section**
- [ ] **Step 4: Verify `docker compose config` parses**
- [ ] **Step 5: Commit** — `feat: add Docker deployment for Synology`

---

## Self-Review

**Spec coverage:** taxonomy (Tasks 1, 3, 6-admin), data model (1), position parsing (2), sync (4), recommendations (5), search/browse/detail (6, 8), cover flow (8), chat + allowlist (7), deployment (9). Admin taxonomy editing is covered by Task 6's endpoints and Task 8's `AdminTaxonomy` component.

**Type consistency:** `parsePosition` returns `{disc, side, indexOnSide}`, used identically in Task 4's track insertion and Task 6's disc/side grouping. `assignGroup` returns `{group, how}` in Tasks 3 and 4.

**Known gap accepted:** end-to-end browser tests are not included; the frontend is verified manually at the three breakpoints.
