// Known-device tokens for sign-in (OWASP "device cookies", ADR 0022 update):
// after a successful sign-in the browser gets a signed token, and later
// attempts with it skip the shared per-email slow-down. Task 5 sets the cookie.

import "server-only";

import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { env } from "./env";
import { hashEmail } from "./rate-limit";

const VERSION = "v1";
const MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
/* Tolerated clock difference for an issuedAt slightly in the future. */
const FUTURE_SKEW_SECONDS = 60;
/* "v1." + 22 + "." + up to 12 digits + "." + 43 = 82; cap generously. */
const MAX_TOKEN_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;
const TOKEN_PATTERN =
  /^v1\.([A-Za-z0-9_-]{22})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

/**
 * Cookie settings for task 5. "__Host-" makes the browser insist on Secure,
 * Path=/ and no Domain, so no subdomain can set or read it.
 */
export const DEVICE_COOKIE = {
  name: "__Host-yg-device",
  maxAgeSeconds: MAX_AGE_SECONDS,
  attributes: {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  },
} as const;

export interface IssuedDeviceToken {
  value: string;
  cookie: typeof DEVICE_COOKIE;
}

/* Domain-separated MAC key: HKDF-SHA256(AUTH_SECRET, info "yg-device-cookie-v1"). */
function deviceSubkey(): Buffer {
  return Buffer.from(
    hkdfSync("sha256", env.auth().secret, "", "yg-device-cookie-v1", 32),
  );
}

/*
 * The MAC binds the token to one email without putting the email in it:
 * HMAC(version | emailHash | nonce | issuedAt). Verifying recomputes it for
 * the email being signed in, so a token is worthless for any other account.
 */
function mac(emailHash: string, nonce: string, issuedAt: string): Buffer {
  return createHmac("sha256", deviceSubkey())
    .update(`${VERSION}|${emailHash}|${nonce}|${issuedAt}`)
    .digest();
}

/**
 * A new token for `email` (call after a successful sign-in): version, a
 * random 128-bit nonce, issuedAt in seconds and the MAC, all base64url or
 * digits: "v1.<nonce>.<issuedAt>.<mac>". Holds no email.
 */
export function issueDeviceToken(email: string): IssuedDeviceToken {
  const nonce = randomBytes(16).toString("base64url");
  const issuedAt = String(Math.floor(Date.now() / 1000));
  const tag = mac(hashEmail(email), nonce, issuedAt).toString("base64url");
  return {
    value: `${VERSION}.${nonce}.${issuedAt}.${tag}`,
    cookie: DEVICE_COOKIE,
  };
}

/**
 * The token's identity (SHA-256 of its nonce, 64 hex) if `value` is a valid,
 * unexpired token issued for `email`; otherwise null. Never throws on bad
 * input and never logs the value. The MAC is compared with timingSafeEqual
 * on two 32-byte buffers, so timing reveals nothing about a forged MAC.
 * Throws EnvError only when AUTH_SECRET is not configured.
 */
export function verifyDeviceToken(
  value: unknown,
  email: unknown,
): string | null {
  if (typeof value !== "string" || value.length > MAX_TOKEN_LENGTH) return null;
  if (typeof email !== "string" || email.length > MAX_EMAIL_LENGTH) return null;
  const match = TOKEN_PATTERN.exec(value);
  if (!match) return null;
  const [, nonce = "", issuedAt = "", tag = ""] = match;

  const age = Math.floor(Date.now() / 1000) - Number(issuedAt);
  if (age > MAX_AGE_SECONDS || age < -FUTURE_SKEW_SECONDS) return null;

  const given = Buffer.from(tag, "base64url");
  // The last base64url character has 2 spare bits; insist on the canonical
  // form so one MAC has exactly one spelling.
  if (given.toString("base64url") !== tag) return null;
  const expected = mac(hashEmail(email), nonce, issuedAt);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;

  return createHash("sha256").update(nonce).digest("hex");
}
