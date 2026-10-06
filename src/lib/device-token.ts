// Known-device tokens for sign-in (OWASP "device cookies", ADR 0022): after a
// successful sign-in or password reset the browser gets a signed token, and
// later attempts with it skip the shared per-email slow-down.

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

/*
 * v2 adds the user's device epoch to the MAC input (QA L1). The epoch is a
 * counter stored on the user (`deviceEpoch`) and bumped on a password reset,
 * an admin password change and a ban, so every token issued before the bump
 * stops verifying at once. The epoch is not written into the token: the
 * server knows it, and verification recomputes the MAC with the current one.
 * v1 tokens (task 3b, never issued in production) no longer verify.
 */
const VERSION = "v2";
const MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
/* Tolerated clock difference for an issuedAt slightly in the future. */
const FUTURE_SKEW_SECONDS = 60;
/* "v2." + 22 + "." + up to 12 digits + "." + 43 = 82; cap generously. */
const MAX_TOKEN_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;
const TOKEN_PATTERN =
  /^v2\.([A-Za-z0-9_-]{22})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

/**
 * Cookie settings. "__Host-" makes the browser insist on Secure, Path=/ and
 * no Domain, so no subdomain can set or read it.
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

/* A device epoch is a whole number >= 0 (Better Auth stores it as a number). */
function isEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/* Domain-separated MAC key: HKDF-SHA256(AUTH_SECRET, info "yg-device-cookie-v1"). */
function deviceSubkey(): Buffer {
  return Buffer.from(
    hkdfSync("sha256", env.authSecret(), "", "yg-device-cookie-v1", 32),
  );
}

/*
 * The MAC binds the token to one email and one epoch without putting either
 * in it: HMAC(version | emailHash | epoch | nonce | issuedAt). Verifying
 * recomputes it for the email being signed in and that user's current epoch,
 * so a token is worthless for any other account or after a bump.
 */
function mac(
  emailHash: string,
  epoch: number,
  nonce: string,
  issuedAt: string,
): Buffer {
  return createHmac("sha256", deviceSubkey())
    .update(`${VERSION}|${emailHash}|${epoch}|${nonce}|${issuedAt}`)
    .digest();
}

/**
 * A new token for `email` at the user's current `epoch` (call after a
 * successful sign-in or password reset): version, a random 128-bit nonce,
 * issuedAt in seconds and the MAC, all base64url or digits:
 * "v2.<nonce>.<issuedAt>.<mac>". Holds no email and no epoch.
 */
export function issueDeviceToken(
  email: string,
  epoch: number,
): IssuedDeviceToken {
  if (!isEpoch(epoch)) {
    throw new TypeError("issueDeviceToken: epoch must be a whole number >= 0");
  }
  const nonce = randomBytes(16).toString("base64url");
  const issuedAt = String(Math.floor(Date.now() / 1000));
  const tag = mac(hashEmail(email), epoch, nonce, issuedAt).toString(
    "base64url",
  );
  return {
    value: `${VERSION}.${nonce}.${issuedAt}.${tag}`,
    cookie: DEVICE_COOKIE,
  };
}

/**
 * The token's identity (SHA-256 of its nonce, 64 hex) if `value` is a valid,
 * unexpired token issued for `email` at the user's current `epoch`;
 * otherwise null. Never throws on bad input and never logs the value. The
 * MAC is compared with timingSafeEqual on two 32-byte buffers, so timing
 * reveals nothing about a forged MAC. Throws EnvError only when AUTH_SECRET
 * is not configured.
 */
export function verifyDeviceToken(
  value: unknown,
  email: unknown,
  epoch: unknown,
): string | null {
  if (typeof value !== "string" || value.length > MAX_TOKEN_LENGTH) return null;
  if (typeof email !== "string" || email.length > MAX_EMAIL_LENGTH) return null;
  if (!isEpoch(epoch)) return null;
  const match = TOKEN_PATTERN.exec(value);
  if (!match) return null;
  const [, nonce = "", issuedAt = "", tag = ""] = match;

  const age = Math.floor(Date.now() / 1000) - Number(issuedAt);
  if (age > MAX_AGE_SECONDS || age < -FUTURE_SKEW_SECONDS) return null;

  const given = Buffer.from(tag, "base64url");
  // The last base64url character has 2 spare bits; insist on the canonical
  // form so one MAC has exactly one spelling.
  if (given.toString("base64url") !== tag) return null;
  const expected = mac(hashEmail(email), epoch, nonce, issuedAt);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;

  return createHash("sha256").update(nonce).digest("hex");
}
