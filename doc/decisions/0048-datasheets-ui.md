# 0048 — Datasheets admin UI
- Status: Accepted
- Date: 2026-10-07
- Builds on: [0047](0047-datasheet-service.md), [0046](0046-images-editor-ui.md), [0036](0036-admin-guards.md)

## Decision
1. **Upload flow in the browser.** `use-datasheet-upload.ts` runs presign (server action), an XHR PUT of the raw file with exactly the returned headers and progress, then finalize (server action). The `.xlsx` and 10 MB checks in the browser are a courtesy only; the server re-checks size and file signature.
2. **List.** `/admin/datasheets` shows file name, size, uploader, updated and in-use count. Search (`?q=`, file name) and 25-row pages are done in the page over `listDatasheets()`. The storage key and any URL never reach the page or the client.
3. **Row actions.** Rename (RHF + the service's file-name Zod rule), Replace (confirm, then picker; same key, so products keep working) and Delete (confirm; the refusal `formErrors[0]` says how many products use it).
4. **Actions** call `requireAdmin()` first, pass returned tags to `revalidateCatalogInAction` on both branches, and `refresh()` when something was written. No redirects: the page stays put.
5. **Product form.** A "Datasheet" section with a native select saves `datasheetId` with the form. A stored id whose file is gone stays visible as "no longer exists". A failed publish also marks `mainCategory` / `datasheetId` inputs, and `datasheetId` is listed among the publish reasons.
6. **Uploader names.** `listDatasheets` returns only the uploader's id, so the page reads names from the read-only users model (`uploader-names.ts`). Proposed: move this into the service.
