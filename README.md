# Records

A browser for a personal vinyl collection, running on a home NAS. Flip through
cover art the way an iPod flipped through covers, drill in by genre, find which
record holds a given song, and ask questions in plain language.

Built for one shelf and one household: LAN only, no accounts, no login.

## What it does

- **Crate** — cover flow across the whole collection, driven by swipe, trackpad,
  arrow keys or the scrubber. Tap a sleeve to open it.
- **Album** — the record slides out of its sleeve; a multi-disc set fans one
  disc per record. Tracks are grouped by disc and side, with side runtimes. A
  track that fills a whole side shows no track number, because it has none.
- **Shelf** — grid browse by genre group, style or artist, sorted by artist,
  year, date added or title.
- **Search** — one box, three answers: records, songs and artists. A song hit
  names the disc and side it lives on, and returns every pressing that carries
  it.
- **Ask** — chat about the collection. Local questions are answered from the
  index instantly; anything only Discogs knows goes out to the MCP server.
- **Genres** — edit the genre taxonomy at runtime. Moving a style re-files
  every record carrying it, immediately.
- **Library** — sync with Discogs on a button or a schedule, and see which
  records look filed twice. Catalogue numbers separate a duplicate entry from
  an original-and-reissue you meant to own.
- **Full screen** — one button in the header; Escape leaves again.

## Requirements

- Node 20+ (for local development), or Docker (for the NAS)
- A Discogs personal access token —
  [Settings → Developers](https://www.discogs.com/settings/developers)
- Optionally an Anthropic or OpenAI API key, for chat

**The Discogs token can modify your collection.** Keep it off the internet.

## Running it locally

```bash
npm install
npm --prefix web install

export DISCOGS_PERSONAL_ACCESS_TOKEN=...
npm run sync          # first run pulls ~250 releases, about 5 minutes
npm run build
npm start             # http://localhost:8080
```

For development with hot reload, run `npm run dev` and `npm --prefix web run dev`
in two terminals; the Vite dev server proxies `/api` and `/covers` to the server.

## Deploying to a Synology NAS

```bash
cp .env.example .env      # fill in the token, and an API key if you want chat
docker compose up -d --build
docker compose exec discogs-app node dist/src/sync/cli.js   # ~5 min, first run
docker compose exec discogs-app node dist/src/art/cli.js    # optional, sharper covers
```

The app is then at `http://<nas>:8088`. Point Container Manager at the same
compose file if you prefer the DSM UI.

Two containers come up: `discogs-app` and `discogs-mcp` (the Discogs MCP server
in HTTP stream mode). State lives in two named volumes, `crate-data` for the
SQLite database and `crate-covers` for the mirrored art, so it survives a
rebuild. Named rather than bind-mounted on purpose: Docker initialises a named
volume from the image, ownership included, so the app can write to it without
anyone chowning a host directory first — and Synology's daemon refuses to
create a missing bind path at all.

Nothing in either volume is irreplaceable; the sync and art commands above
rebuild both from Discogs. What accumulates over time and does not — genre
overrides, "I own both" dismissals, stored API keys — is small and lives in
`crate-data`:

```bash
docker run --rm -v crate_crate-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/crate-data.tgz -C / data
```

To reach it away from home, use Tailscale or the Synology VPN. Do not forward a
port — there is no login, and the token behind it can change your collection.

## Cover art

Discogs caps its images at 600px, which is soft on a retina cover flow.

```bash
npm run art             # fetch higher-resolution art; rate-limited, ~10 min
npm run art -- --retry  # re-check only records that have no upgrade yet
npm run art -- --force  # re-check everything
```

Art comes from Cover Art Archive (matched by barcode through MusicBrainz —
exact, so trusted outright) and iTunes (matched by search, so every candidate
must clear separate artist and title similarity thresholds). A record keeps its
Discogs art unless a candidate is both verified and measurably larger.

Upgrades land in `covers/{id}-hi.jpg` and a separate column; `cover_path` is
never overwritten. To undo one, delete the file and clear `hi_path`.

On this collection: 157 of 243 upgraded to 1200px. The rest kept Discogs art,
mostly because the candidate was no larger — which is the right outcome, not a
failure.

## Keeping it current

```bash
npm run sync              # incremental; seconds when little has changed
npm run sync -- --force   # refetch everything, after a taxonomy change
```

Or from the app: **Settings -> Library -> Sync now**, which runs the same code
in the server process. That screen also sets how often it checks on its own —
never, daily, weekly or monthly, weekly by default. No cron needed.

Sync is incremental and idempotent: it fetches details only for releases it has
not seen, prunes ones you no longer own, and records any release that failed so
the next run retries it. A single failure never aborts the run. A run with
nothing to fetch costs three requests and takes a few seconds.

Two presses of the button while a run is going join that run rather than
starting a second writer, and the schedule counts from the last finished run,
so restarting the container neither resets the clock nor triggers a catch-up
burst.

### Doubles

The same screen lists records the collection appears to hold twice, sorted by
how sure it is:

| | Meaning |
|---|---|
| **Two copies** | One release id, two copies owned. Discogs says so outright. |
| **Filed twice** | Two release ids sharing a catalogue number — one pressing entered twice. |
| **Two pressings** | Same album, different catalogue numbers. An original and a reissue, quite possibly deliberate. |

Each entry links to its Discogs page, because that is where a record is added
or removed — the app only ever reads. Fix it there, press **Sync now**, and it
disappears. "I own both" hides a pair for good.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DISCOGS_PERSONAL_ACCESS_TOKEN` | — | Required, for sync and the MCP server. Without it the app still browses whatever the CLI last imported; Sync now says what is missing. |
| `DISCOGS_USERNAME` | asks Discogs | Skips one API call at sync time |
| `APP_PORT` | `8088` | Host port on the NAS |
| `DB_PATH` | `data/collection.db` | SQLite file |
| `COVERS_DIR` | `covers` | Mirrored cover art |
| `CHAT_BACKEND` | `anthropic` | `anthropic` or `openai` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | — | Chat; blank disables it |
| `MCP_URL` | — | Discogs MCP endpoint; blank means local tools only |

## How it fits together

```
browser ──► discogs-app ──┬──► SQLite + FTS5     browse, search, recommendations
                          ├──► /covers            mirrored art
                          └──► Anthropic/OpenAI   chat
                                   │ tool calls
                                   └──► discogs-mcp ──► Discogs API
```

Sync talks to the Discogs REST API directly rather than through MCP: MCP returns
payloads shaped for a language model, which would have to be re-parsed, and it
adds a hop to every one of ~250 calls. MCP is reserved for chat, which is what
it is for.

### What the assistant may do

Of the MCP server's 53 tools, 17 modify the collection. The assistant is allowed
every read plus two reversible writes — rating a record, and editing a custom
field. Adding, moving and deleting are blocked, and are done on Discogs
directly.

The allowlist is enforced in server code before dispatch, and fails closed on
any unrecognised mutating verb. A prompt instruction is not a control.

## Development

```bash
npm test          # 124 tests
npx tsc --noEmit  # typecheck
```

Design and implementation notes live in `docs/superpowers/`.

## Licence

MIT — see [LICENSE](LICENSE).
