// Sign-in rate limiting (ADR 0022): known devices get their own hard limit;
// everyone else gets a per-(email + network) hard limit plus a per-email
// slow-down. The only rate-limit code that sees an IP; banned on whistleblower
// routes by ESLint.

import "server-only";

import { createHmac, hkdfSync } from "node:crypto";

import { type HeaderSource, clientNetwork } from "./client-ip";
import { verifyDeviceToken } from "./device-token";
import { env } from "./env";
import {
  type RateLimitKey,
  type RateLimitRule,
  type SlowdownRule,
  buildKey,
  clearAttempts,
  consume,
  consumeSlowdown,
  hashEmail,
  wasLastAttemptAllowed,
} from "./rate-limit";

/**
 * Known device: 5 sign-in attempts per (email + device token) per 15 minutes,
 * and nothing else. Once used up, the token counts as untrusted for the rest
 * of that window (OWASP device cookies) and attempts take the untrusted path.
 */
export const SIGN_IN_DEVICE = {
  limit: 5,
  windowSeconds: 15 * 60,
} as const satisfies RateLimitRule;

/** Untrusted: 5 sign-in attempts per (email + network) per 15 minutes. */
export const SIGN_IN_NETWORK = {
  limit: 5,
  windowSeconds: 15 * 60,
} as const satisfies RateLimitRule;

/**
 * Per-email slow-down: 10 free attempts, then waits of 2, 4, 8, 16, then 30 s
 * (capped) between attempts. The count resets after 15 minutes without an
 * accepted attempt. At the cap one email can be tried at most twice a minute,
 * from any number of networks, and its owner waits at most 30 s.
 */
export const SIGN_IN_SLOWDOWN = {
  freeAttempts: 10,
  baseDelaySeconds: 2,
  maxDelaySeconds: 30,
  idleResetSeconds: 15 * 60,
} as const satisfies SlowdownRule;

/** Which limit refused a sign-in: for the audit log. Never an email or IP. */
export interface SignInLimitAudit {
  namespace: "email-ip-login" | "email-login" | "email-dev-login";
  reason: "hard_limit" | "slowdown";
}

/**
 * The decision for one sign-in attempt. The caller sends ONE generic
 * response for every refusal (same body whichever limit tripped and whether
 * or not the account exists), with Retry-After = retryAfterSeconds.
 */
export interface SignInGate {
  allowed: boolean;
  /** 0 when allowed. */
  retryAfterSeconds: number;
  /** Set only when refused; write it to auditLog as is. */
  audit: SignInLimitAudit | null;
}

export interface SignInRequest {
  /** The email as submitted, after Zod validation. */
  email: string;
  /** The request headers; only x-vercel-forwarded-for is read. */
  headers: HeaderSource;
  /** The raw __Host-yg-device cookie value, if the browser sent one. */
  deviceToken?: string | undefined;
}

/*
 * Requests without a usable trusted IP header (local dev, tests, a request
 * that did not come through Vercel) share ONE per-email "unknown network"
 * counter instead of skipping the hard limit. Stripping or garbling the header
 * therefore never escapes the hard limit, and on Vercel (which always sets the
 * header) real users never land in this bucket.
 */
const UNKNOWN_NETWORK = "unknown-network";

/* Domain-separated IP key: HKDF-SHA256(IP_HASH_SECRET, info "yg-rate-limit-ip-v1"). */
function ipSubkey(): Buffer {
  return Buffer.from(
    hkdfSync("sha256", env.ipHashSecret(), "", "yg-rate-limit-ip-v1", 32),
  );
}

/*
 * The counter keys for one attempt. The network part is an HMAC (with the
 * dedicated IP_HASH_SECRET) of the email digest plus the network, so the
 * stored value can't be reversed without the secret, and the same network
 * gives unrelated values for different emails (no cross-account linking).
 * The device part is the SHA-256 of a verified token's random nonce, or
 * null without a valid token for this email. All of one email's network and
 * device counters share the prefixes "email-ip-login:<email HMAC>." and
 * "email-dev-login:<email HMAC>.", which clearAllForEmail() relies on.
 */
function signInKeys({ email, headers, deviceToken }: SignInRequest): {
  device: RateLimitKey | null;
  network: RateLimitKey;
  email: RateLimitKey;
} {
  const emailDigest = hashEmail(email);
  const network = clientNetwork(headers) ?? UNKNOWN_NETWORK;
  const networkDigest = createHmac("sha256", ipSubkey())
    .update(`${emailDigest}\n${network}`)
    .digest("hex");
  const deviceId =
    deviceToken === undefined ? null : verifyDeviceToken(deviceToken, email);
  return {
    device:
      deviceId === null
        ? null
        : buildKey("email-dev-login", emailDigest, deviceId),
    network: buildKey("email-ip-login", emailDigest, networkDigest),
    email: buildKey("email-login", emailDigest),
  };
}

function refused(
  retryAfterSeconds: number,
  audit: SignInLimitAudit,
): SignInGate {
  return { allowed: false, retryAfterSeconds, audit };
}

const ALLOWED: SignInGate = {
  allowed: true,
  retryAfterSeconds: 0,
  audit: null,
};

/**
 * Call BEFORE checking the password; proceed only if `allowed`. Each step
 * counts and decides in one atomic update, so there is no check-then-record
 * race.
 * 0. A valid device token for this email: only its own hard limit applies,
 *    so an attacker elsewhere can't take the owner's turns. When it is used
 *    up, the attempt falls through to the untrusted path below.
 * 1. Untrusted: the (email + network) hard limit first. If it refuses, the
 *    slow-down is not touched: a blocked network can't take others' turns.
 * 2. Then the per-email slow-down.
 * Throws RateLimitUnavailableError if the DB fails (answer "try again later"),
 * EnvError if AUTH_SECRET or IP_HASH_SECRET is missing.
 */
export async function consumeSignIn(
  request: SignInRequest,
): Promise<SignInGate> {
  const keys = signInKeys(request);

  if (keys.device && (await consume(keys.device, SIGN_IN_DEVICE)).allowed) {
    return ALLOWED;
  }

  const network = await consume(keys.network, SIGN_IN_NETWORK);
  if (!network.allowed) {
    return refused(network.retryAfterSeconds, {
      namespace: "email-ip-login",
      reason: "hard_limit",
    });
  }

  // A slow-down refusal keeps the network attempt it used: otherwise polling
  // during a wait would be free, and a few networks could take every turn
  // (QA H1). Known devices don't depend on these turns at all.
  const slowdown = await consumeSlowdown(keys.email, SIGN_IN_SLOWDOWN);
  if (!slowdown.allowed) {
    return refused(slowdown.retryAfterSeconds, {
      namespace: "email-login",
      reason: "slowdown",
    });
  }

  return ALLOWED;
}

/**
 * Call after a SUCCESSFUL sign-in: forgets only the counter of the path that
 * let it through. That is the device counter if the token was valid and its
 * latest attempt was allowed, otherwise this network's counter. The per-email
 * slow-down is never cleared (a success must not hand a running attacker
 * fresh free attempts), and other networks' counters stay. Then issue or
 * refresh the device token (src/lib/device-token.ts).
 */
export async function clearSignIn(request: SignInRequest): Promise<void> {
  const keys = signInKeys(request);
  const usedDevice =
    keys.device !== null && (await wasLastAttemptAllowed(keys.device));
  await clearAttempts(usedDevice && keys.device ? keys.device : keys.network);
}
