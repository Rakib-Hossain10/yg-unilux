// The HTTP entry point for Better Auth (/api/auth/*): connects the database
// first, answers failures generically, and makes every response private and
// uncacheable. src/app/api/auth/[...all]/route.ts only forwards to it.

import "server-only";

import { connectDb } from "./db";
import { getAuth, logAuthProblem } from "./auth";
import { RateLimitUnavailableError } from "./rate-limit";

const JSON_HEADERS = { "Content-Type": "application/json" };

/* A generic JSON error; never says why beyond "try again later". */
function failure(status: 500 | 503): Response {
  return new Response(
    JSON.stringify({
      message: "Sign-in is temporarily unavailable. Please try again later.",
    }),
    {
      status,
      headers: {
        ...JSON_HEADERS,
        "Cache-Control": "private, no-store",
        ...(status === 503 ? { "Retry-After": "30" } : {}),
      },
    },
  );
}

/*
 * Removes every `token` key from an auth JSON answer, at any depth. Better
 * Auth echoes the session token in /sign-in/email and /change-password (top
 * level), /get-session (`session.token`) and /list-sessions (each entry).
 * The HttpOnly cookie must be the only copy a browser holds, out of reach of
 * page scripts. Server code reads sessions through auth.api, which never
 * passes here. Side effect: /revoke-session (by token) can't be fed from
 * /list-sessions over HTTP; /revoke-other-sessions still works.
 */
function stripTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTokens);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "token")
      .map(([key, inner]) => [key, stripTokens(inner)]),
  );
}

/*
 * Copies the response so its headers can be changed (redirect responses
 * have immutable headers), then:
 * - Cache-Control: private, no-store on everything: auth answers carry
 *   cookies and account data and must never sit in a shared cache;
 * - Retry-After on Better Auth's own 429, which only sends X-Retry-After
 *   (better-auth dist/api/rate-limiter/index.mjs:64);
 * - session tokens removed from JSON bodies (stripTokens).
 */
async function finalise(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  const retry = headers.get("X-Retry-After");
  if (response.status === 429 && !headers.has("Retry-After") && retry) {
    headers.set("Retry-After", retry);
  }
  let body: BodyInit | null = response.body;
  if (headers.get("Content-Type")?.toLowerCase().includes("json")) {
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    // A body that isn't valid JSON passes through as it was; an empty one
    // stays null, because a 204/304 Response refuses any body, even "".
    body =
      json === undefined ? text || null : JSON.stringify(stripTokens(json));
    headers.delete("Content-Length");
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/*
 * True when the browser went away mid-request (tab closed, navigation):
 * either the request's own signal says so, or reading the body failed with
 * Node's `Error: aborted` (code ECONNRESET). An ECONNRESET or AbortError
 * from an outgoing call (MongoDB, Resend) is a server fault and still logs.
 */
function isClientAbort(request: Request, error: unknown): boolean {
  if (request.signal.aborted) return true;
  return (
    error instanceof Error &&
    error.message === "aborted" &&
    (error as { code?: unknown }).code === "ECONNRESET"
  );
}

/**
 * Handles one /api/auth request. Awaits connectDb() before Better Auth sees
 * the request (ADR 0018). A database outage is a 503, anything unexpected a
 * 500; only the error's type is logged (onAPIError.throw sends non-API
 * errors here instead of Better Auth printing them).
 */
export async function handleAuthRequest(request: Request): Promise<Response> {
  try {
    await connectDb();
  } catch (error) {
    logAuthProblem("database unavailable", error);
    return failure(503);
  }
  try {
    return await finalise(await getAuth().handler(request));
  } catch (error) {
    if (isClientAbort(request, error)) {
      // Nobody is listening; 499 ("client closed request") keeps it out of
      // 5xx error counts.
      console.info("[auth] client closed the request");
      return new Response(null, {
        status: 499,
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    if (error instanceof RateLimitUnavailableError) {
      logAuthProblem("rate limiter unavailable", error);
      return failure(503);
    }
    logAuthProblem("request failed", error);
    return failure(500);
  }
}
