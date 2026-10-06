// QA (task 12): reproduces the e2e "[auth] request failed: Error" seen once on
// a cold run: many sign-ins at once (right and wrong passwords, one email,
// no trusted IP header, like the e2e browser) on a fresh in-memory replica set.
// Calls auth.handler directly so a thrown error keeps its message and stack.

import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuditLogModel } from "@/models/audit-log";
import { LoginAttemptModel } from "@/models/login-attempt";

import { type Auth, createAuth } from "./auth";
import { connectDb, disconnectDb, getDb } from "./db";
import { syncBetterAuthIndexes } from "./db-indexes";

const BASE = "http://localhost:3000";
const ADMIN = { email: "qa-conc@example.com", password: "qa-conc-password-1" };

let replSet: MongoMemoryReplSet;
let auth: Auth;

function stubEnv(uri: string): void {
  vi.stubEnv("MONGODB_URI", uri);
  vi.stubEnv("AUTH_SECRET", "qa-auth-secret-for-better-auth-tests-0123456");
  vi.stubEnv("AUTH_URL", BASE);
  vi.stubEnv("IP_HASH_SECRET", "qa-ip-secret-for-better-auth-tests-9876543");
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  stubEnv(replSet.getUri("yg_conc_qa"));
  await connectDb();
  await LoginAttemptModel.createIndexes();
  await AuditLogModel.createIndexes();
  await syncBetterAuthIndexes(getDb());
  auth = createAuth({ runInBackground: () => undefined });
  Object.assign(globalThis, { __ygUniluxAuth: auth });
  await auth.api.createUser({
    body: { ...ADMIN, name: "QA Conc", role: "admin" },
  });
}, 600_000);

afterAll(async () => {
  await disconnectDb();
  await replSet?.stop();
});

function signIn(password: string): Request {
  return new Request(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: ADMIN.email, password, rememberMe: true }),
  });
}

describe("concurrent sign-ins for one email on a cold replica set", () => {
  it("never throws a non-API error out of Better Auth", async () => {
    stubEnv(replSet.getUri("yg_conc_qa"));
    const errors: string[] = [];
    const statuses: number[] = [];
    // 4 rounds of 4 parallel attempts, with the counters wiped between
    // rounds so every round starts from brand-new (upserted) keys.
    for (let round = 0; round < 4; round++) {
      await LoginAttemptModel.deleteMany({});
      const results = await Promise.allSettled(
        [
          ADMIN.password,
          "wrong-password-123",
          ADMIN.password,
          "x-wrong-12345",
        ].map((p) => auth.handler(signIn(p))),
      );
      for (const r of results) {
        if (r.status === "fulfilled") statuses.push(r.value.status);
        else {
          const e = r.reason as Error & { code?: unknown; cause?: unknown };
          errors.push(
            `${e.name} code=${String(e.code)} msg=${e.message} cause=${String(
              (e.cause as Error | undefined)?.message ?? e.cause,
            )}\n${e.stack ?? ""}`,
          );
        }
      }
    }
    // Each round: 2 right passwords (200) and 2 wrong (401).
    expect(statuses.filter((s) => s === 200)).toHaveLength(8);
    expect(statuses.filter((s) => s === 401)).toHaveLength(8);
    expect(errors, errors.join("\n---\n")).toEqual([]);
  }, 120_000);
});

describe("a client that disconnects mid-body (the e2e log line)", () => {
  // Before the task-12 QA fix this was a 500 plus an error log line; a
  // client abort is now a quiet 499.
  it("is answered 499 with no error log line", async () => {
    stubEnv(replSet.getUri("yg_conc_qa"));
    const { handleAuthRequest } = await import("./auth-handler");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    // What Node's http server does when the socket closes before the body
    // is read: the body stream errors with `Error: aborted` (ECONNRESET).
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"email":"qa-'));
        controller.error(
          Object.assign(new Error("aborted"), { code: "ECONNRESET" }),
        );
      },
    });
    const response = await handleAuthRequest(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(499);
    expect(logged).not.toHaveBeenCalled();
  });
});
