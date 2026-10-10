// Tests for the cron:expiry CLI's argument handling (scripts/cron-expiry.ts)
// and the deployment config that schedules the same job (vercel.json,
// package.json): a dry run unless --send is given, unknown flags refused,
// the Vercel cron at 08:00 UTC on the route that exists.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseCli } from "./cron-expiry";

describe("cron:expiry arguments", () => {
  it("is a dry run by default and with --dry-run", () => {
    expect(parseCli([])).toEqual({ send: false });
    expect(parseCli(["--dry-run"])).toEqual({ send: false });
  });

  it("sends only with --send", () => {
    expect(parseCli(["--send"])).toEqual({ send: true });
  });

  it("refuses both flags, unknown flags and positionals", () => {
    expect(parseCli(["--send", "--dry-run"])).toHaveProperty("error");
    expect(parseCli(["--force"])).toHaveProperty("error");
    expect(parseCli(["send"])).toHaveProperty("error");
  });

  it("prints help", () => {
    expect(parseCli(["--help"])).toEqual({ help: true });
  });
});

describe("cron schedule", () => {
  const root = process.cwd();

  it("vercel.json runs the access-expiry route daily at 08:00 UTC", () => {
    const config = JSON.parse(
      readFileSync(join(root, "vercel.json"), "utf8"),
    ) as { crons?: { path: string; schedule: string }[] };
    expect(config.crons).toContainEqual({
      path: "/api/cron/access-expiry",
      schedule: "0 8 * * *",
    });
    expect(
      existsSync(join(root, "src/app/api/cron/access-expiry/route.ts")),
    ).toBe(true);
  });

  it("package.json has the cron:expiry script", () => {
    const pkg = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["cron:expiry"]).toContain("scripts/cron-expiry.ts");
  });
});
