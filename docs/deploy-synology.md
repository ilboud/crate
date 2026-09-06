# Deploying to a Synology NAS

The short version lives in the README. This is the long one, written after
doing it — including the two things that fail on a Synology specifically and
would not fail on a plain Linux box.

Nothing here needs to be copied from a development machine. The app rebuilds
its entire database and cover mirror from Discogs, so a NAS deployment starts
from nothing and syncs itself.

## Before you start

Enable SSH: **DSM → Control Panel → Terminal & SNMP → Enable SSH service**.

Then check what you are working with:

```bash
ssh <you>@<nas-ip>
uname -m                    # x86_64 on most models; aarch64 on budget ones
sudo docker --version
sudo docker compose version
```

If `docker compose version` fails but `docker-compose --version` works, you are
on the older Docker package rather than Container Manager — use `docker-compose`
throughout.

The image is built **on the NAS**, so the architecture takes care of itself.
Building elsewhere and copying the image is the one thing that will bite you:
an Apple Silicon machine produces arm64, and most Synology units are x86_64.

## 1. Fetch the code

```bash
sudo mkdir -p /volume1/docker/crate
cd /volume1/docker/crate
curl -L https://github.com/ilboud/crate/archive/refs/heads/main.tar.gz \
  | sudo tar xz --strip-components=1
```

DSM ships `curl`. If you would rather use git, install **Git Server** from
Package Center first.

## 2. Configure

```bash
sudo cp .env.example .env
sudo vi .env
sudo chmod 600 .env
```

Only `DISCOGS_PERSONAL_ACCESS_TOKEN` is required. Everything else has a working
default or disables a feature by being blank.

The `chmod` matters: that token can modify your collection.

Set `ANTHROPIC_MODEL` explicitly if you care which model answers — leaving it
blank selects the default, which is not necessarily the cheaper one you were
using elsewhere.

## 3. Start

```bash
sudo docker compose up -d --build
```

The first build takes 5–15 minutes: it compiles the server and bundles the
frontend on the NAS. On a 2 GB model expect the slower end. That is not a hang.

Two containers come up — `discogs-app` and `discogs-mcp`.

## 4. Fill the collection

```bash
sudo docker compose exec discogs-app node dist/src/sync/cli.js
sudo docker compose exec discogs-app node dist/src/art/cli.js
```

The sync is about five minutes for a few hundred records. The art pass is
slower — MusicBrainz permits one request per second and the client respects it
— so allow ten minutes or so. It is optional: skip it and you keep Discogs'
600px art, which is merely softer.

Until the sync finishes the logs say `0 releases`. That is correct, not a
failure.

## 5. Check it

```bash
sudo docker compose ps                    # both Up, app healthy
sudo docker compose logs -f discogs-app
curl -s localhost:8088/healthz            # {"ok":true}
```

Then open `http://<nas-ip>:8088` and confirm Settings → Library shows a recent
sync.

If DSM's firewall is on, allow the port: **Control Panel → Security → Firewall**.

## The two Synology-specific traps

**Bind mounts fail here in a way they do not elsewhere.** The compose file uses
named volumes, which avoids both halves of this, but it is worth knowing why.
Synology's daemon refuses to create a missing bind-mount path, so a missing
directory is a failed deploy rather than a silently created folder. Clear that
and you meet the second half: a bind mount takes the *host* directory's
ownership, a fresh `mkdir` is root-owned, and the container runs as uid 1000 —
so the app starts and then cannot write its database. A named volume is
initialised from the image instead, ownership included, and the Dockerfile
already chowns `/data` and `/covers` to the `node` user.

If you switch to bind mounts anyway to keep the files browsable in File
Station, create the directories and `chown -R 1000:1000` them *before* the
first start.

**Volume names are prefixed by the Compose project name.** The compose file
pins `name: crate`, so the volumes are `crate_crate-data` and
`crate_crate-covers`. Without that pin the name comes from the directory, and a
command naming the wrong one does not error — `docker run -v wrong-name:/data`
creates a new empty volume and cheerfully backs up nothing.

## Keeping it running

`restart: unless-stopped` plus Docker starting at boot means it comes back on
its own after a reboot or a power cut.

The app syncs itself on the schedule set in Settings → Library, weekly by
default, and there is a **Sync now** button. No cron.

To update:

```bash
cd /volume1/docker/crate
curl -L https://github.com/ilboud/crate/archive/refs/heads/main.tar.gz \
  | sudo tar xz --strip-components=1
sudo docker compose up -d --build
```

Volumes are untouched by a rebuild, so the collection survives.

## Backups

Both volumes hold derived state — the sync and art commands rebuild them from
Discogs. What accumulates over time and cannot be rebuilt is small, and all of
it is in `crate_crate-data`: genre overrides, "I own both" dismissals, the
crate's feel settings, and the stored API keys.

```bash
sudo docker run --rm \
  -v crate_crate-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/crate-data.tgz -C / data
```

Point Hyper Backup at wherever you write that. There is no value in backing up
`crate_crate-covers`; it is a few hundred megabytes of re-fetchable art.

## Reaching it from outside the house

Use Tailscale or the Synology VPN.

Do not forward a port. There is no login, by design — and the Discogs token
behind it can modify your collection.
