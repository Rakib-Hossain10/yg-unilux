// Rate limits for the auth endpoints (ADR 0022): sign-in (known devices, per
// email + network, per-email slow-down), password-reset requests, and the HMAC'd
// storage for Better Auth's own per-network limiter. The only rate-limit code
// that sees an IP; banned on whistleblower routes by ESLint.

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
  hashUserId,
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

/**
 * Password-reset requests: 3 per (email + network) per 15 minutes, hard. The
 * window is 15 minutes, not an hour, because this key is derived from the IP
 * and every IP-derived record must be gone within 15 minutes (ADR 0022). The
 * per-email throttle below holds no IP and keeps its one-hour memory.
 */
export const RESET_NETWORK = {
  limit: 3,
  windowSeconds: 15 * 60,
} as const satisfies RateLimitRule;

/**
 * Password-reset requests per email (user decision 2026-10-02): the first 3
 * are immediate, then at most one every 10 minutes. It never blocks entirely,
 * so an attacker can't use up the owner's reset emails. The count resets
 * after an hour without an accepted request.
 */
export const RESET_SLOWDOWN = {
  freeAttempts: 3,
  baseDelaySeconds: 10 * 60,
  maxDelaySeconds: 10 * 60,
  idleResetSeconds: 60 * 60,
} as const satisfies SlowdownRule;

/**
 * /change-password: 5 attempts per signed-in user per 15 minutes, hard,
 * counted before the current password is checked (task-5 QA L1). Every
 * attempt counts, right or wrong, so a stolen session can't guess the
 * current password faster than this. Better Auth's per-network rule caps
 * the same path at 10 per 15 minutes on top.
 */
export const PASSWORD_CHANGE = {
  limit: 5,
  windowSeconds: 15 * 60,
} as const satisfies RateLimitRule;

/**
 * Better Auth's own limiter windows must stay within 15 minutes, so its
 * HMAC'd network counters are gone as fast as the sign-in ones (ADR 0022).
 */
export const AUTH_LIMITER_MAX_WINDOW_SECONDS = 15 * 60;

/** Which limit refused an attempt: for the audit log. Never an email or IP. */
export interface AuthLimitAudit {
  namespace:
    | "email-ip-login"
    | "email-login"
    | "email-dev-login"
    | "email-ip-reset"
    | "email-reset"
    | "user-pw-change";
  reason: "hard_limit" | "slowdown";
}

/** Which counter let a sign-in through; clearSignIn() clears only that one. */
export type SignInPath = "device" | "network";

/**
 * The decision for one sign-in attempt. The caller sends ONE generic
 * response for every refusal (same body whichever limit tripped and whether
 * or not the account exists), with Retry-After = retryAfterSeconds.
 */
export type SignInGate =
  | { allowed: true; retryAfterSeconds: 0; audit: null; path: SignInPath }
  | {
      allowed: false;
      retryAfterSeconds: number;
      audit: AuthLimitAudit;
      path: null;
    };

/** The decision for one password-reset request (there is no device path). */
export type ResetRequestGate =
  | { allowed: true; retryAfterSeconds: 0; audit: null }
  | { allowed: false; retryAfterSeconds: number; audit: AuthLimitAudit };

/** The decision for one /change-password attempt: same shape as a reset. */
export type PasswordChangeGate = ResetRequestGate;

interface AttemptBase {
  /** The email as submitted, after Zod validation. */
  email: string;
  /** The request headers; only x-vercel-forwarded-for is read. */
  headers: HeaderSource;
}

/**
 * One sign-in attempt. A device token is only meaningful together with the
 * account's current device epoch (unknown email: 0, and the token can't
 * verify because none was ever issued for it).
 */
export type SignInRequest = AttemptBase &
  (
    | { deviceToken?: undefined; deviceEpoch?: undefined }
    | {
        /** The raw __Host-yg-device cookie value, if the browser sent one. */
        deviceToken: string | undefined;
        deviceEpoch: number;
      }
  );

export type ResetRequest = AttemptBase;

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

/* HMAC under the IP key, as 64 hex. Inputs never leave this module unhashed. */
function ipHmac(input: string): string {
  return createHmac("sha256", ipSubkey()).update(input).digest("hex");
}

/*
 * The network part of a per-(email + network) key: an HMAC (with the
 * dedicated IP_HASH_SECRET) of the email digest plus the network, so the
 * stored value can't be reversed without the secret, and the same network
 * gives unrelated values for different emails (no cross-account linking).
 * Reset keys add a "reset" label so they never equal a sign-in key.
 */
function networkDigest(
  scope: "sign-in" | "reset",
  emailDigest: string,
  headers: HeaderSource,
): string {
  const network = clientNetwork(headers) ?? UNKNOWN_NETWORK;
  return ipHmac(
    scope === "sign-in"
      ? `${emailDigest}\n${network}`
      : `reset\n${emailDigest}\n${network}`,
  );
}

/*
 * The counter keys for one sign-in attempt. The device part is the SHA-256
 * of a verified token's random nonce, or null without a valid token for this
 * email at its current epoch. All of one email's network and device
 * counters share the prefixes "email-ip-login:<email HMAC>." and
 * "email-dev-login:<email HMAC>.", which clearAllForEmail() relies on.
 */
function signInKeys(request: SignInRequest): {
  device: RateLimitKey | null;
  network: RateLimitKey;
  email: RateLimitKey;
} {
  const emailDigest = hashEmail(request.email);
  const deviceId =
    request.deviceToken === undefined
      ? null
      : verifyDeviceToken(
          request.deviceToken,
          request.email,
          request.deviceEpoch,
        );
  return {
    device:
      deviceId === null
        ? null
        : buildKey("email-dev-login", emailDigest, deviceId),
    network: buildKey(
      "email-ip-login",
      emailDigest,
      networkDigest("sign-in", emailDigest, request.headers),
    ),
    email: buildKey("email-login", emailDigest),
  };
}

function refused(retryAfterSeconds: number, audit: AuthLimitAudit): SignInGate {
  return { allowed: false, retryAfterSeconds, audit, path: null };
}

function allowedVia(path: SignInPath): SignInGate {
  return { allowed: true, retryAfterSeconds: 0, audit: null, path };
}

/**
 * Call BEFORE checking the password; proceed only if `allowed`, and keep
 * `path` for clearSignIn(). Each step counts and decides in one atomic
 * update, so there is no check-then-record race.
 * 0. A valid device token for this email and epoch: only its own hard limit
 *    applies, so an attacker elsewhere can't take the owner's turns. When it
 *    is used up, the attempt falls through to the untrusted path below.
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
    return allowedVia("device");
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

  return allowedVia("network");
}

/**
 * Call after a SUCCESSFUL sign-in with the `path` consumeSignIn() returned
 * for that attempt (QA L2: passed along, never read back from the database,
 * so a parallel attempt can't change the answer). Forgets only that counter:
 * the device counter, or this network's counter. The per-email slow-down is
 * never cleared (a success must not hand a running attacker fresh free
 * attempts), and other networks' counters stay. Then issue or refresh the
 * device token (src/lib/device-token.ts).
 */
export async function clearSignIn(
  request: SignInRequest,
  path: SignInPath,
): Promise<void> {
  const keys = signInKeys(request);
  // "device" with a token that no longer verifies can't happen within one
  // request; fall back to the network counter rather than clear nothing.
  await clearAttempts(
    path === "device" && keys.device ? keys.device : keys.network,
  );
}

/**
 * Call BEFORE handling a password-reset request; proceed only if `allowed`.
 * Unknown emails are counted exactly like known ones, so the answer never
 * reveals whether an account exists.
 * 1. The (email + network) hard limit: 3 per 15 minutes.
 * 2. The per-email throttle: 3 immediately, then one per 10 minutes. Like the
 *    sign-in slow-down, a refusal here still costs the network an attempt.
 * Throws RateLimitUnavailableError or EnvError like consumeSignIn().
 */
export async function consumeResetRequest(
  request: ResetRequest,
): Promise<ResetRequestGate> {
  const emailDigest = hashEmail(request.email);
  const network = await consume(
    buildKey(
      "email-ip-reset",
      emailDigest,
      networkDigest("reset", emailDigest, request.headers),
    ),
    RESET_NETWORK,
  );
  if (!network.allowed) {
    return {
      allowed: false,
      retryAfterSeconds: network.retryAfterSeconds,
      audit: { namespace: "email-ip-reset", reason: "hard_limit" },
    };
  }
  const throttle = await consumeSlowdown(
    buildKey("email-reset", emailDigest),
    RESET_SLOWDOWN,
  );
  if (!throttle.allowed) {
    return {
      allowed: false,
      retryAfterSeconds: throttle.retryAfterSeconds,
      audit: { namespace: "email-reset", reason: "slowdown" },
    };
  }
  return { allowed: true, retryAfterSeconds: 0, audit: null };
}

/**
 * Call BEFORE handling a /change-password request for a signed-in user;
 * proceed only if `allowed`. Keyed by the user id (HMAC'd), never by IP.
 * Throws RateLimitUnavailableError or EnvError like consumeSignIn().
 */
export async function consumePasswordChange(
  userId: string,
): Promise<PasswordChangeGate> {
  const result = await consume(
    buildKey("user-pw-change", hashUserId(userId)),
    PASSWORD_CHANGE,
  );
  if (!result.allowed) {
    return {
      allowed: false,
      retryAfterSeconds: result.retryAfterSeconds,
      audit: { namespace: "user-pw-change", reason: "hard_limit" },
    };
  }
  return { allowed: true, retryAfterSeconds: 0, audit: null };
}

/** The rule Better Auth passes to its limiter storage (seconds, requests). */
export interface AuthLimiterRule {
  window: number;
  max: number;
}

/*
 * Better Auth's key is "<normalised ip>|<path>" (better-auth 1.7.7,
 * @better-auth/core/dist/utils/ip.mjs:228 createRateLimitKey). It is HMAC'd
 * here before it reaches the database, so no raw IP is ever stored (QA M1).
 */
const MAX_AUTH_LIMITER_KEY_LENGTH = 1024;

/**
 * Better Auth's `rateLimit.customStorage` (BetterAuthRateLimitStorage,
 * @better-auth/core/dist/types/init-options.d.mts:142). Each call counts one
 * request and decides atomically, with our fixed-window counter on
 * loginAttempts under the "ba-limit" namespace and an HMAC'd key. Windows
 * over 15 minutes are refused as a configuration error, so the TTL rule
 * holds. Throws RateLimitUnavailableError when the database fails.
 */
export const authLimiterStorage = {
  async consume(
    key: string,
    rule: AuthLimiterRule,
  ): Promise<{ allowed: boolean; retryAfter: number | null }> {
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.length > MAX_AUTH_LIMITER_KEY_LENGTH
    ) {
      throw new TypeError("authLimiterStorage: invalid key");
    }
    if (
      !Number.isInteger(rule.window) ||
      rule.window < 1 ||
      rule.window > AUTH_LIMITER_MAX_WINDOW_SECONDS ||
      !Number.isInteger(rule.max) ||
      rule.max < 1
    ) {
      throw new TypeError(
        "authLimiterStorage: the window must be 1..900 s and max at least 1",
      );
    }
    const counterKey = buildKey("ba-limit", ipHmac(`ba-limit\n${key}`));
    const result = await consume(counterKey, {
      limit: rule.max,
      windowSeconds: rule.window,
    });
    return {
      allowed: result.allowed,
      retryAfter: result.allowed ? null : result.retryAfterSeconds,
    };
  },
};
