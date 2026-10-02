# 0022 — Sign-in limits: per network, per-email slow-down, known devices
- Status: Accepted
- Date: 2026-10-02
- Supersedes: ADR 0020's per-email hard limit for sign-in, and its pending item (c). Reset requests still use ADR 0020 until task 5.

## Context
- ADR 0020's per-email hard limit let anyone who knew an email address lock that account out, the single admin included.
- The user asked for:
  - a hard limit per email and network;
  - an overall per-email limit that is a progressive slow-down and never a lockout;
  - the IP scrambled with an HMAC under a dedicated secret, read only from Vercel's trusted header;
  - storage only in a TTL collection, deleted within 15 minutes;
  - never on whistleblower pages.
- **QA's first review (FAIL, H1):** six attacker networks could still take every slow-down turn. The user then chose the known-device cookie (OWASP "device cookies") and decided that polling during a wait is no longer free.

## Decision
- **Network:** taken ONLY from `x-vercel-forwarded-for` (`src/lib/client-ip.ts`).
  - Vercel overwrites `x-forwarded-for` to stop spoofing; `x-vercel-forwarded-for` can't be overwritten by a proxy on top (Vercel docs, checked 2026-10-02).
  - IPv4 is used as is. IPv6 is grouped by /64, because one host usually owns a whole /64.
  - A missing or invalid header goes into one per-email "unknown network" bucket, so stripping the header doesn't escape the limit.
  - **If a CDN or proxy is ever put in front of Vercel, revisit this,** because every client would look like the proxy.
- **Keys and secrets:**
  - The network part is HMAC-SHA256 under HKDF(`IP_HASH_SECRET`, `yg-rate-limit-ip-v1`), bound to the email hash, so one network gives unrelated keys for different accounts.
  - `IP_HASH_SECRET` is a new env variable (at least 32 characters, and it must differ from `AUTH_SECRET`).
  - No raw IP, email or token is ever stored or logged.
- **Limits** (`src/lib/sign-in-limit.ts` → `consumeSignIn`):
  1. **Known device:** a valid `__Host-yg-device` token (below) allows 5 attempts per 15 min per (email + device), and skips everything else. Once those 5 are used, the attempt falls through to the untrusted path.
  2. **Untrusted, per (email + network):** a hard limit of 5 per 15 min, fixed window.
  3. **Untrusted, per email:** a progressive slow-down. The first 10 attempts are free, then the wait between attempts doubles from 2 s up to a 30 s cap. The window resets after 15 quiet minutes. Attempts during a wait change nothing in the slow-down, but **they still cost the network an attempt** (no give-back), so polling isn't free.
- **Device token** (`src/lib/device-token.ts`):
  - Format `v1.<nonce>.<issuedAt>.<mac>`. The MAC is HMAC-SHA256 under HKDF(`AUTH_SECRET`, `yg-device-cookie-v1`) over `v1|emailHash|nonce|issuedAt`, compared in constant time, and must be in canonical base64url.
  - It holds no email and is valid only for the email it was issued to.
  - Lifetime 180 days. The cookie is HttpOnly, Secure, SameSite=Lax, `Path=/`, with no Domain.
  - It is issued on every successful sign-in and kept on logout (it carries no session).
  - Local development must use `http://localhost`: Chromium drops `__Host-` cookies on `127.0.0.1`.
- **Clearing:**
  - A successful sign-in clears only the counter of the path that let it through (the device or the network), never the slow-down.
  - `clearAllForEmail` (password reset, `seed:admin`) clears every counter for the email.
- **Storage:** everything lives in `loginAttempts`. Every sign-in counter expires at most 15 min after its window starts (MongoDB's TTL monitor can lag about 60 s), and tests enforce it.
- **Responses:** the result is one generic `{ allowed, retryAfterSeconds }`, the same whether the account exists or not. The audit entry holds only `{ namespace, reason: "hard_limit" | "slowdown" }`.
- **Whistleblower guard:** an ESLint override for `src/**/whistleblower*` bans the IP, device-token and rate-limit modules, `@vercel/functions`, non-literal `import()`/`require`, `createRequire` and IP-header strings, with a test proving it. Indirect imports can't be caught by lint; Phase 8 adds a runtime test.
- **Verified by QA (PASS):** atomicity under 40–300-way parallel calls, tamper and expiry protection of the token (proved by mutation), and no raw data stored.

## Required in task 5 (from QA)
- **M1, recovery for owners without a device token:** a successful password reset must also issue the device token, since it proves the person controls the mailbox. Without this, an attacker with ~6 networks can keep a user on a new device out indefinitely. Consider a way for `seed:admin` to give the admin a device token, e.g. a one-time sign-in link.
- **L1, revocation:** add a per-user epoch (e.g. `deviceEpoch`, bumped on password reset or ban) to the device-token MAC, so old tokens die after a reset.
- **L2:** `consumeSignIn` returns which path let the attempt through, and that value is passed to `clearSignIn`, instead of reading `lastAttemptAllowed` back (avoids a race).
- **L3, whistleblower guard:** also ban `better-auth`/`@/lib/auth` and the logging of whole header lists in whistleblower files.
- **Better Auth's own limiter** stores raw `ip|path` keys. Either give it custom storage with HMAC'd keys in our TTL collection, or turn it off for these paths. Set `ipAddressHeaders: ["x-vercel-forwarded-for"]` and `ipv6Subnet: 64`.
- **Reset requests:** a per-(email + network) limit plus a per-email throttle that never reaches zero (user decision 2026-10-02).

## Phase 8
- The per-case whistleblower lockout gets its own module, which never reads request headers and is allowed by the guard. It does not use `rate-limit.ts`.

## Consequences
- **Privacy and cookies:** the login-attempt line and the device cookie must appear on the privacy and cookie pages (`doc/content/privacy.md`). The device cookie is strictly necessary (security), so no consent is needed, but it must be listed.
- **Remaining risk for owners without a token** until task 5's M1 fix lands: recovery is through `seed:admin` or a password reset, followed by a sign-in from a device that has a token.
