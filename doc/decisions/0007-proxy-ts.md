# 0007 — `proxy.ts` instead of `middleware.ts`
- Status: Accepted
- Date: 2026-09-30

## Context
Next.js 16 renamed the middleware file to `proxy.ts`.

## Decision
- `src/proxy.ts` handles the CN geo-block and a coarse `/admin` redirect for signed-out users.
- The real authorisation check stays on the server in every admin page, server action and API route (CLAUDE.md rule 3). The proxy is never the only guard.

## Consequences
- Exact export name and matcher config are confirmed against the installed Next docs in Phase 0 (see ADR 0008).
