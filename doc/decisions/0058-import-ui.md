# 0058 — Import UI: three steps, thin actions, batches sent by the browser
- Status: Accepted
- Date: 2026-10-07
- Code: Phase 3 T9 (`src/app/admin/import/{page,loading,actions}.ts(x)`, `src/components/admin/import/*`, `admin-sections.ts`, `test/admin-guards.test.ts`)

## Context
T6–T8 built the import services: presigned staging in R2 (ADR 0060), a preview that writes nothing (ADR 0057) and a batched commit with per-entry hashes (ADR 0061). The admin needs one screen that drives them for a file of up to 5,000 products without a developer, and that never leaks restricted values or warning text beyond the admin's own screen.

## Decision
1. **One page, three client steps** (`/admin/import`, nav entry "Import" after Products): 1 Upload (template link, file, default category), 2 Check (counts, file-level findings, product table, warnings), 3 Save (batch progress, then results). The step state lives in the browser (`ImportWizard`); a reload starts over (the staged file is swept after 24 h). Focus moves to the step heading on each change; leaving the page while batches are being sent asks first (`beforeunload`).
2. **Thin actions** (`actions.ts`): `requireAdmin()` → service → `revalidateCatalogInAction(result.tags)` on both branches → a shaped answer. `presignImportUploadAction` parses `presignImportInputSchema` itself and calls `presignImportUpload` (no service wrapper exists; the PUT is always signed as the .xlsx type with the exact size, whatever the browser reported). `previewImportAction`, `commitImportBatchAction(viewer.user.id, …)` and `finishImportAction` call the `@/lib/import` services. The static guard test now counts the `@/lib/import` module and a `presign…` function of `@/lib/storage` as services; any other storage call still fails it.
3. **Shaped preview.** `toPreviewView` keeps per entry only what the screen shows (status, sheet, rows, NO., family, name, saved id, slug, model nos., counts, removals, `changes` + `moreChanges`, warnings, hash). Merged spec values and picture refs never reach the browser; restricted values appear only inside the admin's diff, marked "Restricted" from the current column visibility.
4. **Same Zod schemas on both sides.** The step 1 form (React Hook Form) validates with `presignImportInputSchema` and `defaultCategoryIdSchema` from `src/lib/schemas/import.ts` (pure Zod); the actions/services re-parse the raw input.
5. **The browser runs the batch loop.** It sends `{key, defaultCategoryId, etag, planHash, entryHashes (all, in plan order), batch, acknowledgeRemovals}` one batch at a time, and skips batches whose products are all unchanged or blocked (each batch re-parses the whole workbook on the server). It stops at the first failed batch. The commit action adds `next` to a failure: `retry` (same batch again, safe), `preview` (`PREVIEW_AGAIN`, `FILE_CHANGED`, hash/batch errors → re-preview the staged file), `upload` (default category gone → start over), `confirm` (removals not acknowledged → back to the preview). After the last batch `finishImport` deletes the staged file; "Start over" deletes it too (best effort).
6. **Removals need a checkbox** in step 2 when the plan removes variants; without it "Save" is refused on the client and the service refuses the batch.
7. **Labels.** Every `WarningCode` has a plain-English title (a `Record<WarningCode, …>` so a new code fails the build) and, where the admin can act, a hint; template-related codes link to `/api/admin/import/template`. The server's `detail` is shown as is, only on this screen: nothing logs, audits or stores warning text.
8. **Long tables** (products, warnings, results) page 50 rows on the client with search/status, severity and kind filters; the plan is already in the browser.
9. **`maxDuration = 300`** on the page (route-segment config; Server Actions run under the page's value). A batch is 20 products, a full re-parse of up to 30 MB and 4 parallel picture uploads.

## Consequences
- The commit request carries up to 5,000 entry hashes (~335 KB), under the 1 MB Server Action body limit; no `bodySizeLimit` change.
- `commitNext` matches the service's exported messages and field names; a machine-readable error code on `ServiceResult` would be sturdier (requested from backend).
- The shadcn CLI's `progress` component imported an unrelated npm package named `cn`; it was removed and the component uses `@/lib/utils`. Review CLI output for new dependencies.
- New products are drafts; the results link each product's edit page by id, not the public page.
