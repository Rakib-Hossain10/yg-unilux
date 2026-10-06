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

describe("handleAuthRequest — session tokens and client aborts (task 12 QA)", () => {
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  const at = (path: string) =>
    new Request(`http://localhost:3000/api/auth${path}`);

  it("drops token from a sign-in body but keeps user and cookies", async () => {
    connect.mockResolvedValueOnce(undefined);
    const ok = json({ redirect: false, token: "secret", user: { id: "u1" } });
    ok.headers.append("set-cookie", "yg.session_token=secret; HttpOnly");
    handler.mockResolvedValueOnce(ok);
    const response = await handleAuthRequest(request());
    expect(await response.json()).toEqual({
      redirect: false,
      user: { id: "u1" },
    });
    expect(response.headers.getSetCookie()).toHaveLength(1);
  });

  it("drops session.token from get-session and every token from list-sessions", async () => {
    connect.mockResolvedValueOnce(undefined);
    handler.mockResolvedValueOnce(
      json({ session: { id: "s1", token: "t1" }, user: { id: "u1" } }),
    );
    const one = await handleAuthRequest(at("/get-session"));
    expect(await one.json()).toEqual({
      session: { id: "s1" },
      user: { id: "u1" },
    });

    connect.mockResolvedValueOnce(undefined);
    handler.mockResolvedValueOnce(
      json([
        { id: "s1", token: "t1" },
        { id: "s2", token: "t2" },
      ]),
    );
    const list = await handleAuthRequest(at("/list-sessions"));
    expect(await list.json()).toEqual([{ id: "s1" }, { id: "s2" }]);
  });

  it("passes a null session and a non-JSON body through unchanged", async () => {
    connect.mockResolvedValueOnce(undefined);
    handler.mockResolvedValueOnce(json(null));
    expect(await (await handleAuthRequest(at("/get-session"))).json()).toBe(
      null,
    );

    connect.mockResolvedValueOnce(undefined);
    handler.mockResolvedValueOnce(new Response("token=plain"));
    expect(await (await handleAuthRequest(request())).text()).toBe(
      "token=plain",
    );

    connect.mockResolvedValueOnce(undefined);
    handler.mockResolvedValueOnce(
      new Response("{not json", {
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await (await handleAuthRequest(request())).text()).toBe("{not json");

    connect.mockResolvedValueOnce(undefined);
    handler.mockResolvedValueOnce(
      new Response(null, {
        status: 204,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect((await handleAuthRequest(request())).status).toBe(204);
  });

  it("answers a body read cut off by the client with 499 and no error log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    connect.mockResolvedValueOnce(undefined);
    handler.mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { code: "ECONNRESET" }),
    );
    const response = await handleAuthRequest(request());
    expect(response.status).toBe(499);
    expect(log).not.toHaveBeenCalled();
  });

  it("answers 499 when the request's own signal is aborted", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    connect.mockResolvedValueOnce(undefined);
    handler.mockRejectedValueOnce(new Error("anything"));
    const controller = new AbortController();
    controller.abort();
    const response = await handleAuthRequest(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        signal: controller.signal,
      }),
    );
    expect(response.status).toBe(499);
  });

  it("still logs a 500 for an outgoing ECONNRESET or AbortError (e.g. Resend)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const outgoing = [
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      Object.assign(new Error("This operation was aborted"), {
        name: "AbortError",
      }),
    ];
    for (const error of outgoing) {
      connect.mockResolvedValueOnce(undefined);
      handler.mockRejectedValueOnce(error);
      expect((await handleAuthRequest(request())).status).toBe(500);
    }
    expect(log).toHaveBeenCalledTimes(2);
  });
});
