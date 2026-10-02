# Privacy and cookie pages: required text (draft for Phase 7)

The Phase 7 privacy and cookie pages MUST include the items below. Wording can be polished, but the facts must stay accurate. Update this file whenever the data we keep changes.

## Login security (ADR 0022) — privacy page
> To protect accounts against password-guessing, we briefly record sign-in attempts together with a scrambled, non-reversible form of your network address. These records are deleted automatically within about 15 minutes. Password-reset requests are counted for up to one hour, without your network address.

Facts behind this wording, so later edits stay accurate:
- **What is recorded:** every sign-in attempt, not only failed ones. A successful sign-in removes only its own counter.
- **Retention:** sign-in counters expire 15 minutes after their window starts. MongoDB's TTL clean-up can lag by about a minute, hence "within about 15 minutes".
- **What is stored:** no email address and no raw IP. Only keyed hashes are kept.
- **Whistleblower pages** never record network addresses (CLAUDE.md rule 7). If the privacy page describes the whistleblower system, it must say so.

## Cookies (ADR 0022) — cookie page, "strictly necessary"
| Cookie | Purpose | Lifetime |
|---|---|---|
| `__Host-yg-device` | Recognises a browser that has signed in to this account before, so it can't be locked out by password-guessing from elsewhere. It contains no personal data and doesn't keep you signed in. | 180 days |
| Session cookie (Better Auth, name set in task 5) | Keeps you signed in. | Session / up to 7 days |
