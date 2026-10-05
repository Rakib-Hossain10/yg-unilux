#!/usr/bin/env node
// Blocking `npm audit` for the whole dependency tree (dev included): fails on
// any high or critical advisory except the ones listed in ALLOWED below, and
// fails once an allowance passes its review date, so it can't be forgotten.
//
// CLI: `npm run audit`. The pure decision lives in evaluateAudit() so it can be
// tested without running npm.

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Advisories we knowingly accept. Each needs a reason and a review date
 * (YYYY-MM-DD); after that date the audit fails until someone re-checks.
 */
export const ALLOWED = [
  {
    id: "GHSA-vfj7-8cjw-p6xm",
    reviewBy: "2027-01-05",
    reason:
      "braces stack exhaustion, dev-only: reached through eslint-config-next " +
      "(micromatch, fast-glob). No patched release; the only offered fix is " +
      "downgrading eslint-config-next to 14.x. Never ships (the production " +
      "audit stays clean). Re-check whether a patched braces/micromatch exists.",
  },
];

const BLOCKING = new Set(["high", "critical"]);

/** "GHSA-xxxx-xxxx-xxxx" from an advisory URL, or null. */
function ghsaOf(url) {
  return (
    /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(url ?? "")?.[0] ?? null
  );
}

/**
 * @param {{ vulnerabilities?: Record<string, { via?: unknown[] }> }} report
 *   `npm audit --json` output
 * @param {{ allowed?: typeof ALLOWED, today?: string }} [options]
 * @returns {{ ok: boolean, failures: string[], notes: string[] }}
 */
export function evaluateAudit(report, options = {}) {
  const allowed = options.allowed ?? ALLOWED;
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const failures = [];
  const notes = [];

  // Every advisory is an object in some `via`; string entries only point at
  // another vulnerable package, so they add nothing new.
  const found = new Map();
  for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      if (!BLOCKING.has(via.severity)) continue;
      const id = ghsaOf(via.url) ?? `advisory-${via.source}`;
      const entry = found.get(id) ?? { title: via.title, packages: new Set() };
      entry.packages.add(name);
      found.set(id, entry);
    }
  }

  const allowance = new Map(allowed.map((a) => [a.id, a]));
  for (const [id, entry] of found) {
    const rule = allowance.get(id);
    const where = [...entry.packages].join(", ");
    if (!rule) {
      failures.push(`${id} (${entry.title}) in ${where}: not allowed`);
    } else if (rule.reviewBy < today) {
      failures.push(`${id}: allowance expired on ${rule.reviewBy}; review it`);
    } else {
      notes.push(`${id} allowed until ${rule.reviewBy} (${where})`);
    }
  }
  for (const rule of allowed) {
    if (!found.has(rule.id)) {
      notes.push(`${rule.id} no longer appears: remove it from ALLOWED`);
    }
  }
  return { ok: failures.length === 0, failures, notes };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  // npm exits non-zero whenever it finds anything, so the exit code is
  // ignored; only unparseable output is an error.
  const run = spawnSync("npm audit --json", {
    encoding: "utf8",
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    console.error("npm audit gave no JSON (registry unreachable?):");
    console.error(run.stderr || run.stdout);
    process.exit(1);
  }
  if (report.error) {
    console.error(`npm audit failed: ${report.error.summary ?? "unknown"}`);
    process.exit(1);
  }
  const { ok, failures, notes } = evaluateAudit(report);
  for (const note of notes) console.log(`note: ${note}`);
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  console.log(ok ? "audit: ok" : "audit: FAILED");
  process.exit(ok ? 0 : 1);
}
