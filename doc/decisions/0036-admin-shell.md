# 0036 — Admin shell, guard placement and admin metadata
- Status: Accepted
- Date: 2026-10-06
- Builds on: ADR 0024, 0029, 0034, 0035

## Context
T3 adds the admin shell: a layout with a sidebar, a dashboard built on `getCounts()`, and `loading.tsx` and `error.tsx` boundaries. Rule 3 needs a real 403 status for customers on every admin URL.

According to the installed `loading.md`, `loading.js` wraps the page and nested layouts in Suspense, but not the layout in its own segment.

The e2e tests also showed that Next resolves static metadata for the page and layout even when the layout's `requireAdmin()` throws `forbidden()`. The dashboard `<title>` appeared in a customer's 403 RSC payload.

## Decision
- **The 403 status comes from the layout guard.**
  - `requireAdmin()` is the first statement of `src/app/admin/layout.tsx`. It runs outside the loading Suspense, so the 403 status is real for every `/admin` URL.
  - Every page also calls `requireAdmin()` first, because a layout doesn't re-run on client navigation. Inside Suspense the page guard alone would give the 403 screen with a 200 status. That is acceptable because the layout already sets the status.
- **Admin metadata is static constants only.**
  - It never contains data.
  - Any `generateMetadata` or `generateViewport` must start with `await requireAdmin()`.
  - Admin segments have no `generateStaticParams` and no `"use client"` on pages or layouts.
  - Admin route or metadata-route files fail the guard test until a check covers them.
- **The static guard test (`test/admin-guards.test.ts`)** enforces the above. Each admin page, layout, template and default file must be an `export default async function` whose first statement is `await requireAdmin()`: no early return, no `try`, no `.catch`. T5 and later tasks add a `describe` block for Server Actions.
- **One module list.** `src/components/admin/admin-sections.ts` feeds both the sidebar nav and the dashboard cards.
- **Navigation.**
  - The nav is a server component.
  - The active link comes from a tiny client component (`usePathname`, `aria-current="page"`).
  - On phones the menu is a native `<details>`. It closes itself after navigation through a ref and an effect (no React state), because the layout stays mounted.
- **Skip link and titles.**
  - The skip link targets `<main id="main">`. The public site uses `#content`.
  - A page in the layout's own segment uses `title.absolute`, because `title.template` only reaches child segments.
- **The error boundary shows a fixed message and the digest only.** It never shows the error text.
- **The dashboard shows counts only.** Whistleblower appears as a number, never any case content. It isn't cached.

## Consequences
- A customer's 403 tab title reads "Dashboard | Admin | YG UniLUX". This is harmless; it could be tidied later with a neutral layout title.
- Nav links to modules that don't exist yet return 404 until their tasks land.
- Known nits, accepted:
  - the mobile menu doesn't close on Escape;
  - it closes on Ctrl/Cmd-click.
- Optional later: a `{status: 1}` index on `whistleblowerCases` if case numbers grow. Today the count is unindexed and the collection is tiny.
