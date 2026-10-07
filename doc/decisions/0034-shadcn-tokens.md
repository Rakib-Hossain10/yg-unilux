# 0034 — shadcn adoption and token mapping
- Status: Accepted
- Date: 2026-10-06

## Context
Phase 2 builds the admin panel that one client admin uses to run 500+ products. It must be plain, accessible and fast. CLAUDE.md names shadcn/ui for the admin. The site already has an ink, paper and warm-grey token set (ADR 0028), is light only, and runs under a strict CSP (ADR 0027). The admin has no decorative motion. By default shadcn ships oklch neutrals, a dark theme, and `tw-animate-css` enter/exit animations.

## Decision
- Initialise shadcn (`components.json`) with:
  - the radix-nova style;
  - Tailwind 4, `src/` and the `@/*` aliases;
  - RSC and lucide icons.
- Primitives come from the single `radix-ui` package. Separate `@radix-ui/react-*` packages would break later CLI adds.
- Runtime dependencies are only `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge` and `lucide-react`. There is no `tw-animate-css` and no `shadcn` package. The data-state variants the components need live in `globals.css`.
- Every shadcn variable points at our tokens with `var(--color-*)`:

  | shadcn variable | Token | Value |
  |---|---|---|
  | background, card, popover, primary-foreground | paper | #ffffff |
  | foreground, card/popover-foreground, primary, secondary/accent-foreground, ring | ink | #111110 |
  | secondary, muted, accent | grey-100 | #f3f1ee |
  | muted-foreground | grey-600 | #5e5850 |
  | border | grey-200 | #e6e2dc |
  | input | grey-500 | #7d756c |
  | destructive | danger (new) | #b42318 |
  | radius | — | 0.5rem |

- **Danger:** the one new token is `--color-danger`, added because the greys have no red. It gives 6.6:1 on paper and 5.8:1 on grey-100, and is never used on ink.
- **Form fields:** `--input` is grey-500, because field outlines need 3:1 (WCAG 1.4.11).
- **Focus:** a solid ink border plus a 3px ring/50 (3.5:1). Destructive variants keep the ink ring; a red ring at 20% measured about 1.4:1.
- Light only: no `.dark` block and no `dark:` variants.
- **Motion stripped from generated components:** enter/exit animations, slides, zooms, blur, transform and opacity transitions, `transition-all`, and the press nudge.
  - Colour transitions stay as hover/focus feedback. The global reduced-motion rule makes them instant.
- Wrappers with no state or handlers (label, separator) carry no `"use client"`. Radix marks its own client modules.
- `src/components/site/design-shell.qa.test.ts` enforces this:
  - it checks every admin colour pair against ADR 0028's thresholds;
  - it fails if any `src/components/ui` file has animation or dark-mode classes;
  - it fails if `globals.css` gains a dark theme or tw-animate.

## Consequences
- Admin screens inherit the brand palette. A token change in one place reaches both the site and the admin.
- Every later `npx shadcn add` needs the same strip pass:
  - a header line;
  - no animation;
  - no `dark:`;
  - raw colours replaced by tokens.

  The QA test catches anything missed. Likely additions: `field`, `alert`, `pagination`, `empty`.
- `--color-danger` is the only colour outside the logo palette, and it is limited to errors and destructive actions.
- A base rule gives bare borders `--border` (grey-200). Site code keeps giving borders explicit colours, as it does today.
- The radius scale is derived from `--radius`. The public site uses only `rounded-full`, so it is unaffected.
- `radix-ui` adds about 80 install-time packages. Unused primitives are tree-shaken, and `npm audit` covers them in CI.
