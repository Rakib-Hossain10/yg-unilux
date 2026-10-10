// The loopback port of the in-memory R2/Cloudinary/Resend fakes (e2e/fake-providers).
// Shared by the test server, which starts them, and the specs, which forward
// the browser's provider calls to them. Loopback only; never a real host.

export const E2E_FAKE_PROVIDERS_PORT = 3110;
export const E2E_FAKE_PROVIDERS_URL = `http://127.0.0.1:${E2E_FAKE_PROVIDERS_PORT}`;

/*
 * Fake provider credentials: well-formed, worthless. They are set for the
 * production BUILD as well as the server, because the admin CSP's connect-src
 * (next.config headers) is computed at build time from R2_ACCOUNT_ID and has to
 * name the host the browser will "upload" to. Never real values.
 */
export const E2E_PROVIDER_ENV = {
  CLOUDINARY_URL: "cloudinary://123456789012345:e2e-not-a-secret@e2e-cloud",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "e2e-access-key",
  R2_SECRET_ACCESS_KEY: "e2e-not-a-secret",
  R2_BUCKET: "e2e-private",
  // Resend goes to the fake's email sink (e2e/fixtures/emails.ts reads it).
  RESEND_API_KEY: "e2e-not-a-secret",
  EMAIL_FROM: "YG UniLUX <no-reply@e2e.invalid>",
} as const;

/*
 * The e2e `CRON_SECRET` (e2e/test-server.ts sets it for `next start` only),
 * so the Phase 5 exit spec can call GET /api/cron/access-expiry like Vercel
 * Cron does. Worthless outside the throwaway test server; 40 printable ASCII
 * characters, no spaces (the env.ts rule).
 */
export const E2E_CRON_SECRET = "e2e-cron-secret-not-real-0123456789abcdef";
