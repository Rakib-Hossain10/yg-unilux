// GET /api/catalog/search?q=: the search overlay's type-ahead answers (ADR
// 0006, 0066). Public catalog data only (cards without specs, category
// names); no session read, no IP stored, the query text is never logged.

import { connection } from "next/server";
import { z } from "zod";

import { MAX_SEARCH_LENGTH, searchCatalog } from "@/lib/catalog/search";

// Mongoose needs Node APIs.
export const runtime = "nodejs";

/** Longest raw `q` looked at; anything longer is a malformed request. */
const MAX_RAW_QUERY_LENGTH = 256;

/* Answers are per browser for a short while, never stored by a CDN. */
const SHORT_PRIVATE = { "Cache-Control": "private, max-age=30" } as const;
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/* Trimmed, at most MAX_SEARCH_LENGTH characters (code points). */
const querySchema = z
  .string()
  .max(MAX_RAW_QUERY_LENGTH)
  .trim()
  .refine((text) => [...text].length <= MAX_SEARCH_LENGTH);

const badRequest = () =>
  Response.json(
    { message: "Invalid search query." },
    { status: 400, headers: NO_STORE },
  );

export async function GET(request: Request): Promise<Response> {
  await connection();
  const values = new URL(request.url).searchParams.getAll("q");
  if (values.length > 1) return badRequest();
  const parsed = querySchema.safeParse(values[0] ?? "");
  if (!parsed.success) return badRequest();

  try {
    // searchCatalog answers an empty result for < 2 characters.
    const result = await searchCatalog(parsed.data);
    return Response.json(result, { headers: SHORT_PRIVATE });
  } catch (error) {
    // Never the query or the driver message (it can quote the query).
    console.error(
      `Catalog search failed: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    return Response.json(
      { message: "Search is unavailable. Please try again." },
      { status: 500, headers: NO_STORE },
    );
  }
}
