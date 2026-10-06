// Tests for src/lib/client-ip.ts: the client network is read only from
// Vercel's x-vercel-forwarded-for header, validated, and normalised (IPv4 as
// is, IPv6 grouped by /64); anything else gives null.

import { describe, expect, it } from "vitest";

import { clientNetwork } from "./client-ip";

const h = (init: Record<string, string>) => new Headers(init);
const vercel = (value: string) => h({ "x-vercel-forwarded-for": value });

describe("clientNetwork", () => {
  it("returns a plain IPv4 address unchanged", () => {
    expect(clientNetwork(vercel("203.0.113.7"))).toBe("203.0.113.7");
  });

  it("takes the first entry of a comma-separated list and trims it", () => {
    expect(clientNetwork(vercel("  203.0.113.7 , 10.0.0.1, 10.0.0.2"))).toBe(
      "203.0.113.7",
    );
  });

  it("groups IPv6 addresses by their /64 prefix", () => {
    expect(clientNetwork(vercel("2001:db8:1:2:aaaa:bbbb:cccc:dddd"))).toBe(
      "2001:db8:1:2::/64",
    );
    // Another address in the same /64 (e.g. a privacy-extension rotation).
    expect(clientNetwork(vercel("2001:0DB8:0001:0002::1"))).toBe(
      "2001:db8:1:2::/64",
    );
    // A different /64 is a different network.
    expect(clientNetwork(vercel("2001:db8:1:3::1"))).toBe("2001:db8:1:3::/64");
  });

  it("expands '::' and embedded IPv4 tails before taking the prefix", () => {
    expect(clientNetwork(vercel("2001:db8::1"))).toBe("2001:db8:0:0::/64");
    expect(clientNetwork(vercel("::"))).toBe("0:0:0:0::/64");
    expect(clientNetwork(vercel("2001:db8:1:2::1.2.3.4"))).toBe(
      "2001:db8:1:2::/64",
    );
  });

  it("maps IPv4-mapped IPv6 to the plain IPv4 address", () => {
    expect(clientNetwork(vercel("::ffff:203.0.113.7"))).toBe("203.0.113.7");
    expect(clientNetwork(vercel("::FFFF:cb00:7107"))).toBe("203.0.113.7");
  });

  it.each([
    ["garbage", "not-an-ip"],
    ["an empty value", ""],
    ["only commas", " , ,"],
    ["IPv4 with leading zeros", "01.2.3.4"],
    ["IPv4 with a port", "203.0.113.7:443"],
    ["bracketed IPv6", "[2001:db8::1]"],
    ["an IPv6 zone id", "fe80::1%eth0"],
    ["a huge value", `1${"1".repeat(500)}`],
  ])("returns null for %s", (_label, value) => {
    expect(clientNetwork(vercel(value))).toBeNull();
  });

  it("returns null when the header is missing (local dev, tests)", () => {
    expect(clientNetwork(h({}))).toBeNull();
  });

  it("ignores every spoofable header, even when Vercel's is missing", () => {
    const spoofed = h({
      "x-forwarded-for": "198.51.100.1",
      "x-real-ip": "198.51.100.2",
      "cf-connecting-ip": "198.51.100.3",
      forwarded: "for=198.51.100.4",
    });
    expect(clientNetwork(spoofed)).toBeNull();

    spoofed.set("x-vercel-forwarded-for", "203.0.113.7");
    expect(clientNetwork(spoofed)).toBe("203.0.113.7");
  });

  it("accepts any object with get(), such as Next.js ReadonlyHeaders", () => {
    const readonly = {
      get: (name: string) =>
        name === "x-vercel-forwarded-for" ? "203.0.113.7" : null,
    };
    expect(clientNetwork(readonly)).toBe("203.0.113.7");
  });
});
