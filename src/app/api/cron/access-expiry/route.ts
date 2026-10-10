// GET /api/cron/access-expiry: the daily access-expiry reminder (plan P5,
// ADR 0072), called by Vercel Cron at 08:00 UTC (vercel.json). Vercel sends
// `Authorization: Bearer <CRON_SECRET>`; anything else gets 401 and the job
// never runs. The answer holds counts only (no addresses, no names) and is
// `Cache-Control: private, no-store`.

import { createHash, timingSafeEqual } from "node:crypto";

import { connection } from "next/server";
import { z } from "zod";

import { env, MAX_CRON_SECRET_LENGTH } from "@/lib/env";
import { runExpiryReminders } from "@/lib/expiry-reminders";

// Mongoose, Better Auth and node:crypto need Node APIs.
export const runtime = "nodejs";
// The run stops starting sends at 240 s (RUN_BUDGET_MS) to finish in time.
export const maxDuration = 300;

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex",
} as const;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

/* Rule 8: the header must look like one Bearer token of printable ASCII. */
const authorizationSchema = z
  .string()
  .max("Bearer ".length + MAX_CRON_SECRET_LENGTH)
  .regex(/^Bearer [\x21-\x7e]+$/);

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/**
 * True when the request carries the cron secret. Both sides are hashed
 * first, so timingSafeEqual always compares 32 bytes and neither the
 * secret's length nor its content leaks through timing. A missing secret
 * (misconfiguration) refuses every request and is logged by type only.
 */
function isAuthorized(request: Request): boolean {
  const header = authorizationSchema.safeParse(
    request.headers.get("authorization"),
  );
  if (!header.success) return false;
  let secret: string;
  try {
    secret = env.cronSecret();
  } catch (error) {
    console.error(
      `[cron] access-expiry secret not configured: ${error instanceof Error ? error.name : typeof error}`,
    );
    return false;
  }
  return timingSafeEqual(sha256(header.data), sha256(`Bearer ${secret}`));
}

export async function GET(request: Request): Promise<Response> {
  // Always at request time, never prerendered or cached.
  await connection();
  if (!isAuthorized(request)) return json(401, { error: "unauthorized" });

  try {
    const summary = await runExpiryReminders();
    if (summary.status === "busy") return json(409, { status: "busy" });
    // "aborted": part done, then the database failed. 503 so monitoring
    // sees it; the counts say what was done (the rest runs tomorrow).
    return json(summary.status === "aborted" ? 503 : 200, {
      status: summary.status,
      due: summary.due,
      sent: summary.sent,
      failed: summary.failed,
      markFailed: summary.markFailed,
      truncated: summary.truncated,
      digest: summary.digest,
    });
  } catch (error) {
    // Type only: driver messages can quote documents.
    console.error(
      `[cron] access-expiry run failed: ${error instanceof Error ? error.name : typeof error}`,
    );
    return json(503, { error: "unavailable" });
  }
}
