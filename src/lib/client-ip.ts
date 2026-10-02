// Finds the network a request came from, for the sign-in rate limit only
// (ADR 0022). Reads ONLY Vercel's trusted x-vercel-forwarded-for header and
// never runs on whistleblower routes (CLAUDE.md rule 7; enforced by ESLint).

import "server-only";

import { isIP } from "node:net";

/*
 * Vercel sets this header itself and a proxy in front of Vercel cannot
 * overwrite it (Vercel docs, checked 2026-10-02). x-forwarded-for, x-real-ip
 * and the like are deliberately never read: off Vercel they are client input.
 */
const TRUSTED_HEADER = "x-vercel-forwarded-for";

/* Longest textual IPv6 (with an IPv4 tail) is 45 characters; leave headroom. */
const MAX_ADDRESS_LENGTH = 64;

/**
 * A normalised client network: an IPv4 address ("203.0.113.7") or an IPv6
 * /64 prefix ("2001:db8:1:2::/64"). Branded so only clientNetwork() makes one.
 * It is still personal data: hash it before storing (src/lib/sign-in-limit.ts).
 */
export type ClientNetwork = string & { readonly __brand: "ClientNetwork" };

/** The part of Headers we need; Next.js `headers()` (ReadonlyHeaders) fits. */
export type HeaderSource = Pick<Headers, "get">;

/* Expands a valid IPv6 address (already checked by isIP) into 8 numbers. */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  // An embedded IPv4 tail ("::ffff:1.2.3.4") becomes two hex groups.
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const zeros =
    rest === undefined ? [] : Array(8 - left.length - right.length).fill("0");
  return [...left, ...zeros, ...right].map((group) => parseInt(group, 16));
}

/*
 * IPv6 is grouped by its /64 prefix: one home or phone usually gets a whole
 * /64 and can rotate through its addresses at will (privacy extensions), so
 * per-address counters would let one host dodge the hard limit. People who
 * share a /64 share a counter, just as people behind one IPv4 NAT do.
 * IPv4-mapped addresses (::ffff:a.b.c.d) are the IPv4 host itself.
 */
function normaliseIpv6(address: string): string {
  const groups = ipv6Groups(address);
  const isV4Mapped =
    groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isV4Mapped) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/**
 * The client's network from Vercel's trusted header, or null when the header
 * is missing or not a valid IP (local dev, tests, a non-Vercel request).
 * Uses the first entry of a comma-separated list (the client), trimmed.
 * Rejects IPv6 zone ids ("%eth0"), ports, brackets and leading-zero IPv4.
 */
export function clientNetwork(headers: HeaderSource): ClientNetwork | null {
  const raw = headers.get(TRUSTED_HEADER);
  if (raw === null) return null;
  const first = raw.split(",")[0]?.trim() ?? "";
  if (first.length === 0 || first.length > MAX_ADDRESS_LENGTH) return null;

  switch (isIP(first)) {
    case 4:
      return first as ClientNetwork;
    case 6:
      // A zone id only makes sense on a local link, never from the internet.
      if (first.includes("%")) return null;
      return normaliseIpv6(first) as ClientNetwork;
    default:
      return null;
  }
}
