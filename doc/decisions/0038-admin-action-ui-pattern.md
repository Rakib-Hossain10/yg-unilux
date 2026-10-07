# 0038 — Admin Server Action and form UI pattern
- Status: Accepted
- Date: 2026-10-06

## Context
T5 (categories UI) is the first admin module with Server Actions called from client forms. Later modules (areas, products, datasheets, customers, settings) should reuse its pattern.

## Decision
1. **Client-called actions** run inside `startTransition` through a shared `callAction()` (`src/components/admin/action-result.ts`). It calls `unstable_rethrow(error)` so redirects and 403s reach Next; any other throw becomes an inline error with `saved: "unknown"`. Reason: a client-called action that redirects rejects its promise with Next's redirect error.
2. **`ActionResult`** = `{ok:true} | {ok:false, errors, saved: false | true | "unknown"}`. `true` = the write happened but the audit failed; `"unknown"` = the action threw. A form shows Submit only when `saved === false`, otherwise "Back to…", so a retry cannot duplicate. A ref guard stops double Enter.
3. **Writes that stay on the page** (move/reorder) return a result and call `refresh()`, because admin reads are uncached. Create, edit and delete redirect to the list with a fixed-key `?notice=` (only allow-listed keys are read back).
4. **Edge buttons** use `aria-disabled`, not `disabled`, so focus survives a move; a polite live region announces moves.
5. **`actions.ts` rules**, enforced by `test/admin-guards.test.ts`: Server Actions live only in `src/app/admin/**/actions.ts` (no inline `"use server"`), start with `await requireAdmin();`, have no `try`/`.catch`, no default parameters and no generics.
6. **shadcn adds** (`alert`, `field`, `empty`) were written from `npx shadcn add --view` output because the CLI wanted to overwrite already-stripped `label` and `separator`. The ADR 0034 strip pass is applied.

## Consequences
- T6b, T9, T10 and later reuse `callAction`/`ActionResult`.
- No e2e for the category pages yet; add a Playwright flow in T18 or QA gate A.
- T15 can add a static "every action audits and revalidates" check next to the action guard block.
- Optional: `childCount` on `CategoryForEdit` would save a query on the edit page.
