# 0021 — Email sender (Resend)
- Status: Accepted
- Date: 2026-10-02

## Decision
- **`src/lib/email.ts`** is server-only. The Resend client is created lazily from `env.email()`; importing the module reads no env.
  - It exposes a generic `sendEmail()` plus templates. Phase 1 has one: `sendPasswordResetEmail()`.
  - Email is plain HTML (inline styles, no images, no tracking) plus a text version. Every interpolated value is HTML-escaped.
- **Links are validated before sending:** only `https:`, or `http://localhost` outside production. `javascript:`, `data:`, relative links and links with credentials are refused.
- **`EmailSendError` has a `reason`** and holds no recipient, URL, token or API key. It has no `cause`, and Resend's error message is never used. Nothing in the module logs.
- **`env.isProduction()`** is the one sanctioned way to read `NODE_ENV` outside `env.ts`. Vercel Preview also counts as production.
- **`PASSWORD_RESET_TOKEN_TTL_SECONDS` (3600)** is the single source for the reset-link lifetime. The email text and Better Auth's `resetPasswordTokenExpiresIn` (task 5) both use it.
- **No timeout option:** Resend 6.31 has none, and the Vercel function's time limit bounds a hung request.

## Consequences
- **Unverified domain:** until a domain is verified, `EMAIL_FROM` is Resend's test sender, and only the Resend account owner receives mail (user decision 2026-10-01).
- **Task 5: don't let failed sends reveal which accounts exist.** Better Auth calls `sendResetPassword` only for existing users. `sendResetPassword` must catch `EmailSendError` (log only `reason`, `statusCode` and `providerCode`) and must not make response timing or status depend on whether the account exists. Check whether Better Auth can run the send in the background on Vercel.
