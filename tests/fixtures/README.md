# Test fixtures

`collection.json` is a frozen snapshot of the Discogs collection taken
2026-08-30, trimmed to the fields the taxonomy tests need (no instance ids or
date_added). It holds 245 collection items covering 244 distinct releases.

It is deliberately frozen. The live collection has since changed — one release
was removed and a duplicated copy dropped — but the tests assert against this
snapshot so their expected group distribution stays stable. Refresh it only
when you intend to update those expectations.
