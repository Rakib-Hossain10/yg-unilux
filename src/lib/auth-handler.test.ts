// Tests for src/lib/auth-handler.ts when the database is down or Better Auth
// throws something unexpected: generic, uncacheable answers, and only the
// error's type in the log (never its message).

import { describe, expect, it, vi } from "vitest";

import { handleAuthRequest } from "./auth-handler";
import { DbConnectionError } from "./db";
import { EnvError } from "./env";
import { RateLimitUnavailableError } from "./rate-limit";

const connect = vi.hoisted(() => vi.fn());
const handler = vi.hoisted(() => vi.fn());

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  connectDb: connect,
}));
vi.mock("./auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth")>()),
  getAuth: () => ({ handler }),
}));

const request = () =>
  new Request("http://localhost:3000/api/auth/sign-in/email", {
    method: "POST",
  });

describe("handleAuthRequest", () => {
  it("answers 503 with Retry-After when the database can't be reached", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockRejectedValueOnce(new Error("mongodb://user:secret@host"));
    const response = await handleAuthRequest(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(handler).not.toHaveBeenCalled();
    expect(log.mock.calls.join(" ")).not.toContain("secret");
  });

  it("answers 500 for an unexpected error and logs only its type", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockResolvedValueOnce(undefined);
    handler.mockRejectedValueOnce(new TypeError("leaks jane@example.com"));
    const response = await handleAuthRequest(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      message: "Sign-in is temporarily unavailable. Please try again later.",
    });
    expect(log.mock.calls.join(" ")).toContain("TypeError");
    expect(log.mock.calls.join(" ")).not.toContain("jane");
  });

  it("adds Retry-After to Better Auth's own 429 and makes every answer private", async () => {
    connect.mockResolvedValueOnce(undefined);
    handler.mockResolvedValueOnce(
      new Response("{}", { status: 429, headers: { "X-Retry-After": "12" } }),
    );
    const response = await handleAuthRequest(request());
    expect(response.headers.get("retry-after")).toBe("12");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("maps a RateLimitUnavailableError from Better Auth's limiter to a generic 503", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockResolvedValueOnce(undefined);
    handler.mockRejectedValueOnce(
      new RateLimitUnavailableError(
        "consume",
        new DbConnectionError("could not connect", new Error("timeout")),
      ),
    );
    const response = await handleAuthRequest(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      message: "Sign-in is temporarily unavailable. Please try again later.",
    });
  });

  it("maps an EnvError to a generic 500 that names no variable", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockResolvedValueOnce(undefined);
    handler.mockRejectedValueOnce(
      new EnvError("authentication", [
        { kind: "missing", variable: "AUTH_URL" },
      ]),
    );
    const response = await handleAuthRequest(request());
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("AUTH_URL");
    expect(text).toContain("temporarily unavailable");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    // The server log gets EnvError's own safe message (variable names,
    // never values) so the operator can fix the configuration.
    expect(log.mock.calls.join(" ")).toMatch(/AUTH_URL: missing/);
  });

  it("makes a successful answer private and keeps its cookies and status", async () => {
    connect.mockResolvedValueOnce(undefined);
    const ok = new Response("{}", {
      status: 200,
      headers: { "Cache-Control": "public, max-age=60" },
    });
    ok.headers.append("set-cookie", "a=1; Path=/");
    ok.headers.append("set-cookie", "b=2; Path=/");
    handler.mockResolvedValueOnce(ok);
    const response = await handleAuthRequest(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.getSetCookie()).toEqual([
      "a=1; Path=/",
      "b=2; Path=/",
    ]);
  });
});
