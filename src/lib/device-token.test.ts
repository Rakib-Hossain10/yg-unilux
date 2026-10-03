// Tests for src/lib/device-token.ts: round trip, binding to one email and one
// device epoch, tamper resistance, expiry, garbage and length caps, and that
// the token carries no email. Pure crypto, no database.

import { timingSafeEqual } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEVICE_COOKIE,
  issueDeviceToken,
  verifyDeviceToken,
} from "./device-token";
import { EnvError } from "./env";

// Wraps timingSafeEqual (still the real one) so a test can prove the MAC
// comparison goes through it rather than through === or Buffer.equals.
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return { ...real, timingSafeEqual: vi.fn(real.timingSafeEqual) };
});

const EMAIL = "admin@example.com";
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "test-auth-secret-for-device-token-0123456");
});

/*
 * Replaces one character of the token at `index` with a different one of the
 * same class (a digit stays a digit), so a change to issuedAt still passes
 * the format check and has to be caught by the MAC.
 */
function flip(value: string, index: number): string {
  const ch = value[index] ?? "";
  const c = /\d/.test(ch)
    ? String((Number(ch) + 1) % 10)
    : ch === "A"
      ? "B"
      : "A";
  return value.slice(0, index) + c + value.slice(index + 1);
}

describe("issueDeviceToken", () => {
  it("returns a v2 token and the __Host- cookie settings", () => {
    const { value, cookie } = issueDeviceToken(EMAIL, 0);
    expect(value).toMatch(/^v2\.[A-Za-z0-9_-]{22}\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(cookie).toEqual({
      name: "__Host-yg-device",
      maxAgeSeconds: 180 * 24 * 60 * 60,
      attributes: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
    });
    expect(cookie).toBe(DEVICE_COOKIE);
    expect(Object.keys(cookie.attributes)).not.toContain("domain");
  });

  it("holds no part of the email", () => {
    const { value } = issueDeviceToken(EMAIL, 0);
    expect(value.toLowerCase()).not.toContain("admin");
    expect(value.toLowerCase()).not.toContain("example");
    expect(Buffer.from(value.split(".")[1] ?? "", "base64url")).toHaveLength(
      16,
    );
  });

  it("uses a fresh random nonce every time", () => {
    const a = issueDeviceToken(EMAIL, 0).value.split(".")[1];
    const b = issueDeviceToken(EMAIL, 0).value.split(".")[1];
    expect(a).not.toBe(b);
  });
});

describe("verifyDeviceToken", () => {
  it("accepts its own token for the same email (any case) and returns a stable 64-hex id", () => {
    const { value } = issueDeviceToken(EMAIL, 0);
    const id = verifyDeviceToken(value, EMAIL, 0);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyDeviceToken(value, " ADMIN@example.com ", 0)).toBe(id);
  });

  it("compares the MAC in constant time (timingSafeEqual on 32-byte buffers)", () => {
    const { value } = issueDeviceToken(EMAIL, 0);
    vi.mocked(timingSafeEqual).mockClear();
    verifyDeviceToken(value, "other@example.com", 0);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    const [a, b] = vi.mocked(timingSafeEqual).mock.calls[0] ?? [];
    expect((a as Buffer).length).toBe(32);
    expect((b as Buffer).length).toBe(32);
  });

  it("rejects the token for any other email", () => {
    const { value } = issueDeviceToken(EMAIL, 0);
    expect(verifyDeviceToken(value, "other@example.com", 0)).toBeNull();
  });

  it("rejects every single-character change (nonce, issuedAt, MAC)", () => {
    const { value } = issueDeviceToken(EMAIL, 0);
    for (let i = 3; i < value.length; i++) {
      if (value[i] === ".") continue;
      expect(
        verifyDeviceToken(flip(value, i), EMAIL, 0),
        `index ${i}`,
      ).toBeNull();
    }
  });

  it("protects issuedAt with the MAC: a token re-dated to now with its original MAC is rejected", () => {
    vi.useFakeTimers();
    try {
      const { value } = issueDeviceToken(EMAIL, 0);
      const [version, nonce, issuedAt, tag] = value.split(".");
      // 179 days on, the real token is still valid (so the clock checks pass)...
      vi.setSystemTime(Date.now() + 179 * DAY_MS);
      expect(verifyDeviceToken(value, EMAIL, 0)).not.toBeNull();
      // ...but moving issuedAt to now, to stretch its life, breaks the MAC.
      const now = String(Math.floor(Date.now() / 1000));
      expect(now).not.toBe(issuedAt);
      const redated = [version, nonce, now, tag].join(".");
      expect(verifyDeviceToken(redated, EMAIL, 0)).toBeNull();
      // A one-second change, well inside every clock check, is caught too.
      const plusOne = String(Number(issuedAt) + 1);
      expect(
        verifyDeviceToken([version, nonce, plusOne, tag].join("."), EMAIL, 0),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects issuedAt written with leading zeros (same number, different MAC input)", () => {
    const { value } = issueDeviceToken(EMAIL, 0);
    const [version, nonce, issuedAt, tag] = value.split(".");
    expect(
      verifyDeviceToken(
        [version, nonce, `0${issuedAt}`, tag].join("."),
        EMAIL,
        0,
      ),
    ).toBeNull();
  });

  it("rejects a non-canonical spelling of a valid MAC (spare bits set)", () => {
    for (let i = 0; i < 50; i++) {
      const { value } = issueDeviceToken(EMAIL, 0);
      const last = value.at(-1) ?? "A";
      const alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      // Same top 4 bits, different spare low 2 bits.
      const sibling = alphabet[alphabet.indexOf(last) ^ 1] ?? "A";
      expect(
        verifyDeviceToken(value.slice(0, -1) + sibling, EMAIL, 0),
      ).toBeNull();
    }
  });

  it("rejects a token signed with another AUTH_SECRET", () => {
    const { value } = issueDeviceToken(EMAIL, 0);
    vi.stubEnv("AUTH_SECRET", "another-auth-secret-for-device-token-987");
    expect(verifyDeviceToken(value, EMAIL, 0)).toBeNull();
  });

  it("expires after 180 days and rejects issuedAt far in the future", () => {
    vi.useFakeTimers();
    try {
      const { value } = issueDeviceToken(EMAIL, 0);
      vi.setSystemTime(Date.now() + 179 * DAY_MS);
      expect(verifyDeviceToken(value, EMAIL, 0)).not.toBeNull();
      vi.setSystemTime(Date.now() + 2 * DAY_MS);
      expect(verifyDeviceToken(value, EMAIL, 0)).toBeNull();

      vi.setSystemTime(Date.now() - 400 * DAY_MS);
      expect(verifyDeviceToken(value, EMAIL, 0)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects another version, garbage and oversized input without throwing", () => {
    const { value } = issueDeviceToken(EMAIL, 0);
    for (const bad of [
      value.replace(/^v2/, "v1"),
      `${value}.extra`,
      `${value} `,
      "",
      "v1...",
      "not a token",
      "x".repeat(10_000),
      `v2.${"A".repeat(22)}.${"9".repeat(13)}.${"A".repeat(43)}`,
      null,
      undefined,
      42,
      { value },
    ]) {
      expect(verifyDeviceToken(bad, EMAIL, 0)).toBeNull();
    }
    expect(verifyDeviceToken(value, "a".repeat(255), 0)).toBeNull();
    expect(verifyDeviceToken(value, null, 0)).toBeNull();
  });

  it("throws EnvError (config, not input) when AUTH_SECRET is missing", () => {
    const { value } = issueDeviceToken(EMAIL, 0);
    vi.stubEnv("AUTH_SECRET", undefined);
    expect(() => verifyDeviceToken(value, EMAIL, 0)).toThrow(EnvError);
  });
});

describe("device epoch (revocation, QA L1)", () => {
  it("verifies only at the epoch it was issued for", () => {
    const { value } = issueDeviceToken(EMAIL, 3);
    expect(verifyDeviceToken(value, EMAIL, 3)).toMatch(/^[0-9a-f]{64}$/);
    for (const other of [0, 2, 4, 1_000]) {
      expect(
        verifyDeviceToken(value, EMAIL, other),
        `epoch ${other}`,
      ).toBeNull();
    }
  });

  it("an old token fails after the epoch is bumped, and a fresh one works", () => {
    const old = issueDeviceToken(EMAIL, 0).value;
    // A password reset, an admin password change or a ban bumps 0 -> 1.
    expect(verifyDeviceToken(old, EMAIL, 1)).toBeNull();
    const fresh = issueDeviceToken(EMAIL, 1).value;
    expect(verifyDeviceToken(fresh, EMAIL, 1)).not.toBeNull();
    expect(verifyDeviceToken(fresh, EMAIL, 0)).toBeNull();
  });

  it("does not write the epoch into the token", () => {
    const a = issueDeviceToken(EMAIL, 0).value.split(".");
    const b = issueDeviceToken(EMAIL, 987_654).value.split(".");
    expect(a).toHaveLength(4);
    expect(b).toHaveLength(4);
    expect(b.join(".")).not.toContain("987654");
  });

  it("rejects an invalid epoch: verify returns null, issue throws", () => {
    const { value } = issueDeviceToken(EMAIL, 0);
    for (const bad of [-1, 1.5, Number.NaN, "0", null, undefined, 2 ** 60]) {
      expect(verifyDeviceToken(value, EMAIL, bad)).toBeNull();
    }
    expect(() => issueDeviceToken(EMAIL, -1)).toThrow(TypeError);
    expect(() => issueDeviceToken(EMAIL, 0.5)).toThrow(TypeError);
  });
});
