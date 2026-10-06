# 0025 — `seed:admin` CLI: create the admin or reset its password
- Status: Accepted
- Date: 2026-10-03
- Implements: CLAUDE.md "Roles" (the single admin must never be locked out); must-dos from ADR 0020, 0023 and 0024

## Context
There is one admin account. It has no staff-management screen, and if its password is lost the email reset may not help (no verified Resend domain yet, or the mailbox is gone). Whoever holds the database credentials needs a way back in. Better Auth's `setUserPassword` requires a signed-in admin, so it can't be used for recovery.

## Decision
- **Commands:**
  - `npm run seed:admin -- --email <e> --name "<n>"` creates the admin.
  - `npm run seed:admin -- --email <e> --reset` sets a new password.
  - Node flags are the same as `db:indexes` (`--conditions=react-server`, `.env.local`, tsx).
  - Logic is in `src/lib/seed-admin.ts` (tested on in-memory MongoDB); argument handling and the prompt are in `scripts/seed-admin.ts`.
- **The password never comes from argv.**
  - It is typed twice at a hidden raw-mode prompt.
  - With no terminal (CI, Git Bash without winpty), it comes from `SEED_ADMIN_PASSWORD` set for that one command.
  - `--password`-style flags are refused with an explanation. Any other bad argument gets a fixed message that never repeats it (QA L-1: parseArgs would quote a stray password).
  - The prompt refuses arrow and other special keys, whose escape sequences would otherwise join the password silently (QA L-2). An env-supplied password is deleted from `process.env` once read.
  - Email and name are checked before the password is asked for.
  - The script refuses to run if `.env.local` contains a `SEED_ADMIN_PASSWORD` value, so no admin password ever sits on disk.
  - Input is checked with Zod (email; name 1–100 characters; password 12–128 characters) before connecting to the database.
- **Create:**
  - refuses an existing email (it points to `--reset`);
  - uses Better Auth's `createUser` (server call, no session needed) with role `admin` and `mustChangePassword: false`, because the password was just chosen by the operator;
  - clears the email's login and reset counters.
- **Reset:**
  - only for an existing account that holds the `admin` role. It never promotes a customer.
  - Steps, in order:
    1. set the password hash through Better Auth's internal adapter (and create the credential account if it is missing);
    2. delete every session right away;
    3. set `mustChangePassword: false`, lift any ban and bump `deviceEpoch` (old known-device tokens die, ADR 0022);
    4. write the audit entry, then clear the counters. The audit comes first so the change is recorded even if the clear fails (QA L-3); a rerun finishes the clean-up.
  - This is the same clean-up our hooks do for `/admin/set-user-password` and bans.
- **Audit:** each run writes `admin.cli_create` or `admin.cli_reset_password`. The actor is the admin account itself, because the CLI has no signed-in user. The entry records `{ via: "cli", unbanned }`, never the password.
- **Error output:** our own error types print their messages; anything else prints only its type. This is the same rule as `db:indexes`.
- **Second admin:** creating a second admin with another email is allowed, which keeps the "second admin later without code changes" option.

## Consequences
- Anyone with `MONGODB_URI` plus `AUTH_SECRET` and `IP_HASH_SECRET` can take over the admin account. That is no worse than direct database access, but those secrets must stay limited to the client and the developer.
- A shell-set `SEED_ADMIN_PASSWORD` can stay in shell history: in PowerShell, PSReadLine saves `$env:` lines. Prefer the prompt.
- Unbanning on reset means a ban on the admin account can always be undone from the CLI. That is intended: the single admin must not be lockable.
