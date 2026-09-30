# 0015 — Free security tooling (no paid GitHub features)
- Status: Accepted (GitHub feature availability to be confirmed by the user in repo settings)
- Date: 2026-09-30

## Context
The repo is private and on a free personal GitHub account. The user does not want paid tooling. On private repos:
- Code scanning (CodeQL) requires the paid GitHub Code Security add-on.
- Secret scanning with push protection requires the paid Secret Protection add-on.

Dependabot alerts and version updates are free. This is our understanding as of 2026-09-30; the user will check Settings → Code security and report what is actually available.

## Decision
- **Dependabot** (`.github/dependabot.yml`):
  - npm updates weekly on Monday, with minor and patch updates grouped into one PR.
  - Major versions of `next`, `react`, `react-dom`, `@types/react`, `@types/react-dom` and `eslint-config-next` are ignored, so those upgrades stay manual and planned.
  - GitHub Actions updates weekly, grouped.
  - The user turns on Dependabot alerts in the repo settings.
- **`npm audit --audit-level=high`** in CI fails only on high or critical advisories. It is never silenced: an unfixable finding is documented with its advisory ID and a follow-up task.
- **Gitleaks** replaces GitHub secret scanning. It runs:
  - in CI: a full history scan with a pinned v8.30.1 binary that is checksum-verified. It deliberately does not use `gitleaks-action`, which needs a paid licence once the repo moves to an organisation account such as the client's.
  - as a pre-commit hook (husky): a staged scan before lint-staged. The hook fails with install instructions if gitleaks is missing; it never skips silently.
  - with config in `.gitleaks.toml` (default rules and **no path allowlists at all**, not even `.env.example`, whose values are empty and so produce no findings). Known false positives are ignored one by one in `.gitleaksignore` by fingerprint, never by path. A test (`test/repo-security.test.ts`) enforces both points, and that every value in `.env.example` is empty.
    - The first draft allowlisted `.env.example`. The Phase 0 QA review showed that a real `.env.local` copied over it would be committed unscanned, so the allowlist was removed.
- **CodeQL: skipped.** It isn't free on private repos.
- **Revisit** if the repo becomes public or GitHub Code Security becomes available at no cost. CodeQL would then be added as a separate workflow.

## Consequences
- The pre-commit hook needs gitleaks installed on every developer machine (`winget install Gitleaks.Gitleaks` or `brew install gitleaks`).
- The first scan found one false positive: the `mockToken` example in the vendored Playwright skill docs. It is ignored by fingerprint.
- Static analysis beyond ESLint comes from `code-reviewer` (per file) and `qa-security-reviewer` (per phase), not from CodeQL.
- **Known ways around the pre-commit hook** (accepted; the CI full-history gitleaks scan is the backstop for every one):
  - `git commit --no-verify`
  - `HUSKY=0`
  - pointing `GITLEAKS_BIN` at another binary
  - installing with `--ignore-scripts`, so `prepare` never installs the hooks
- **CI config comes from the PR itself**, so a PR could change `.gitleaks.toml` or `.gitleaksignore` to hide its own secret.
  - Free private repos can't enforce CODEOWNERS or branch protection, so the rule is procedural: any change to those two files needs a line in the PR description explaining it, and gets reviewed by hand.
  - `test/repo-security.test.ts` fails if a path allowlist or a non-fingerprint ignore appears.
