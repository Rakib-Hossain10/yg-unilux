// Tests for the signed form stamp (src/lib/form-stamp.ts, QA gate B L-1):
// only a stamp this server issued, with an untouched MAC, verifies, and the
// age it reports is measured from the server's own issue time.

import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EnvError } from "./env";
import {
  FORM_STAMP_MAX_AGE_MS,
  issueFormStamp,
  readFormStamp,
} from "./form-stamp";

const SECRET = "form-stamp-test-secret-0123456789abcdefghij";
const NOW = new Date("2026-10-10T08:00:00.000Z");
const INVALID = { ok: false, reason: "invalid" };
const EXPIRED = { ok: false, reason: "expired" };

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/* Swap the first MAC character for another valid base64url character. */
function tamper(stamp: string): string {
  const dot = stamp.indexOf(".");
  const first = stamp[dot + 1];
  return `${stamp.slice(0, dot + 1)}${first === "A" ? "B" : "A"}${stamp.slice(dot + 2)}`;
}

describe("issueFormStamp", () => {
  it("is '<ms>.<43-char base64url MAC>' with the issue time", () => {
    const stamp = issueFormStamp(NOW);
    expect(stamp).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    expect(stamp.split(".")[0]).toBe(String(NOW.getTime()));
  });

  it("does not MAC the time with AUTH_SECRET itself (domain-separated key)", () => {
    const ms = String(NOW.getTime());
    const plain = createHmac("sha256", SECRET).update(ms).digest("base64url");
    expect(issueFormStamp(NOW)).not.toBe(`${ms}.${plain}`);
  });

  it("fails loudly without AUTH_SECRET", () => {
    vi.stubEnv("AUTH_SECRET", "");
    expect(() => issueFormStamp(NOW)).toThrow(EnvError);
  });
});

describe("readFormStamp", () => {
  it("returns the age of a stamp this server issued", () => {
    const stamp = issueFormStamp(new Date(NOW.getTime() - 10_000));
    expect(readFormStamp(stamp, NOW)).toStrictEqual({
      ok: true,
      ageMs: 10_000,
    });
  });

  it("refuses a plain number (the old forgeable startedAt)", () => {
    expect(readFormStamp("1", NOW)).toStrictEqual(INVALID);
    expect(readFormStamp(String(NOW.getTime() - 60_000), NOW)).toStrictEqual(
      INVALID,
    );
  });

  it("refuses a tampered MAC", () => {
    const stamp = issueFormStamp(new Date(NOW.getTime() - 10_000));
    expect(readFormStamp(tamper(stamp), NOW)).toStrictEqual(INVALID);
  });

  it("refuses a non-canonical spelling of the right MAC (padding bits)", () => {
    const stamp = issueFormStamp(new Date(NOW.getTime() - 10_000));
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(stamp.at(-1) ?? "A");
    // The last of 43 characters carries 4 data bits and 2 unused bits.
    const twin = `${stamp.slice(0, -1)}${alphabet[last ^ 1]}`;
    expect(twin).not.toBe(stamp);
    expect(readFormStamp(twin, NOW)).toStrictEqual(INVALID);
  });

  it("a forged old stamp is invalid, never expired", () => {
    const mac = issueFormStamp(NOW).split(".")[1];
    const old = NOW.getTime() - FORM_STAMP_MAX_AGE_MS - 60_000;
    expect(readFormStamp(`${old}.${mac}`, NOW)).toStrictEqual(INVALID);
  });

  it("refuses a valid MAC moved onto another time", () => {
    const stamp = issueFormStamp(new Date(NOW.getTime() - 10_000));
    const mac = stamp.split(".")[1];
    expect(
      readFormStamp(`${NOW.getTime() - 3_600_000}.${mac}`, NOW),
    ).toStrictEqual(INVALID);
  });

  it("refuses a stamp signed with another secret", () => {
    vi.stubEnv("AUTH_SECRET", "another-secret-entirely-0123456789abcdefgh");
    const foreign = issueFormStamp(new Date(NOW.getTime() - 10_000));
    vi.stubEnv("AUTH_SECRET", SECRET);
    expect(readFormStamp(foreign, NOW)).toStrictEqual(INVALID);
  });

  it("reports a genuine stamp older than the maximum age as expired, accepts one at it", () => {
    const atLimit = issueFormStamp(
      new Date(NOW.getTime() - FORM_STAMP_MAX_AGE_MS),
    );
    const tooOld = issueFormStamp(
      new Date(NOW.getTime() - FORM_STAMP_MAX_AGE_MS - 1),
    );
    expect(readFormStamp(atLimit, NOW)).toStrictEqual({
      ok: true,
      ageMs: FORM_STAMP_MAX_AGE_MS,
    });
    expect(readFormStamp(tooOld, NOW)).toStrictEqual(EXPIRED);
    expect(FORM_STAMP_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("refuses a stamp issued in the future", () => {
    const future = issueFormStamp(new Date(NOW.getTime() + 1));
    expect(readFormStamp(future, NOW)).toStrictEqual(INVALID);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["a number", NOW.getTime()],
    ["an array", ["1.a"]],
    ["empty", ""],
    ["no MAC", `${NOW.getTime()}.`],
    ["short MAC", `${NOW.getTime()}.abc`],
    ["bad charset", `${NOW.getTime()}.${"+".repeat(43)}`],
    ["too long", `${"9".repeat(16)}.${"A".repeat(43)}`],
    ["padding", ` ${NOW.getTime()}.${"A".repeat(43)}`],
  ])("refuses a malformed stamp (%s)", (_label, value) => {
    expect(readFormStamp(value, NOW)).toStrictEqual(INVALID);
  });
});
