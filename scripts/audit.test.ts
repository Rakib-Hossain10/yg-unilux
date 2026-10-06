// Tests for the allowlisting audit gate (scripts/audit.mjs).

import { describe, expect, it } from "vitest";

import { ALLOWED, evaluateAudit } from "./audit.mjs";

const advisory = (ghsa: string, severity = "high") => ({
  source: 1,
  title: "Something bad",
  url: `https://github.com/advisories/${ghsa}`,
  severity,
});
const report = (...vias: object[]) => ({
  auditReportVersion: 2,
  vulnerabilities: {
    braces: { via: vias },
    micromatch: { via: ["braces"] },
  },
});
const allowed = [
  { id: "GHSA-aaaa-bbbb-cccc", reviewBy: "2027-01-05", reason: "x" },
];

describe("evaluateAudit", () => {
  it("passes with nothing found, and says an unused allowance can go", () => {
    const result = evaluateAudit(
      { auditReportVersion: 2, vulnerabilities: {} },
      { allowed, today: "2026-10-05" },
    );
    expect(result.ok).toBe(true);
    expect(result.notes.join()).toContain("no longer appears");
  });

  it("accepts an allowed advisory before its review date", () => {
    const result = evaluateAudit(report(advisory("GHSA-aaaa-bbbb-cccc")), {
      allowed,
      today: "2026-10-05",
    });
    expect(result.ok).toBe(true);
  });

  it("fails on any other high or critical advisory", () => {
    for (const severity of ["high", "critical"]) {
      const result = evaluateAudit(
        report(
          advisory("GHSA-aaaa-bbbb-cccc"),
          advisory("GHSA-dddd-eeee-ffff", severity),
        ),
        { allowed, today: "2026-10-05" },
      );
      expect(result.ok).toBe(false);
      expect(result.failures.join()).toContain("GHSA-dddd-eeee-ffff");
    }
  });

  it("ignores moderate and low advisories", () => {
    const result = evaluateAudit(
      report(advisory("GHSA-dddd-eeee-ffff", "moderate")),
      {
        allowed,
        today: "2026-10-05",
      },
    );
    expect(result.ok).toBe(true);
  });

  it("fails once the review date has passed", () => {
    const result = evaluateAudit(report(advisory("GHSA-aaaa-bbbb-cccc")), {
      allowed,
      today: "2027-01-06",
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join()).toContain("expired");
  });

  it("still passes on the review date itself", () => {
    const result = evaluateAudit(report(advisory("GHSA-aaaa-bbbb-cccc")), {
      allowed,
      today: "2027-01-05",
    });
    expect(result.ok).toBe(true);
  });

  it("names an advisory without a GHSA url by its source number", () => {
    const result = evaluateAudit(
      report({ source: 4242, title: "No url", severity: "high" }),
      { allowed, today: "2026-10-05" },
    );
    expect(result.ok).toBe(false);
    expect(result.failures.join()).toContain("advisory-4242");
  });
});

describe("evaluateAudit on reports it does not understand", () => {
  const options = { allowed, today: "2026-10-05" };

  it("fails on an empty object, a missing version or an error report", () => {
    for (const bad of [{}, { vulnerabilities: {} }, { error: { code: "E" } }]) {
      expect(evaluateAudit(bad, options).ok).toBe(false);
    }
  });

  it("fails when npm counts high findings that we could not parse", () => {
    const result = evaluateAudit(
      {
        auditReportVersion: 2,
        vulnerabilities: { x: { via: ["y"] } },
        metadata: { vulnerabilities: { high: 1, critical: 0 } },
      },
      options,
    );
    expect(result.ok).toBe(false);
  });
});

describe("ALLOWED", () => {
  // The expiry check compares strings, which is only right for ISO dates.
  it("has a real YYYY-MM-DD review date and a reason on every entry", () => {
    for (const entry of ALLOWED) {
      expect(entry.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(entry.reviewBy))).toBe(false);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});
