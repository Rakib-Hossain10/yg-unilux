# 0006 — Atlas Search everywhere
- Status: Accepted
- Date: 2026-09-30

## Context
Atlas Search only runs on Atlas clusters, not local MongoDB.

## Decision
- Dev, preview and production all use Atlas clusters, so `$search` works everywhere.
- Index covers product name, family, all variant model nos. and category names; public fields only (ADR 0002).
- Regex fallback runs only if the `$search` stage fails (index missing/unavailable), and logs a warning.

## Consequences
- Developers need an Atlas connection string; tests that need a DB use `mongodb-memory-server` and exercise the fallback path.
