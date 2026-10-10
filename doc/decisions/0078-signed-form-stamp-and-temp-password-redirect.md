# 0078 — Signed form stamp for /request-access; temporary-password datasheet redirect
- Status: Accepted
- Date: 2026-10-10
- Builds on: 0069, 0071, 0074 (closes Phase 5 QA gate B L-1 and I-2)

## Context
QA gate B passed with no High/Medium. L-1: the minimum fill time on `/request-access` trusted a plain client number (`startedAt=1` skipped it). I-2: a signed-in customer on a temporary password who opened a datasheet link was sent to `/login` first.

## Decision
1. **Signed stamp.** The page renders `"<ms>.<base64url HMAC-SHA256(ms)>"` with key `HKDF-SHA256(AUTH_SECRET, info "yg-form-stamp-v1")`, issued and checked only in server-only `src/lib/form-stamp.ts`; format schema in `src/lib/schemas/form-stamp.ts` (≤ 59 chars, `^\d{1,15}\.[A-Za-z0-9_-]{43}$`). No new env var.
2. **Silent thanks** (identical answer, no row, no limiter slot, no alert) for a missing, malformed, wrong-MAC (constant-time, canonical base64url only), future or too-fast stamp, before validation.
3. **Stale stamp** (genuine MAC, older than 24 h) → a "reload the page" form error, so a real person with an overnight tab isn't thanked while nothing is stored. The answer doesn't depend on the email or account, so no enumeration. (Main-session call: accepted over the brief's "silent" option after a code-review Medium.)
4. Without JS and after field errors the original stamp is re-sent, never a new one. A stamp can be replayed within 24 h; the per-network and per-email limits bound it.
5. Rotating `AUTH_SECRET` invalidates open forms (silently dropped): rotate outside business hours.
6. Missing `AUTH_SECRET` → `unavailable`.
7. **Datasheet route:** `must-change-password` → 303 `/change-password?next=/product/<slug>`; still `private, no-store`, no log row, no presign. Signed-out and other-role visitors stay on `/login?next=…`.

## Consequences
- Not done (gate B I-3, Info): the expiry picker reads `new Date()` in render; a render across China midnight could mismatch on hydration. Negligible.
- Gate B I-4: dashboard `getCounts()` has no actor check; decided with the ADR 0073 "other services" question before the Phase 5 exit.
- Optional later: accept the previous key's stamps for 24 h after a secret rotation.
