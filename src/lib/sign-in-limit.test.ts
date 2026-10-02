// Tests for src/lib/sign-in-limit.ts against a real in-memory MongoDB: the
// per-(email + network) hard limit, the per-email progressive slow-down, how
// the two interact, clearing, privacy of stored keys and the 15-minute TTL.

import { setTimeout as sleep } from "node:timers/promises";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LoginAttemptModel } from "@/models/login-attempt";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import { getDb } from "./db";
import { issueDeviceToken } from "./device-token";
import { EnvError } from "./env";
import {
  RESET_EMAIL,
  buildKey,
  clearAllForEmail,
  consume,
  emailKey,
  hashEmail,
} from "./rate-limit";
import {
  SIGN_IN_DEVICE,
  SIGN_IN_NETWORK,
  SIGN_IN_SLOWDOWN,
  type SignInGate,
  clearSignIn,
  consumeSignIn,
} from "./sign-in-limit";

// Test-only secrets (not real ones), 32+ characters each.
const AUTH_SECRET = "test-auth-secret-for-sign-in-limit-0123456";
const IP_SECRET = "test-ip-hash-secret-for-sign-in-limit-6543";
const EMAIL = "admin@example.com";
// 15 minutes plus 1 s of tolerance: expiry is stamped with mongod's clock
// ($$NOW), which can read a millisecond or so ahead of this process's clock.
const FIFTEEN_MIN_MS = 15 * 60 * 1000 + 1_000;

setupMemoryDb("yg_sign_in_limit_test");

beforeAll(async () => {
  await LoginAttemptModel.createIndexes();
});

beforeEach(async () => {
  vi.stubEnv("AUTH_SECRET", AUTH_SECRET);
  vi.stubEnv("IP_HASH_SECRET", IP_SECRET);
  await LoginAttemptModel.deleteMany({});
});

/** Headers as Vercel would send them; no argument = header missing. */
function from(ip?: string): Headers {
  return new Headers(ip === undefined ? {} : { "x-vercel-forwarded-for": ip });
}

/** A distinct IPv4 network per number, for spreading attempts. */
const net = (i: number) => `198.51.100.${i}`;

const attempt = (ip?: string, email = EMAIL) =>
  consumeSignIn({ email, headers: from(ip) });

async function attempts(n: number, ip?: string): Promise<SignInGate[]> {
  const out: SignInGate[] = [];
  for (let i = 0; i < n; i++) out.push(await attempt(ip));
  return out;
}

const slowKey = (email = EMAIL) => buildKey("email-login", hashEmail(email));
const slowState = (email = EMAIL) =>
  LoginAttemptModel.findOne({ key: slowKey(email) }).lean();

/** Pretends the current slow-down wait has passed (without touching expiry). */
async function waitOut(email = EMAIL): Promise<void> {
  await LoginAttemptModel.updateOne(
    { key: slowKey(email) },
    { nextAllowedAt: new Date(Date.now() - 1_000) },
  );
}

/** The per-network counters stored for an email. */
const networkDocs = (email = EMAIL) =>
  LoginAttemptModel.find({
    key: { $regex: new RegExp(`^email-ip-login:${hashEmail(email)}\\.`) },
  }).lean();

const ALLOWED: SignInGate = {
  allowed: true,
  retryAfterSeconds: 0,
  audit: null,
};

describe("hard limit per (email + network)", () => {
  it("allows 5 attempts from one network, then refuses for the rest of the 15 minutes", async () => {
    const results = await attempts(6, net(1));

    expect(results.slice(0, 5)).toEqual(Array(5).fill(ALLOWED));
    const refused = results[5];
    expect(refused?.allowed).toBe(false);
    expect(refused?.audit).toEqual({
      namespace: "email-ip-login",
      reason: "hard_limit",
    });
    expect(refused?.retryAfterSeconds).toBeGreaterThanOrEqual(898);
    expect(refused?.retryAfterSeconds).toBeLessThanOrEqual(900);
  });

  it("does not lock out the same email from another network", async () => {
    await attempts(8, net(1));
    expect(await attempt(net(2))).toEqual(ALLOWED);
  });

  it("does not affect another email on the same network", async () => {
    await attempts(8, net(1));
    expect(await attempt(net(1), "someone@example.com")).toEqual(ALLOWED);
  });

  it("treats every address in one IPv6 /64 as one network", async () => {
    for (let i = 1; i <= 5; i++) {
      expect((await attempt(`2001:db8:aa:bb::${i}`)).allowed).toBe(true);
    }
    expect((await attempt("2001:db8:aa:bb:ffff::9")).audit?.reason).toBe(
      "hard_limit",
    );
    expect(await attempt("2001:db8:aa:bc::1")).toEqual(ALLOWED);
  });

  it("puts requests without a usable header into one shared unknown-network bucket", async () => {
    await attempts(3, undefined);
    await attempt("garbage");
    await attempt("01.2.3.4");
    // Spoofed headers are ignored, so they land in the same bucket.
    const spoofed = await consumeSignIn({
      email: EMAIL,
      headers: new Headers({ "x-forwarded-for": "203.0.113.99" }),
    });
    expect(spoofed.audit?.reason).toBe("hard_limit");
    expect(await networkDocs()).toHaveLength(1);
    // A real Vercel client is unaffected.
    expect(await attempt(net(7))).toEqual(ALLOWED);
  });
});

describe("per-email slow-down", () => {
  it("lets the first 10 attempts through from any networks, then asks for a 2 s wait", async () => {
    for (let i = 1; i <= 10; i++)
      expect(await attempt(net(i))).toEqual(ALLOWED);

    const refused = await attempt(net(11));
    expect(refused).toEqual({
      allowed: false,
      retryAfterSeconds: 2,
      audit: { namespace: "email-login", reason: "slowdown" },
    });
  });

  it("follows the curve 0 x9, then 2, 4, 8, 16, 30, 30 s between attempts", async () => {
    const expectedWaitMs = [
      ...Array<number>(9).fill(0),
      2_000,
      4_000,
      8_000,
      16_000,
      30_000,
      30_000,
      30_000,
    ];
    for (const [i, wait] of expectedWaitMs.entries()) {
      const before = Date.now();
      expect(await attempt(net(i + 1))).toEqual(ALLOWED);
      const after = Date.now();
      const next = (await slowState())?.nextAllowedAt?.getTime() ?? NaN;
      expect(next).toBeGreaterThanOrEqual(before + wait - 50);
      expect(next).toBeLessThanOrEqual(after + wait + 50);
      if (wait > 0) {
        const refused = await attempt(net(100 + i));
        expect(refused.retryAfterSeconds).toBe(wait / 1000);
        await waitOut();
      }
    }
  });

  it("never asks for more than 30 s, however long the attack", async () => {
    for (let i = 1; i <= 60; i++) {
      await attempt(net(i));
      await waitOut();
    }
    const refused = await attempt(net(200)).then(() => attempt(net(201)));
    expect(refused.retryAfterSeconds).toBe(30);
    expect((await slowState())?.count).toBe(61);
  });

  it("allows the next attempt once the real wait is over", async () => {
    for (let i = 1; i <= 10; i++) await attempt(net(i));
    expect((await attempt(net(50))).allowed).toBe(false);

    await sleep(2_100);
    expect(await attempt(net(50))).toEqual(ALLOWED);
  });

  it("refuses attempts during the wait without lengthening it or counting them", async () => {
    for (let i = 1; i <= 12; i++) {
      await attempt(net(i));
      await waitOut();
    }
    await attempt(net(13)); // count 13: the next attempt must wait 16 s
    const before = await slowState();

    const flood = await Promise.all(
      Array.from({ length: 50 }, (_, i) => attempt(net(20 + (i % 40)))),
    );
    expect(
      flood.every((r) => !r.allowed && r.audit?.reason === "slowdown"),
    ).toBe(true);
    expect(
      Math.max(...flood.map((r) => r.retryAfterSeconds)),
    ).toBeLessThanOrEqual(16);

    const after = await slowState();
    expect(after?.count).toBe(before?.count);
    expect(after?.nextAllowedAt).toEqual(before?.nextAllowedAt);
    expect(after?.expiresAt).toEqual(before?.expiresAt);
  });

  it("starts again with 10 free attempts after 15 idle minutes", async () => {
    for (let i = 1; i <= 11; i++) await attempt(net(i));
    await LoginAttemptModel.updateOne(
      { key: slowKey() },
      { expiresAt: new Date(Date.now() - 1_000) },
    );
    for (let i = 21; i <= 30; i++)
      expect(await attempt(net(i))).toEqual(ALLOWED);
    expect((await slowState())?.count).toBe(10);
  });
});

describe("how the two limits interact", () => {
  it("charges the network for an attempt refused by the slow-down (no free polling)", async () => {
    for (let i = 1; i <= 10; i++) await attempt(net(i));
    // Polling 5 times during the wait uses up this network's 5 attempts...
    for (let i = 0; i < 5; i++)
      expect((await attempt(net(99))).audit?.reason).toBe("slowdown");
    expect(await networkDocs()).toContainEqual(
      expect.objectContaining({ count: 5 }),
    );
    // ...so even once the wait is over, this network is hard-limited.
    await waitOut();
    expect((await attempt(net(99))).audit?.reason).toBe("hard_limit");
  });

  it("does not let a hard-limited network take slow-down turns", async () => {
    await attempts(5, net(1));
    const before = await slowState();
    await attempts(30, net(1));
    expect(await slowState()).toEqual(before);
  });
});

describe("results", () => {
  it("only carry allowed, retryAfterSeconds and a privacy-safe audit entry", async () => {
    // 5 allowed + 1 hard limit, 5 allowed, then the 11th accepted one is slowed.
    const results = [
      ...(await attempts(6, net(1))),
      ...(await attempts(5, net(2))),
      await attempt(net(3)),
    ];
    for (const r of results) {
      expect(Object.keys(r).sort()).toEqual([
        "allowed",
        "audit",
        "retryAfterSeconds",
      ]);
      const text = JSON.stringify(r);
      expect(text).not.toContain("example");
      expect(text).not.toContain("198.51");
    }
    expect(results.some((r) => r.audit?.reason === "slowdown")).toBe(true);
    expect(results.some((r) => r.audit?.reason === "hard_limit")).toBe(true);
  });
});

/** One attempt from `ip` carrying a device token. */
const withToken = (token: string, ip?: string, email = EMAIL) =>
  consumeSignIn({ email, headers: from(ip), deviceToken: token });

const deviceDocs = (email = EMAIL) =>
  LoginAttemptModel.find({
    key: { $regex: new RegExp(`^email-dev-login:${hashEmail(email)}\.`) },
  }).lean();

/** Brings the email to the 30 s cap and hard-limits network 1. */
async function underAttack(): Promise<void> {
  for (let i = 0; i < 15; i++) {
    await attempt(net(150 + i));
    await waitOut();
  }
  await attempt(net(170)); // the next untrusted attempt must wait 30 s
  for (let i = 0; i < 5; i++) await attempt(net(1));
}

describe("known device (device token)", () => {
  it("gets in while the slow-down is at its cap and its network is hard-limited, touching neither", async () => {
    await underAttack();
    expect((await attempt(net(1))).allowed).toBe(false);
    const slowBefore = await slowState();
    const networksBefore = await networkDocs();

    const token = issueDeviceToken(EMAIL).value;
    expect(await withToken(token, net(1))).toEqual(ALLOWED);
    expect(await slowState()).toEqual(slowBefore);
    expect(await networkDocs()).toEqual(networksBefore);
  });

  it("allows 5 attempts per 15 minutes, then treats the token as untrusted for the window", async () => {
    const token = issueDeviceToken(EMAIL).value;
    for (let i = 0; i < 5; i++) await attempt(net(1)); // network 1 is used up
    const viaDevice = [];
    for (let i = 0; i < 5; i++) viaDevice.push(await withToken(token, net(1)));
    expect(viaDevice).toEqual(Array(5).fill(ALLOWED));

    // 6th: the device limit is used up, so the untrusted path decides.
    expect(await withToken(token, net(1))).toEqual({
      allowed: false,
      retryAfterSeconds: expect.any(Number) as number,
      audit: { namespace: "email-ip-login", reason: "hard_limit" },
    });
    // From a fresh network the untrusted path lets it through.
    expect(await withToken(token, net(2))).toEqual(ALLOWED);
    const [doc] = await deviceDocs();
    expect(doc?.count).toBe(SIGN_IN_DEVICE.limit);
  });

  it("falls back to the untrusted path for a token of another email or a tampered one", async () => {
    const other = issueDeviceToken("other@example.com").value;
    const mine = issueDeviceToken(EMAIL).value;
    const tampered = `${mine.slice(0, 5)}${mine[5] === "A" ? "B" : "A"}${mine.slice(6)}`;
    for (const token of [other, tampered, "garbage", ""]) {
      await withToken(token, net(1));
    }
    expect(await deviceDocs()).toHaveLength(0);
    expect((await networkDocs())[0]?.count).toBe(4);
  });

  it("lets exactly 5 of 40 parallel attempts through the device path", async () => {
    const token = issueDeviceToken(EMAIL).value;
    for (let i = 0; i < 5; i++) await attempt(net(1)); // untrusted path closed
    const results = await Promise.all(
      Array.from({ length: 40 }, () => withToken(token, net(1))),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(SIGN_IN_DEVICE.limit);
    expect((await deviceDocs())[0]?.count).toBe(SIGN_IN_DEVICE.limit);
  });

  it("stores only HMAC/hash keys for devices, expiring within 15 minutes", async () => {
    const token = issueDeviceToken(EMAIL).value;
    await withToken(token, net(1));
    const checkedAt = Date.now();
    const docs = await deviceDocs();
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc?.key).toMatch(/^email-dev-login:[0-9a-f]{64}\.[0-9a-f]{64}$/);
    expect(doc?.expiresAt.getTime()).toBeLessThanOrEqual(
      checkedAt + FIFTEEN_MIN_MS,
    );
    const raw = JSON.stringify(
      await getDb().collection("loginAttempts").find({}).toArray(),
    );
    for (const part of token.split(".").slice(1))
      expect(raw).not.toContain(part);
  });
});

describe("clearing", () => {
  it("clearSignIn with a working device token forgets only the device counter", async () => {
    const token = issueDeviceToken(EMAIL).value;
    await attempts(3, net(1));
    await withToken(token, net(1));
    const slowBefore = await slowState();
    const networksBefore = await networkDocs();

    await clearSignIn({
      email: EMAIL,
      headers: from(net(1)),
      deviceToken: token,
    });
    expect(await deviceDocs()).toHaveLength(0);
    expect(await networkDocs()).toEqual(networksBefore);
    expect(await slowState()).toEqual(slowBefore);
  });

  it("clearSignIn after a device fell through forgets the network counter instead", async () => {
    const token = issueDeviceToken(EMAIL).value;
    for (let i = 0; i < 6; i++) await withToken(token, net(1)); // 6th is untrusted
    await clearSignIn({
      email: EMAIL,
      headers: from(net(1)),
      deviceToken: token,
    });
    expect(await networkDocs()).toHaveLength(0);
    expect((await deviceDocs())[0]?.count).toBe(SIGN_IN_DEVICE.limit);
  });

  it("clearAllForEmail also forgets the device counters", async () => {
    await withToken(issueDeviceToken(EMAIL).value, net(1));
    await withToken(issueDeviceToken(EMAIL).value, net(1));
    expect(await deviceDocs()).toHaveLength(2);
    await clearAllForEmail(EMAIL);
    expect(await deviceDocs()).toHaveLength(0);
  });

  it("clearSignIn without a device token forgets only this network's counter, never the slow-down", async () => {
    await attempts(5, net(1));
    for (let i = 2; i <= 7; i++) await attempt(net(i));
    const slowBefore = await slowState();
    await clearSignIn({ email: EMAIL, headers: from(net(2)) });

    expect(await slowState()).toEqual(slowBefore);
    const left = await networkDocs();
    expect(left).toHaveLength(6); // net(1) and net(3..7)
    expect((await attempt(net(1))).audit?.reason).toBe("hard_limit");
    // Network 2 is fresh again, but the slow-down still applies to it.
    await waitOut();
    expect(await attempt(net(2))).toEqual(ALLOWED);
  });

  it("clearAllForEmail forgets every network counter, the slow-down and the reset limit of that email only", async () => {
    for (let i = 1; i <= 12; i++) await attempts(5, net(i));
    await consume(emailKey("email-reset", EMAIL), RESET_EMAIL);
    await attempt(net(1), "other@example.com");

    await clearAllForEmail(` ${EMAIL.toUpperCase()} `);

    const raw = await getDb().collection("loginAttempts").find({}).toArray();
    const otherDigest = hashEmail("other@example.com");
    expect(raw.length).toBeGreaterThan(0);
    for (const doc of raw) expect(String(doc.key)).toContain(otherDigest);
    expect(await attempt(net(1))).toEqual(ALLOWED);
  });
});

describe("stored data", () => {
  const IPS = ["203.0.113.7", "2001:db8:1234:5678::abcd", "::ffff:192.0.2.55"];

  it("holds no email or IP, only HMAC keys, with IP keys expiring within 15 minutes", async () => {
    for (const ip of IPS) await attempts(7, ip);
    await attempts(2, undefined);
    const checkedAt = Date.now();

    const raw = await getDb().collection("loginAttempts").find({}).toArray();
    const text = JSON.stringify(raw).toLowerCase();
    for (const fragment of [
      "admin",
      "example",
      "@",
      "203.0.113",
      "2001:db8",
      "1234:5678",
      "192.0.2",
      "unknown-network",
    ]) {
      expect(text).not.toContain(fragment);
    }

    const prefix = `email-ip-login:${hashEmail(EMAIL)}.`;
    const ipDocs = raw.filter((d) =>
      String(d.key).startsWith("email-ip-login:"),
    );
    expect(ipDocs).toHaveLength(IPS.length + 1);
    for (const doc of ipDocs) {
      expect(String(doc.key)).toMatch(
        /^email-ip-login:[0-9a-f]{64}\.[0-9a-f]{64}$/,
      );
      expect(String(doc.key).startsWith(prefix)).toBe(true);
      expect((doc.expiresAt as Date).getTime()).toBeLessThanOrEqual(
        checkedAt + FIFTEEN_MIN_MS,
      );
      expect(Object.keys(doc).sort()).toEqual([
        "_id",
        "count",
        "expiresAt",
        "key",
        "lastAttemptAllowed",
      ]);
    }
    // Every document, IP-derived or not, is gone within 15 minutes.
    for (const doc of raw) {
      expect((doc.expiresAt as Date).getTime()).toBeLessThanOrEqual(
        checkedAt + FIFTEEN_MIN_MS,
      );
    }
  });

  it("never pushes an IP counter's expiry past 15 minutes from its first attempt", async () => {
    const first = Date.now();
    await attempt(IPS[0]);
    for (let i = 0; i < 4; i++) {
      await sleep(250);
      await attempts(3, IPS[0]);
    }
    const [doc] = await networkDocs();
    expect(doc?.expiresAt.getTime()).toBeLessThanOrEqual(
      first + FIFTEEN_MIN_MS,
    );
  });

  it("hashes the network with IP_HASH_SECRET, so changing it (not AUTH_SECRET) changes the key", async () => {
    await attempt(IPS[0]);
    vi.stubEnv("IP_HASH_SECRET", `${IP_SECRET}-rotated`);
    await attempt(IPS[0]);
    const keys = (await networkDocs()).map((d) => d.key);
    expect(new Set(keys).size).toBe(2);
  });

  it("refuses to run without IP_HASH_SECRET", async () => {
    vi.stubEnv("IP_HASH_SECRET", undefined);
    await expect(attempt(IPS[0])).rejects.toThrow(EnvError);
    expect(await LoginAttemptModel.countDocuments({})).toBe(0);
  });
});

describe("concurrency", () => {
  it("allows exactly 5 of 40 parallel attempts from one network", async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, () => attempt(net(1))),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(
      SIGN_IN_NETWORK.limit,
    );
    expect(await networkDocs()).toHaveLength(1);
  });

  it("allows exactly 10 of 60 parallel attempts spread over 20 networks, each charged to its network", async () => {
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => attempt(net(1 + (i % 20)))),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(
      SIGN_IN_SLOWDOWN.freeAttempts,
    );
    expect((await slowState())?.count).toBe(SIGN_IN_SLOWDOWN.freeAttempts);
    const units = (await networkDocs()).reduce((sum, d) => sum + d.count, 0);
    expect(units).toBe(60);
  });
});
