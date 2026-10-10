// Signed form stamps (QA gate B L-1, ADR 0069/0074): the server stamps a
// public form with the time it rendered it, "<ms>.<HMAC-SHA256(ms)>", and
// later reads the age from a stamp only it could have made. A client can no
// longer claim it opened the form long ago by posting a plain number.
//
// The MAC key is a subkey of AUTH_SECRET with its own label, so this MAC is
// never valid anywhere else the secret is used (sessions, device tokens,
// rate-limit keys). A stamp is not single-use: within its 24 h a bot could
// replay it; the per-network and per-email limits cover that.

import "server-only";

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import { env } from "./env";
import { FORM_STAMP_PATTERN, formStampSchema } from "./schemas/form-stamp";

/** A stamp older than this is refused; the visitor is asked to reload. */
export const FORM_STAMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/* Domain-separated MAC key: HKDF-SHA256(AUTH_SECRET, info "yg-form-stamp-v1"). */
function stampSubkey(): Buffer {
  return Buffer.from(
    hkdfSync("sha256", env.authSecret(), "", "yg-form-stamp-v1", 32),
  );
}

function mac(issuedMs: string): Buffer {
  return createHmac("sha256", stampSubkey()).update(issuedMs).digest();
}

/** A fresh stamp for a form rendered at `now`. Throws EnvError without AUTH_SECRET. */
export function issueFormStamp(now: Date = new Date()): string {
  const issuedMs = String(now.getTime());
  return `${issuedMs}.${mac(issuedMs).toString("base64url")}`;
}

/** What a posted stamp proved. */
export type FormStampCheck =
  | { ok: true; ageMs: number }
  /*
   * "invalid": missing, malformed, wrong MAC, or issued after `now` (only a
   * forger or a broken clock gets here). "expired": a stamp this server
   * really issued, older than FORM_STAMP_MAX_AGE_MS (a tab left open).
   */
  | { ok: false; reason: "invalid" | "expired" };

/**
 * Checks a posted stamp against `now`. The MAC is compared in constant
 * time, and only the canonical base64url spelling is accepted. Throws
 * EnvError without AUTH_SECRET (our outage, not the visitor's).
 */
export function readFormStamp(value: unknown, now: Date): FormStampCheck {
  const invalid = { ok: false, reason: "invalid" } as const;
  const parsed = formStampSchema.safeParse(value);
  if (!parsed.success) return invalid;
  const match = FORM_STAMP_PATTERN.exec(parsed.data);
  const issuedMs = match?.[1];
  const sent = match?.[2];
  if (issuedMs === undefined || sent === undefined) return invalid;
  const expected = mac(issuedMs);
  const given = Buffer.from(sent, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return invalid;
  }
  // Canonical base64url only: a second spelling of the same bytes is refused.
  if (given.toString("base64url") !== sent) return invalid;
  const ageMs = now.getTime() - Number(issuedMs);
  if (ageMs < 0) return invalid;
  if (ageMs > FORM_STAMP_MAX_AGE_MS) return { ok: false, reason: "expired" };
  return { ok: true, ageMs };
}
