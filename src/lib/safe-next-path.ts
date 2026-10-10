// Where to send a user after sign-in (`/login?next=…`, plan Q7). Only a path
// on this site is accepted, so the parameter can never become an open
// redirect to another origin. Pure: no request, no env, no imports.

/** Longer `next` values are refused (no real page path comes close). */
export const MAX_NEXT_PATH_LENGTH = 512;

/* How many layers of percent-encoding are unwrapped and checked. */
const MAX_DECODE_ROUNDS = 4;

/* The fixed, never-contacted base used to resolve a candidate path. */
const PROBE_ORIGIN = "https://next-path.invalid";

/*
 * One decoded form of the candidate is unsafe when a browser or a URL
 * parser could read it as leaving the site:
 * - `//host` and `/\host` are protocol-relative (browsers treat `\` as `/`);
 * - any backslash at all, since some parsers normalise it to `/`;
 * - control characters (C0, DEL) and whitespace, which parsers strip, so
 *   `/\t/evil.com` would become `//evil.com`;
 * - it must start with exactly one `/`, so `javascript:`, `https:` and
 *   relative forms are refused too;
 * - a `.` or `..` path segment: the URL parser removes them, so
 *   `/..//evil.com` or `/.//evil.com` would resolve to the path
 *   `//evil.com`. No real page path has one.
 */
function unsafeForm(value: string): boolean {
  return (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\s\x00-\x1f\x7f]/.test(value) ||
    hasDotSegment(value)
  );
}

/* True when the path part (before `?` or `#`) has a `.` or `..` segment. */
function hasDotSegment(value: string): boolean {
  const path = value.split(/[?#]/, 1)[0] ?? "";
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

/**
 * Returns `raw` when it is a same-origin absolute path ("/product/arc?x=1"),
 * otherwise null. The raw value itself may only use printable ASCII (a real
 * link percent-encodes everything else), and every percent-decoded layer of
 * it must pass the same checks, so `/%2F%2Fevil.com` or `%5C` tricks are
 * refused too. A value that fails to decode is refused. The caller falls
 * back to its default destination on null.
 */
export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_NEXT_PATH_LENGTH) return null;
  if (!/^[\x21-\x7e]+$/.test(raw)) return null;

  let current = raw;
  for (let round = 0; round <= MAX_DECODE_ROUNDS; round += 1) {
    if (unsafeForm(current)) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (decoded === current) break;
    // Still encoded after the last round we check: refuse, don't guess.
    if (round === MAX_DECODE_ROUNDS) return null;
    current = decoded;
  }

  // Belt and braces: the URL parser must keep it on our origin.
  const resolved = URL.parse(raw, PROBE_ORIGIN);
  if (!resolved || resolved.origin !== PROBE_ORIGIN) return null;
  // ...and its resolved path must not be protocol-relative either.
  if (resolved.pathname.startsWith("//")) return null;
  return raw;
}
