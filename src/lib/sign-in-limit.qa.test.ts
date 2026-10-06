// QA tests (task 3b) that try to break src/lib/sign-in-limit.ts and the
// counters behind it: polling during a wait, the slow-down's free tier under
// heavy concurrency, header edge cases, and the "never a lockout" claim
// against an attacker that controls several networks (known-device path).

import { setTimeout as sleep } from "node:timers/promises";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LoginAttemptModel } from "@/models/login-attempt";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import { clientNetwork } from "./client-ip";
import { issueDeviceToken } from "./device-token";
import {
  type SlowdownRule,
  buildKey,
  consumeSlowdown,
  hashEmail,
} from "./rate-limit";
import {
  SIGN_IN_NETWORK,
  SIGN_IN_SLOWDOWN,
  clearSignIn,
  consumeSignIn,
} from "./sign-in-limit";

const AUTH_SECRET = "qa-auth-secret-for-sign-in-limit-qa-0123456";
const IP_SECRET = "qa-ip-hash-secret-for-sign-in-limit-qa-6543";
const EMAIL = "admin@example.com";

setupMemoryDb("yg_sign_in_limit_qa_test");

beforeAll(async () => {
  await LoginAttemptModel.createIndexes();
});

beforeEach(async () => {
  vi.stubEnv("AUTH_SECRET", AUTH_SECRET);
  vi.stubEnv("IP_HASH_SECRET", IP_SECRET);
  await LoginAttemptModel.deleteMany({});
});

const from = (ip?: string) =>
  new Headers(ip === undefined ? {} : { "x-vercel-forwarded-for": ip });
const attempt = (ip?: string, email = EMAIL) =>
  consumeSignIn({ email, headers: from(ip) });
const net = (i: number) => `198.51.100.${i}`;
const slowKey = (email = EMAIL) => buildKey("email-login", hashEmail(email));
const waitOut = () =>
  LoginAttemptModel.updateOne(
    { key: slowKey() },
    { nextAllowedAt: new Date(Date.now() - 1_000) },
  );
const networkDocs = () =>
  LoginAttemptModel.find({
    key: { $regex: new RegExp(`^email-ip-login:${hashEmail(EMAIL)}\\.`) },
  }).lean();

/* Uses up the 10 free attempts from networks that are not under test. */
async function burnFreeTier(): Promise<void> {
  for (let i = 0; i < SIGN_IN_SLOWDOWN.freeAttempts; i++)
    await attempt(net(200 + (i % 2)));
}

// Updated for the H1 decision: a slow-down refusal now keeps the network
// attempt it used (no give-back), so polling during a wait is no longer free.
describe("polling during a wait", () => {
  it("costs the network: one polling network gets at most 1 turn, then is hard-limited", async () => {
    await burnFreeTier();
    let allowed = 0;
    for (let round = 0; round < 20; round++) {
      await waitOut();
      let inRound = 0;
      for (let i = 0; i < 15; i++)
        if ((await attempt(net(1))).allowed) inRound++;
      // At most one turn per opened wait.
      expect(inRound).toBeLessThanOrEqual(1);
      allowed += inRound;
    }
    // Round 1: one turn, then 4 refused polls use up the other 4 attempts.
    expect(allowed).toBe(1);
    expect((await attempt(net(1))).audit?.reason).toBe("hard_limit");
  });

  it("never lets one network past 5 checked attempts under parallel bursts either", async () => {
    await burnFreeTier();
    let allowed = 0;
    for (let round = 0; round < 20; round++) {
      await waitOut();
      const burst = await Promise.all(
        Array.from({ length: 15 }, () => attempt(net(1))),
      );
      allowed += burst.filter((r) => r.allowed).length;
    }
    expect(allowed).toBeLessThanOrEqual(SIGN_IN_NETWORK.limit);
  });

  it("a parallel burst during a wait uses up the network, and its count stops at 5 (QA L1)", async () => {
    await burnFreeTier();
    const burst = await Promise.all(
      Array.from({ length: 15 }, () => attempt(net(1))),
    );
    expect(burst.every((r) => !r.allowed)).toBe(true);
    const counts = (await networkDocs()).map((d) => d.count);
    expect(Math.max(...counts)).toBe(SIGN_IN_NETWORK.limit);
    await waitOut();
    expect((await attempt(net(1))).audit?.reason).toBe("hard_limit");
  });
});

describe("slow-down free tier under heavy concurrency", () => {
  it.each([1, 2, 3])(
    "round %i: exactly 10 of 300 parallel attempts from 100 networks",
    async () => {
      const results = await Promise.all(
        Array.from({ length: 300 }, (_, i) => attempt(`203.0.113.${i % 100}`)),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(
        SIGN_IN_SLOWDOWN.freeAttempts,
      );
    },
  );

  it("lets exactly one of 50 parallel attempts through when a wait ends", async () => {
    await burnFreeTier();
    for (let round = 0; round < 5; round++) {
      await waitOut();
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => attempt(`203.0.113.${i}`)),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(1);
    }
  });
});

describe("header edge cases", () => {
  it.each([
    ["full-form IPv4-mapped", "0:0:0:0:0:ffff:203.0.113.7", "203.0.113.7"],
    ["upper-case IPv4-mapped", "::FFFF:203.0.113.7", "203.0.113.7"],
    ["IPv4-compatible (deprecated)", "::203.0.113.7", "0:0:0:0::/64"],
    ["IPv4-translated", "::ffff:0:203.0.113.7", "0:0:0:0::/64"],
    [
      "leading zeros in IPv6 groups",
      "2001:0db8:0000:0001::1",
      "2001:db8:0:1::/64",
    ],
    ["tab around the value", "\t203.0.113.7\t", "203.0.113.7"],
  ])("normalises %s", (_label, value, expected) => {
    expect(clientNetwork(from(value))).toBe(expected);
  });

  it("counts an IPv4 address and its IPv4-mapped IPv6 form as one network", async () => {
    for (let i = 0; i < 3; i++) await attempt("203.0.113.7");
    for (let i = 0; i < 2; i++) await attempt("::ffff:203.0.113.7");
    expect((await attempt("::ffff:cb00:7107")).audit?.reason).toBe(
      "hard_limit",
    );
  });

  it("gives the same network unrelated keys for different emails", async () => {
    await attempt("203.0.113.7", "a@example.com");
    await attempt("203.0.113.7", "b@example.com");
    const keys = (
      await LoginAttemptModel.find({ key: /^email-ip-login:/ }).lean()
    ).map((d) => d.key.split(".")[1]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("'never a lockout' against an attacker with several networks", () => {
  it("slow-down refusals now cost the attacker's network an attempt each", async () => {
    await burnFreeTier();
    // One request in flight at a time per network, as a polling attacker would.
    const reasons: (string | undefined)[] = [];
    for (let i = 0; i < 200; i++)
      reasons.push((await attempt(net(1))).audit?.reason);
    expect(reasons.slice(0, 5)).toEqual(Array(5).fill("slowdown"));
    expect(new Set(reasons.slice(5))).toEqual(new Set(["hard_limit"]));
    const counts = (await networkDocs()).map((d) => d.count).sort();
    expect(counts).toEqual([5, 5, 5]);
  });

  // Regression for H1: 6 attacker networks still take every untrusted turn
  // at the 30 s cap, but the owner's known device never competes for them.
  it("the owner with a device token gets in while 6 networks take every untrusted turn", async () => {
    const token = issueDeviceToken(EMAIL, 0).value;
    // Bring the email to the 30 s cap.
    for (let i = 0; i < 15; i++) {
      await attempt(net(150 + i));
      await waitOut();
    }
    let attackerTurns = 0;
    let ownerTurns = 0;
    for (let turn = 0; turn < 30; turn++) {
      await waitOut();
      // The attacker polls continuously, so it is first when the wait ends.
      if ((await attempt(net(1 + (turn % 6)))).allowed) attackerTurns++;
      // The owner arrives a moment later, five times in the window.
      if (turn % 6 === 0) {
        const owner = await consumeSignIn({
          email: EMAIL,
          headers: from("192.0.2.10"),
          deviceToken: token,
          deviceEpoch: 0,
        });
        if (owner.allowed) ownerTurns++;
      }
    }
    expect(attackerTurns).toBe(30);
    expect(ownerTurns).toBe(5);
  });

  it("measures how often a single owner attempt wins against a polling attacker (1 s cap, real time)", async () => {
    const rule: SlowdownRule = {
      freeAttempts: 0,
      baseDelaySeconds: 1,
      maxDelaySeconds: 1,
      idleResetSeconds: 60,
    };
    const key = buildKey("email-login", hashEmail("victim@example.com"));
    let stop = false;
    const attacker = (async () => {
      while (!stop) await consumeSlowdown(key, rule);
    })();
    let ownerWins = 0;
    const tries = 6;
    for (let i = 0; i < tries; i++) {
      await sleep(400 + Math.floor(Math.random() * 300));
      if ((await consumeSlowdown(key, rule)).allowed) ownerWins++;
    }
    stop = true;
    await attacker;
    // With an attacker polling back-to-back the owner almost never gets a turn.
    expect(ownerWins).toBeLessThanOrEqual(1);
  }, 30_000);
});

// Re-review (task 3b, after the device-token fix): what is left for owners
// WITHOUT a device token (new device, cookies cleared), and the edges of the
// device path.
describe("re-review: untrusted owners and the device path", () => {
  const withToken = (deviceToken: string, ip = "192.0.2.10") =>
    consumeSignIn({
      email: EMAIL,
      headers: from(ip),
      deviceToken,
      deviceEpoch: 0,
    });

  async function toCap(): Promise<void> {
    for (let i = 0; i < 15; i++) {
      await attempt(net(150 + i));
      await waitOut();
    }
  }

  it("documents the remaining risk: 6 timed networks still take every untrusted turn, and an untrusted owner also burns their own network", async () => {
    await toCap();
    let attackerTurns = 0;
    const owner: string[] = [];
    for (let turn = 0; turn < 30; turn++) {
      await waitOut();
      // The attacker knows when the wait ends (its own accepted attempt + 30 s,
      // or Retry-After) and fires one shot per turn: 1 network unit per turn.
      if ((await attempt(net(1 + (turn % 6)))).allowed) attackerTurns++;
      // The untrusted owner arrives at a random moment, i.e. during the wait.
      if (turn % 4 === 0)
        owner.push((await attempt("192.0.2.10")).audit?.reason ?? "allowed");
    }
    expect(attackerTurns).toBe(30);
    expect(owner).not.toContain("allowed");
    // After 5 refused tries the owner's own network is hard-limited too.
    expect(owner.slice(0, 5)).toEqual(Array(5).fill("slowdown"));
    expect(new Set(owner.slice(5))).toEqual(new Set(["hard_limit"]));
  });

  it("a forged, foreign-email or expired-format token never skips the slow-down", async () => {
    await burnFreeTier();
    const other = issueDeviceToken("other@example.com", 0).value;
    const forged = `v2.${"A".repeat(22)}.${Math.floor(Date.now() / 1000)}.${"A".repeat(43)}`;
    for (const t of [other, forged, "", "garbage"]) {
      const r = await withToken(t, net(Math.floor(Math.random() * 100) + 1));
      expect(r.audit?.reason).toBe("slowdown");
    }
    expect(
      await LoginAttemptModel.countDocuments({ key: /^email-dev-login:/ }),
    ).toBe(0);
  });

  it("copies of one token share one device counter (theft gives at most 5 per 15 min, from any number of networks)", async () => {
    await toCap();
    const token = issueDeviceToken(EMAIL, 0).value;
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => withToken(token, net(1 + i))),
    );
    // 5 through the device path, at most 1 untrusted turn on top.
    expect(results.filter((r) => r.allowed).length).toBeGreaterThanOrEqual(5);
    expect(results.filter((r) => r.allowed).length).toBeLessThanOrEqual(6);
  });

  it("documents that a thief with a copy of the owner's token can use up the owner's device path for the window", async () => {
    await toCap();
    const token = issueDeviceToken(EMAIL, 0).value;
    for (let i = 0; i < 5; i++) await withToken(token, net(60));
    await attempt(net(99)); // another attacker network takes the open turn
    const owner = await withToken(token, "192.0.2.10");
    expect(owner.audit?.reason).toBe("slowdown");
  });

  it("clearSignIn race (QA L2): the path of the successful attempt is passed in, so a parallel attempt that fell through can't redirect the clear", async () => {
    const token = issueDeviceToken(EMAIL, 0).value;
    for (let i = 0; i < 4; i++) await withToken(token);
    const success = await withToken(token); // 5th = the success
    expect(success.path).toBe("device");
    const parallel = await withToken(token); // a parallel 6th falls through
    expect(parallel.path).toBe("network");
    await clearSignIn(
      {
        email: EMAIL,
        headers: from("192.0.2.10"),
        deviceToken: token,
        deviceEpoch: 0,
      },
      success.path ?? "network",
    );
    // The device counter of the successful sign-in is cleared, so the owner's
    // own device never runs out after 5 successful sign-ins.
    expect(
      await LoginAttemptModel.countDocuments({ key: /^email-dev-login:/ }),
    ).toBe(0);
  });
});
