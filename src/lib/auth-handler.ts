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
 * Copies the response so its headers can be changed (redirect responses
 * have immutable headers), then:
 * - Cache-Control: private, no-store on everything: auth answers carry
 *   cookies and account data and must never sit in a shared cache;
 * - Retry-After on Better Auth's own 429, which only sends X-Retry-After
 *   (better-auth dist/api/rate-limiter/index.mjs:64).
 */
function finalise(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  const retry = headers.get("X-Retry-After");
  if (response.status === 429 && !headers.has("Retry-After") && retry) {
    headers.set("Retry-After", retry);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
    return finalise(await getAuth().handler(request));
  } catch (error) {
    if (error instanceof RateLimitUnavailableError) {
      logAuthProblem("rate limiter unavailable", error);
      return failure(503);
    }
    logAuthProblem("request failed", error);
    return failure(500);
  }
}
