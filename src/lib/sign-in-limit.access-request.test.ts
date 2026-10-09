// Tests for consumeAccessRequest() in src/lib/sign-in-limit.ts (ADR 0069):
// the public access-request form's limits per network (all emails share
// it) and per email, the unknown-network fallback, and that keys hold no
// raw email or IP.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LoginAttemptModel } from "@/models/login-attempt";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import {
  ACCESS_REQUEST_EMAIL,
  ACCESS_REQUEST_NETWORK,
  consumeAccessRequest,
} from "./sign-in-limit";

// Test-only secrets (not real ones): 32+ characters each, and different.
const AUTH_SECRET = "access-request-limit-auth-secret-0123456789";
const IP_SECRET = "access-request-limit-ip-secret-0123456789ab";

setupMemoryDb("yg_access_request_limit_test");

beforeAll(async () => {
  await LoginAttemptModel.createIndexes();
});

beforeEach(async () => {
  vi.stubEnv("AUTH_SECRET", AUTH_SECRET);
  vi.stubEnv("IP_HASH_SECRET", IP_SECRET);
  await LoginAttemptModel.deleteMany({});
});

function from(ip?: string): Headers {
  return new Headers(ip === undefined ? {} : { "x-vercel-forwarded-for": ip });
}

const submit = (email: string, ip?: string) =>
  consumeAccessRequest({ email, headers: from(ip) });

describe("consumeAccessRequest", () => {
  it("the rules: 5 per network per 15 min (ADR 0022 TTL), 3 per email per day", () => {
    expect(ACCESS_REQUEST_NETWORK).toEqual({ limit: 5, windowSeconds: 900 });
    expect(ACCESS_REQUEST_EMAIL).toEqual({ limit: 3, windowSeconds: 86_400 });
  });

  it("one network is capped across ALL the emails it types", async () => {
    for (let i = 0; i < 5; i++) {
      expect(await submit(`person${i}@example.com`, "198.51.100.7")).toEqual({
        allowed: true,
      });
    }
    expect(await submit("sixth@example.com", "198.51.100.7")).toEqual({
      allowed: false,
      namespace: "access-request-net",
    });
    // Another network is unaffected.
    expect(await submit("sixth@example.com", "198.51.100.8")).toEqual({
      allowed: true,
    });
  });

  it("one email is capped at 3 across networks", async () => {
    for (let i = 1; i <= 3; i++) {
      expect(await submit("same@example.com", `203.0.113.${i}`)).toEqual({
        allowed: true,
      });
    }
    expect(await submit("SAME@example.com ", "203.0.113.9")).toEqual({
      allowed: false,
      namespace: "access-request-email",
    });
  });

  it("a network refusal does not touch the email counter", async () => {
    for (let i = 0; i < 5; i++) await submit(`n${i}@example.com`, "192.0.2.1");
    await submit("victim@example.com", "192.0.2.1");
    await submit("victim@example.com", "192.0.2.1");
    // The two refused tries above didn't use the victim's 3 per day.
    for (let i = 1; i <= 3; i++) {
      expect(await submit("victim@example.com", `192.0.2.${10 + i}`)).toEqual({
        allowed: true,
      });
    }
  });

  it("without the trusted header, each email gets its own network bucket", async () => {
    for (let i = 0; i < 3; i++) await submit("a@example.com");
    expect(await submit("a@example.com")).toMatchObject({ allowed: false });
    expect(await submit("b@example.com")).toEqual({ allowed: true });
  });

  it("stores only HMAC'd keys, and network keys live at most 15 minutes", async () => {
    await submit("plain@example.com", "198.51.100.42");
    const docs = await LoginAttemptModel.find({}).lean();
    expect(docs).toHaveLength(2);
    const text = JSON.stringify(docs);
    expect(text).not.toContain("plain@example.com");
    expect(text).not.toContain("198.51.100.42");
    for (const doc of docs) {
      expect(doc.key).toMatch(/^access-request-(net|email):[0-9a-f]{64}$/);
    }
    const net = docs.find((doc) => doc.key.startsWith("access-request-net:"));
    expect(net?.expiresAt.getTime() ?? 0).toBeLessThanOrEqual(
      Date.now() + 15 * 60 * 1000 + 1000,
    );
  });
});
