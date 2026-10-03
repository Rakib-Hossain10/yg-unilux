# Privacy and cookie pages: required text (draft for Phase 7)

The Phase 7 privacy and cookie pages MUST include the items below. Wording can be polished, but the facts must stay accurate. Update this file whenever the data we keep changes.

## Login security (ADR 0022, 0023) — privacy page
> To protect accounts against password-guessing, we briefly record sign-in attempts and password-reset requests together with a scrambled, non-reversible form of your network address. These records are deleted automatically within about 15 minutes. We also count password-reset requests per account for up to one hour, without your network address.

Facts behind this wording, so later edits stay accurate:
- **Network-address records:** every record derived from a network address is deleted within 15 minutes. That covers the sign-in counters per network, the reset counters per network and Better Auth's own limiter counters.
  - MongoDB's TTL clean-up can lag by about a minute, hence "within about 15 minutes".
- **What is recorded:** every sign-in attempt, not only failed ones. A successful sign-in removes only its own counter.
- **Per-account counters (no network address):**
  - the sign-in slow-down (`email-login`), deleted 15 minutes after the last accepted attempt;
  - the reset counter (`email-reset`), deleted one hour after the last accepted request.
- **Per-device counter** (`email-dev-login`): deleted within 15 minutes.
- **Reset links:** reset tokens are stored hashed and expire after 1 hour (TTL).
- **What is stored:** no email address and no raw IP. Only keyed hashes are kept.
- **Sessions:** they store no IP address, but do store the browser's user-agent string. Sessions are deleted automatically when they expire.
- **Security log:** `auditLog` keeps "too many attempts" events, holding only the counter type and reason (no email, no IP). It has no automatic deletion yet; decide a retention period in Phase 7.
- **Whistleblower pages** never record network addresses (CLAUDE.md rule 7). If the privacy page describes the whistleblower system, it must say so.

## Cookies — cookie page, all "strictly necessary"
| Cookie (production name) | Purpose | Lifetime |
|---|---|---|
| `__Secure-yg.session_token` | Keeps you signed in. | Up to 7 days after your last visit (1 day if you choose "don't remember me") |
| `__Secure-yg.dont_remember` | Marks a sign-in as "don't remember me". | Browser session |
| `__Host-yg-device` | Recognises a browser that has signed in to this account before, so it can't be locked out by password-guessing from elsewhere. It contains no personal data and doesn't keep you signed in. | 180 days |

In local development (`http://localhost`) the session cookies have no `__Secure-` prefix.
