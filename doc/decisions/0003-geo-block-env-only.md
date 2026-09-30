# 0003 — Geo-block toggled by env var only
- Status: Accepted
- Date: 2026-09-30

## Context
The plan listed a geo-block switch in admin Settings, but the proxy runs before the app and cannot cheaply read MongoDB on every request.

## Decision
- `GEO_BLOCK_ENABLED` env var is the only switch. It is removed from the admin Settings screen.
- Block only `x-vercel-ip-country === 'CN'`; never HK, MO or TW. Rewrite to `/blocked` with HTTP 403.
- Applies to the whole site including `/admin` (client staff use a VPN) unless the client decides otherwise.
- Vercel Firewall rule (country = China → deny) is the first layer; `proxy.ts` is the backup.

## Consequences
- Turning the block off needs an env change + redeploy (acceptable: rarely changed).
- Local dev has no country header, so it never blocks. Test on preview with a fake `x-vercel-ip-country: CN` header.
