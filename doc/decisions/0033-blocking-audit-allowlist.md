# 0033 — Blocking full-tree audit with a dated allowlist
- Status: Accepted
- Date: 2026-10-05
- Implements: Phase 1 wrap-up (task-5 QA L2). Refines ADR 0015.

## Context
CI ran the production audit as blocking, and the full-tree audit (dev tools included) as report-only because of one dev-only advisory: `braces` GHSA-vfj7-8cjw-p6xm, reached through `eslint-config-next` with no patched release. A report-only step is easy to ignore, and the merge to `main` needs a green audit.

## Decision
- `npm run audit` (`scripts/audit.mjs`) runs `npm audit --json` for the whole tree and fails on any high or critical advisory that is not in `ALLOWED`.
- Each `ALLOWED` entry has a reason and a review date. After that date the audit fails, so the exception cannot be forgotten. The first entry, GHSA-vfj7-8cjw-p6xm, is reviewed by **2027-01-05**.
- An allowance that no longer matches anything is reported as a note, so it can be removed.
- CI replaces the report-only step with `npm run audit`. The production audit (`npm audit --omit=dev --audit-level=high`) stays as it was, with no allowlist, so nothing that ships can be excused.
- We still do not use `npm audit fix --force` or an `overrides` entry, because both cross declared version ranges.

## Consequences
- A new high or critical advisory in a dev tool now blocks CI until it is fixed or deliberately added to `ALLOWED` in a reviewed commit.
- An allowance matches by advisory id only, not by package. That is acceptable while the list has one entry.
- On 2027-01-05, or when a patched `braces` ships, re-check and drop the entry.
