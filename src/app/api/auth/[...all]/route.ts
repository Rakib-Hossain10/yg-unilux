// Better Auth's routes (/api/auth/*): sign-in, sign-out, session, password
// reset and the admin plugin's endpoints. All logic is in src/lib/auth-handler.ts;
// this file only fixes the runtime and keeps the route request-time only.

import { toNextJsHandler } from "better-auth/next-js";
import { connection } from "next/server";

import { handleAuthRequest } from "@/lib/auth-handler";

// argon2 is a native module and the MongoDB driver needs Node APIs.
export const runtime = "nodejs";

/*
 * Never prerendered or cached: `connection()` waits for a real request. It
 * is used instead of `export const dynamic = "force-dynamic"`, which is a
 * build error once cacheComponents is turned on in Phase 4 (installed docs:
 * 03-file-conventions/02-route-segment-config/index.md, version history).
 */
async function handle(request: Request): Promise<Response> {
  await connection();
  return handleAuthRequest(request);
}

export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(handle);
