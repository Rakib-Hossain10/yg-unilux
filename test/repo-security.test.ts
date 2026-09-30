import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

// Repository-level security invariants (CLAUDE.md rules 1, 10, 11; ADR 0011,
// 0015). Added by the Phase 0 QA review so tooling regressions fail CI.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) =>
  readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });

const ENV_KEYS = [
  "MONGODB_URI",
  "AUTH_SECRET",
  "AUTH_URL",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "COMPANY_EMAIL",
  "GEO_BLOCK_ENABLED",
  "WHISTLEBLOWER_ENC_KEY",
  "CRON_SECRET",
  "SITE_URL",
];

describe(".env.example", () => {
  const lines = read(".env.example")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  it("lists exactly the ADR 0011 keys, each once", () => {
    const keys = lines.map((l) => l.split("=")[0]);
    expect([...keys].sort()).toEqual([...ENV_KEYS].sort());
  });

  it("has an empty value for every key", () => {
    for (const line of lines) expect(line).toMatch(/^[A-Z0-9_]+=$/);
  });

  it("has no NEXT_PUBLIC_ key", () => {
    expect(read(".env.example")).not.toMatch(/^\s*NEXT_PUBLIC_/m);
  });
});

describe("git tracking", () => {
  const tracked = git("ls-files", "-z").split("\0").filter(Boolean);

  it("tracks no env file other than .env.example", () => {
    const envFiles = tracked.filter((f) => /(^|\/)\.env/.test(f));
    expect(envFiles).toEqual([".env.example"]);
  });

  it("tracks no key material or spreadsheet in public/", () => {
    expect(tracked.filter((f) => /\.(pem|key|p12|pfx)$/i.test(f))).toEqual([]);
    expect(
      tracked.filter((f) => /^public\/.*\.(xlsx|xls|xlsm|csv)$/i.test(f)),
    ).toEqual([]);
  });

  it.each([
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
    ".env.development.local",
    "sub/.env.local",
    ".claude/reviews/some-review.md",
    ".next/cache/x",
  ])("ignores %s", (file) => {
    // check-ignore exits 0 when the path is ignored.
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", "--no-index", file], {
        cwd: root,
      }),
    ).not.toThrow();
  });

  it("does not ignore .env.example", () => {
    expect(() =>
      execFileSync(
        "git",
        ["check-ignore", "-q", "--no-index", ".env.example"],
        {
          cwd: root,
        },
      ),
    ).toThrow();
  });
});

describe("CI workflow", () => {
  const ci = read(".github/workflows/ci.yml");

  it("pins every action to a full commit SHA", () => {
    const uses = [...ci.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses)
      expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it("never uses pull_request_target or workflow_run", () => {
    expect(ci).not.toMatch(/pull_request_target|workflow_run/);
  });

  it("is read-only by default and never grants write", () => {
    expect(ci).toMatch(/^permissions:\n\s+contents: read\s*$/m);
    expect(ci).not.toMatch(/:\s*write\b/);
    expect(ci).not.toMatch(/write-all/);
  });

  it("uses no repository secrets (the build must work without them)", () => {
    expect(ci).not.toMatch(/\$\{\{\s*secrets\./);
  });

  it("checks out without persisting credentials", () => {
    const checkouts = ci.match(/uses: actions\/checkout@/g) ?? [];
    const noPersist = ci.match(/persist-credentials: false/g) ?? [];
    expect(noPersist.length).toBe(checkouts.length);
  });

  it("installs with scripts blocked and runs the high-severity audit", () => {
    expect(ci).not.toMatch(/run: npm (ci|install)(?! --ignore-scripts)/);
    expect(ci).toMatch(/npm audit --audit-level=high/);
  });

  it("verifies the pinned gitleaks archive checksum, fail-closed", () => {
    expect(ci).toMatch(/GITLEAKS_VERSION: 8\.30\.1/);
    expect(ci).toMatch(/GITLEAKS_SHA256: [0-9a-f]{64}\b/);
    expect(ci).toMatch(/set -euo pipefail/);
    expect(ci).toMatch(/sha256sum --check --strict/);
    expect(ci).not.toMatch(/gitleaks-action/);
    expect(ci).toMatch(/gitleaks git --redact/);
  });
});

describe("gitleaks config", () => {
  it("has no path allowlist (ADR 0015: ignore by fingerprint only)", () => {
    // A path allowlist hides every future secret in that file; .env.example is
    // exactly where a real value is most likely to be pasted by mistake.
    expect(read(".gitleaks.toml")).not.toMatch(/^\s*paths\s*=/m);
  });

  it("ignores findings only by exact fingerprint", () => {
    const entries = read(".gitleaksignore")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    for (const entry of entries) {
      // [commit:]file:rule:line, no globs.
      expect(entry).toMatch(/^([0-9a-f]{40}:)?[^*?:]+:[a-z0-9-]+:\d+$/);
    }
  });

  it("pre-commit hook fails closed when gitleaks is missing or finds a leak", () => {
    const hook = read(".husky/pre-commit");
    expect(hook).toMatch(/find-gitleaks\.mjs\)"\s*\|\|\s*exit 1/);
    expect(hook).toMatch(/"\$GITLEAKS" git --staged/);
    expect(hook.indexOf("gitleaks")).toBeLessThan(hook.indexOf("lint-staged"));
  });
});

describe("next.config", () => {
  it("does not inline values into the client bundle via `env`", () => {
    // next.config `env` inlines values into client JS whatever their name.
    expect(nextConfig).not.toHaveProperty("env");
  });
});

describe("source", () => {
  it("never mentions NEXT_PUBLIC_ in application code", () => {
    const files = git("ls-files", "-z", "--", "src")
      .split("\0")
      .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(f))
      .filter((f) => !f.endsWith(".test.ts"));
    const offenders = files.filter((f) => read(f).includes("NEXT_PUBLIC_"));
    expect(offenders).toEqual([]);
  });
});
