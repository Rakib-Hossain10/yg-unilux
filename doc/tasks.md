# Tasks

Working tracker for the YG UniLUX build. Update it at the end of every session: tick finished items, add new ones, and move "Current focus".
Decisions live in [decisions/](decisions/README.md). A task that settles a design question gets an ADR there.

## ▶ Resume here (next session)
- **Phase 4a: plan APPROVED (2026-10-08), `doc/phase-4-plan.md` (P0–P9; QA gate A after P3, B after P7, C at exit; ADRs 0062–0064). Branch `phase-4` from `main` (Phase 3 merged, PR #12).** P0 and P1 done. **P1 verdict: `cacheComponents` stays OFF (ADR 0062)**: with it on, a customer opening `/admin` gets 200 instead of the real 403 (the fix would need a DB-backed role check in `proxy.ts`: a separate decision). Catalog reads use `unstable_cache` + tags, product pages are ISR, and the restricted block is a client component fetching `/api/catalog/restricted/[productId]` (`private, no-store`).
  - **Branch note:** the CSP fix (`e788deb`: sign-in/out are full page loads, ADR 0027/0045 notes) was cherry-picked onto `phase-4`; it was never pushed from `phase-3`.
  - **User answers recorded in the plan:** 4a/4b split; agent edits done; new read-only `ui-reviewer` runs at gate C alongside `qa-security-reviewer` ("premium and distinctive?" vs "works correctly?"); Q3 `?model=` accepted, SEO cost is small and is closed by a server-rendered Models table listing every variant + JSON-LD `hasVariant`; lumen/efficacy shown twice; real photos (2, added by the user to a dev DB product) are used for the gallery task and the ui-reviewer.
  - **Applied from ADR 0054:** pink columns in the right quick-spec panel, green in the table; `placement` added to `SPEC_COLUMNS` in P2 with a pink-keys test.
  - **Subagents:** `site-frontend` (page), `motion-engineer` (enhancement pass), `backend-architect` (data layer), `qa-security-reviewer` (gates), `ui-reviewer` (new, read-only, gate C polish pass); all Opus. ADR 0013 / CLAUDE.md still list the older roster: add one line when Phase 4 closes.
  - **P2 done:** `placement` ("quick" = the 5 pink keys, "table" = rest) and `group` on `SPEC_COLUMNS`; helpers `specColumnsFor(placement)`, `restrictedSpecKeys(visibility?)`; `spec-groups.ts` now derives from `group` (same groups); tests added in `src/models/spec-columns.test.ts`.
  - **Next:** P3 (catalog data layer in `src/lib/catalog/*`, owner `backend-architect` on Opus; re-read the installed `unstable_cache` docs first; ADR 0063) then QA gate A (`qa-security-reviewer`). A `next dev` on port 3000 against the real DB blocks `npm run test:e2e`; stop it first.
  - **Open decision for later (not Phase 4):** a DB-backed admin role check in `proxy.ts` would allow `cacheComponents` and PPR (ADR 0062 "Revisit when").
  - **Must-do carried into Phase 4:** footer `new Date().getFullYear()` out of the prerender path before `cacheComponents` (QA L1); restricted values never in cached HTML, JSON-LD, metadata, sitemap or strips (rule 9); drafts 404 for everyone; Phase 5 `/change-password` and any public link into `/admin` must be full page loads (ADR 0027 note).
  - Phase 3 status below is unchanged (code complete, PR #12 open).
- **Branch:** `phase-3` (from `main`). **Phase 2 is merged** (PR #11, `b689cb7`, 2026-10-07; QA gates A–E passed, real-credential smoke passed). Phase 1 merged earlier (PR #9).
- **Phase 3 plan APPROVED** (2026-10-07, all six defaults accepted): `doc/phase-3-plan.md` (T0–T11; QA gates A after T5, B after T8, C at exit; ADRs 0055–0058).
  - **T0 done:**
    - the client sheet is at `doc/reference/client-sample-sheet.xlsx`, LOCAL ONLY, gitignored (`/doc/reference/*.xlsx`), never commit it;
    - studied: plan section "Fixture findings";
    - fixture path fixed in `import-engineer.md`;
    - ADR 0054 written (product page layout).
  - **T1 done** (`bfbfa6f`, ADR 0055):
    - case-insensitive unique `variants.modelNo` index (collation en/2); shared `modelNoKey` / `MODEL_NO_COLLATION` in `src/models/product-constants.ts`;
    - `ProductImage.sourceSha256` (server-owned);
    - `npm run check:model-nos`;
    - gate B L-A closed;
    - 2149 unit green (4 expected-fail).
  - **T2 done** (`be96922`):
    - `src/lib/import/{types,safety,columns,workbook}.ts`;
    - shared `readCentralDirectory` (our reader now sees exactly what JSZip sees; 3 zip-bomb bypasses found by the auto-review were fixed);
    - synthetic fixture `test/fixtures/import/build.ts` + `raw-zip.ts`;
    - the real-sheet test passes locally (33 headers, 12 rows, 0 warnings) and is skipped in CI;
    - 2237 unit green (4 expected-fail, 1 skipped).
  - **T3 done** (`4c9821f`, ADR 0056):
    - `clean.ts` (`cleanRow` → `CleanedRow`), `SPLIT_POLICY` in `columns.ts`, `numbers.ts` (`parseFilterNumbers`, `filtersFromSpecs`);
    - `FILTER_KEY_BY_SPEC` moved to `src/models/spec-columns.ts`;
    - the property test proves zero CJK on the real sheet;
    - 2452 unit green (4 expected-fail, 1 skipped).
  - **T4 done** (ADR notes pending for 0057, below):
    - `src/lib/import/group.ts`: `groupRows(rows, {categories, areas, defaultCategoryId})` → `{products: ImportProduct[], warnings}` (orphan rows at file level); `ImportProduct` / `ImportVariant` in `types.ts`;
    - the Magnetic Track rule now lives once in `src/models/product-constants.ts` (`isMagneticTrackCategory`, `trackSizeFromSlug`), used by `products.ts` and `product-category-options.ts` (behaviour unchanged);
    - golden No. 76 passes on the synthetic fixture and the real sheet; Nos. 80/81 blocked (`missing_model_no`);
    - 2506 unit green (4 expected-fail, 2 skipped = the "real sheet missing" notices).
  - **T5 done** (`7866406`):
    - `src/lib/import/images.ts` (`readEmbeddedImages(bytes, sheetNames)` → `{anchors, files: Map<sha256, EmbeddedImage>, warnings}`; pure `attachImages(products, embedded)` → `product.images: ImportImageRef[]`, `variant.imageSha256`);
    - `src/lib/import/ooxml.ts` (linear XML reader: DOCTYPE refused, caps, prefix-free, rels that climb out of the package dropped);
    - `readZipBytes` in `src/lib/xlsx-signature.ts` (`readZipPart` now also calls a deflated part with the wrong inflated length "corrupt"); `MAX_IMPORT_XML_PART_BYTES` 16 MB, `MAX_IMPORT_IMAGE_PIXELS` 25 MP in `constants.ts`;
    - new warning codes `image_too_large`, `image_not_on_row`; `missing_image` is emitted here;
    - real sheet: 12 anchors, 4 PNGs, one gallery image per product, 76+77 and 78+79 share a picture, no variant pictures;
    - 2559 unit green (4 expected-fail, 3 skipped).
  - **QA gate A: PASS** (T1–T5, 2026-10-07, Opus; three rounds):
    - round 1 FAIL: M-1 exceljs expands merge/validation/defined-name ranges cell by cell (tiny file → hang/OOM), M-2 cubic filter parsers, L-1 CJK punctuation survives, L-2 case-only duplicate part names;
    - fixed in `620711c`: `src/lib/import/sheet-guard.ts` inside `checkImportFile` (strips `<dataValidations>` + `<definedNames>`, caps merges 2,000 / 100,000 cells, `<col max>` ≤ XFD, `sheetId` ≤ 10,000, refuses ambiguous XML, re-checks after strip); `src/lib/import/zip-rebuild.ts` always rewrites the checked zip (one zip path, no JSZip in production); linear `numbers.ts`; block-wide `CJK_CLASS`; lowercased part names; `CheckedImportFile` brand (readers refuse raw bytes); any `vbaProject.bin` refused; Node engines `>=22.2` (`zlib.crc32`);
    - round 2 FAIL: M-3 non-canonical part names (`xl/./…`, `xl/a/../workbook.xml`) resolved by JSZip but not by our checks; fixed in `09d7c23` (refuse any name JSZip's `resolve` would change, backslashes too; duplicates on lowercased name) + I-7 (images read the sheet part exceljs reads);
    - round 3 PASS (`5f3b5de`): `test/import-gate-a.qa.test.ts`, `test/import-gate-a-recheck.qa.test.ts` (deterministic guard-output asserts, exact refusal reasons). 2659 unit green (4 expected-fail, 3 skipped), build OK, audit ok.
    - new refusal reasons `too_many_merged_cells` (→ fatal code `sheet_too_complex`), `sheet_out_of_range` (→ `not_xlsx`); caps `MAX_IMPORT_MERGES`, `MAX_IMPORT_MERGED_CELLS`, `MAX_IMPORT_SHEET_ID` in `constants.ts`.
  - **Plan amended 2026-10-07 (user, ADR 0059):** the client's sheet was only a sample; the client will always fill **a template we control** (one row per variant, Model No. always filled, no merged cells, English-only headers, `-` for n/a, fixed Category/Extra Category/Area values). The template is now the primary defence and runs **next**; the tolerant parser stays as the safety net (don't rip anything out, just don't design around arbitrary sheets). New order: **T10a → T10b → T6 → T7 → T8 → gate B → T9 → T11 → gate C.**
  - **T10a done** (ADR 0059 addendum): `src/lib/import/template.ts` (`buildImportTemplate`), parser additions (`Area:`/`Extra Category n` headers, `invalid_area_flag`, `Lists` sheet skipped, repeated `NO.` on the next row = continuation), golden round trip with zero warnings; 2706 unit green (4 expected-fail, 3 skipped).
  - **Open from T10a:** reword the `Image` header note (no "Place in Cell"; use floating pictures) before client hand-off; check comment box sizes in Excel/WPS at gate B; `unknown_area` is per row, not per column (optional fix).
  - **T10b done:** `GET /api/admin/import/template` (`src/app/api/admin/import/template/route.ts`; `requireAdminForRoute`, `listCategoryTree`/`listAreas`, attachment, `private, no-store`); 7 tests (401/403 incl. banned + temp-password admin, 200 headers, body passes `checkImportFile`, live areas/categories). 2713 unit green (4 expected-fail, 3 skipped). First admin route handler, sets the pattern. Not run against a real Next runtime yet: smoke it in `next dev` or at gate B.
  - **T6 done** (ADR 0060): `presignImportUpload` (`imports/<uuid v4>.xlsx`, signs xlsx MIME + exact length ≤ 30 MB, 5 min), `getImportBytes(key, {ifMatch?})` (Range + streaming cap, returns ETag), `deleteImportUpload`, `uploadImageBuffer(productId, data)` (signed `upload_stream`, `overwrite:false`, own `sourceSha256`, limit checks on the Upload API answer — deliberately NOT `inspectImage`, see ADR 0060 §3), `sweep:incoming` covers `imports/` > 24 h under the one guard, audit `import.commit` / target `import` (id = staged uuid), `src/lib/schemas/import.ts` (`IMPORT_KEY_PATTERN`, `importKeySchema`, `importIdFromKey`, `presignImportInputSchema`, `defaultCategoryIdSchema`, `importFileInputSchema`). Gate C L-1 closed (escaped dot, two `it.fails` → `it`). 2802 unit green (2 expected-fail, 3 skipped).
  - **T7 done** (ADR 0057): `src/lib/import/plan.ts` (`loadPlanLookups`, `planFromBytes`, `planProducts`, pure `planHash`) + `src/lib/import/index.ts` (`previewImport(input)` → `ServiceResult<ImportPreview>`, `{kind:"plan", etag, plan}` or `{kind:"refused", warnings}`; writes nothing, no tags). Plan types in `types.ts` (`PlanEntry`, `PlanTarget`, `PlanVariant`, `PlanChange`, `ImportPlan`); new error codes `no_slug`, `invalid_record` (merged target fails `productInputSchema`); `trackSizeOf` exported from `group.ts`. `importFileInputSchema` already had `{key, defaultCategoryId}` (T6); the service checks the category exists. Restricted filters: one `withoutRestrictedFilters` probe per plan gates every product. 31 tests in `plan.test.ts` (memory DB; incl. zero-writes via Mongoose debug + other collections unchanged + no `files` in the result, trackSize dropped when the sheet leaves Magnetic Track, conflict across two sheet products, ownership, restricted filters, hash on `updatedAt`/visibility/image sha, real sheet when present: 4 create + 2 blocked, then 4 unchanged). 2833 unit green (2 expected-fail, 3 skipped).
  - **T8 done** (`c628e99`, ADR 0061): `src/lib/import/commit.ts` (`commitPlanBatch`, `batchCount`, `COMMIT_ERRORS`), `commitImportBatch(actorId, input)` / `finishImport(input)` in `index.ts`, `commitImportInputSchema` / `finishImportInputSchema`. Hash protocol changed from the carry note: per-entry `hash` + `sheetHash`, `PLAN_HASH_VERSION` 2 (a single hash cannot survive earlier batches). 2873 unit green (2 expected-fail, 3 skipped).
  - **QA gate B: PASS after fixes** (T6–T8 + T10a/T10b, 2026-10-07, Opus): round 1 FAIL on M-1 (preview had no entry cap but commit refuses > 5000), L-1 (Image note said "Place in Cell"), L-2 (note boxes clipped), L-3 (`unknown_area` per row). Fixed in `08ef07e`: `too_many_products` fatal refusal in `planFromBytes`; note reworded (floating picture); template VML post-processed to 260×130 pt boxes (`jszip` used in `template.ts` on our own generated output only); `unknown_area` once per `Area:` column (`areaFlags` on cleaned rows, `areaColumns` into `groupRows`). Tests: `test/import-gate-b*.qa.test.ts` (40). Info: I-1 replaying a create batch after the product was deleted re-creates it until `finishImport`; I-2 `etag: null` skips the If-Match pin; I-3 `planHash` is not a keyed MAC. The concurrent-commit test now accepts "at least one ok" (the loser gets "preview again"). Full re-run of the gate not repeated; run the QA review again only if T9 touches these files.
  - **T9 done** (ADR 0058): `/admin/import` (page, loading, `actions.ts` with presign/preview/commitBatch/finish, `src/components/admin/import/*`), nav entry "Import". Browser runs the batch loop and skips batches with nothing to write (`batchesToSend`; one-line change if every batch must be sent); `maxDuration` 300; commit action returns `next` (retry/preview/upload/confirm) by comparing service messages. 3031 unit green, lint/typecheck/build OK. NOT seen in a browser, e2e not run (`.next` rebuilt: rebuild before e2e); `e2e/admin-shell.spec.ts` now expects 10 nav links. Gate B not re-run (no gate-B files touched).
  - **Follow-ups from T9:** add a `presignImport` service in `src/lib/import/index.ts` (then drop the `@/lib/storage` guard exception in `test/admin-guards.test.ts`); machine-readable error codes on `ServiceResult` (`preview_again`, `file_changed`, `staged_missing`, `category_gone`) instead of message comparison (an expired staged file currently maps to "retry").
  - **T11 done:** `e2e/admin-import.spec.ts` (6 tests: template download, filled template -> preview -> commit -> Arc draft with 2 variants + image + audit, staged file deleted, re-import = all unchanged and nothing written, bilingual fixture as tolerance case, non-workbook refused; axe + 375 px + focus per step) and a `admin-import` project in `playwright.config.ts` (runs last, like `admin-exit`). Full e2e 139 green, typecheck/lint OK. No T9 bugs found. Optional polish: "Import finished" Alert has no `role="alert"`, results table has no accessible name.
  - **QA gate C: PASS after fixes** (2026-10-08, Opus): H-1 `next` 16.3.7 -> 16.3.8 (six advisories, audit red; `eslint-config-next` too; CLAUDE.md updated), L-1 expired staged file now maps to `upload` (`STAGED_FILE_MESSAGES` exported from `src/lib/import`), L-2 `aria-label` on a span replaced by `sr-only` text. `test/import-gate-c.qa.test.ts` (24 tests). 3056 unit green, lint/typecheck/audit OK. Open polish: "Import finished" Alert role, table captions. Full e2e not re-run after the Next bump: CI will run it.
  - **Phase 3 code complete. Next:** push `phase-3`, PR with `gh`, wait for CI, ask the user before merging into `main`; then Phase 4 planning. Still open for the user: real-credential smoke (import the real sheet, import again = all unchanged; R2 If-Match; Cloudinary upload_stream), `npm run db:indexes` on a scratch DB, client questions (5000 products per file, floating pictures in Excel/WPS). Follow-ups: `presignImport` service, machine-readable codes on `ServiceResult`.
  - **T9 labels (from gate B):** `too_many_products` "Too many products" (fatal); `unknown_area` is now one file-level warning per unknown `Area:` column (column `areaFlag`, hint "download a fresh template"), per row only for the free-text `Areas` column.
  - **Client question:** do 5000 products per file and "floating picture over the Image cell" work in the client's Excel/WPS? Real-credential smoke (R2 If-Match, Cloudinary upload) still open.
  - **Carry into T9 (from T8):** commit action = `requireAdmin()` → `commitImportBatch(viewer.user.id, input)` → `revalidateCatalogInAction(result.tags)` on BOTH branches; the client keeps `plan.entries.map(e => e.hash)` from the preview and sends it on every batch; loop batches `0..batchCount(entries.length)-1` (re-sending is safe); on `PREVIEW_AGAIN` / `FILE_CHANGED` go back to the preview step; show each `CommittedProduct.status`/`error` with link by id/slug; call `finishImport` after the last batch; `acknowledgeRemovals` is a field error; check `maxDuration` (20 products × 4 parallel uploads + a full re-parse per batch).
  - **Low follow-ups (T8):** `previewImport` and `commitImportBatch` repeat the "category exists, then read staged file" steps (shared helper).
  - **Carry into T8 (from T7):**
    - re-plan with `planFromBytes(bytes, {...await loadPlanLookups(), defaultCategoryId})` from `getImportBytes(key, {ifMatch: previewEtag})`; refuse unless `plan.planHash` equals the previewed hash (the hash covers each matched product's `updatedAt`, the visibility setting and the default category);
    - write EXACTLY `entry.target` (plan tests' `saveAsCommitWould` shows the shape: optional texts unset when null, variant `specs` omitted when empty, `label` always set), so the next preview is `unchanged`; on update `$set` only sheet-owned paths, never `name`/`slug`/`status`/admin fields; `target.name`/`slug` are written on create only;
    - `variantsRemoved` only with the acknowledgement; `imagesToAdd` → upload, then push `{publicId, order, kind:"gallery", sourceSha256, alt: product name}`; `PlanVariant.imageSha256` (new variants only) → that upload's `publicId` (or the existing image with that `sourceSha256`);
    - the slug from the plan can still race: a duplicate-key error on create = product error, not a crash; `filters` are already gated, do not recompute without `withoutRestrictedFilters`.
  - **Carry into T8 (from T6):** `getImportBytes(key, {ifMatch: previewEtag})` (`StorageConditionError` → "file changed, preview again"); pass the `Uint8Array` / `Buffer.from(img.data)` to `uploadImageBuffer` and store `image.publicId` + `image.sourceSha256`; `deleteImportUpload` in `finishImport`; audit target id = `importIdFromKey(key)`.
  - **Carry into T9 (from T6):** presign action = `requireAdmin()` → `presignImportInputSchema` → `presignImportUpload({contentType: XLSX_MIME_TYPE, contentLength: size})`; the browser PUT must send exactly the signed `Content-Type`.
  - **Real-credential smoke (gate B or later):** R2 honours `If-Match` on GET; a signed server `upload_stream` returns `existing` and format/bytes/width/height. Low T6 follow-ups: duplicated 24 h / 300 s literals, uuid v4 regex in four modules, no test for the non-`Uint8Array` chunk branch. `test/phase2-exit.qa.test.ts` `.next/server` walk can time out at 5 s under load (flake, not a bug).
  - **Gate B** now covers T6–T8 + T10a/T10b (template round trip, route guard).
  - **Carry into T9 (ADR 0059):** a "Download template" link in step 1; labels for `invalid_area_flag` and a hint on `unknown_category`/`unknown_area` ("download a fresh template").
  - **Carry into T11:** the exit e2e downloads the template and imports a filled one (the synthetic bilingual fixture stays as the tolerance case).
  - **Carry into T9 (from gate A):** warning messages repeat cell values, raw header first lines and uncleaned sheet names (may hold Chinese): show them to the admin only, never write warning text to the audit log, server logs or the DB (I-3, I-4). Labels for `sheet_too_complex` ("Sheet too complex: too many merged cells") and the `sheet_out_of_range` message.
  - **Carry into T8 (from T5):** upload only sha256s that a written product references; one Cloudinary copy per product; skip sha256s already in that product's `sourceSha256`; 30-image cap on stored + new; `imageSha256` → `variants[].imagePublicId` only on create or new variant; pass `Buffer.from(img.data)`. The 25 MP cap assumes Cloudinary's free plan — confirm when the plan is known.
  - **Carry into T9 (from T5):** labels `image_too_large` "Picture too large (over 10 MB / 25 MP)", `image_not_on_row` "Picture not on a product row", `unsupported_image` "Picture can't be used", `unsupported_image_store` "Pictures stored in cells (not imported)", `missing_image` "No picture"; alt text comes from the product name (sheet picture names are useless).
  - **Carry into T9:** preview labels for `duplicate_product_no`, `short_base_model_code`, `model_no_has_space`, `invalid_product_no`, `invalid_model_no`.
  - **Carry into T9 (from T7):** the preview action = `requireAdmin()` → `previewImport(input)` (no revalidation: tags are always `[]`); labels for `model_no_conflict`, `variant_removed` (needs the ack), `no_slug`, `invalid_record`; show `entry.changes` + "+`moreChanges` more"; the response holds restricted spec values (admin only, never cached or logged).
  - **Gate B should check (T7):** the zero-writes test, that `PlanTarget` has no admin-owned field, the hash inputs (ADR 0057 §5), and the per-plan `withoutRestrictedFilters` probe (ADR 0057 §4).
  - **Carry into T8 (from T1):**
    - use `modelNoKey` for in-sheet duplicates;
    - pass `{ collation: MODEL_NO_COLLATION }` on every model-no. lookup;
    - set `sourceSha256` on imported images;
    - `findModelNoCollisions` (`src/lib/model-no-collisions.ts`) can be reused.
  - **QA:** gate A passed; B after T8 (covers T6–T8 + T10a/T10b), C at exit.
  - **English only (user, 2026-10-07):**
    - no Chinese is ever stored;
    - the sheet puts English first, then a blank line, then Chinese; the blank-line cut + CJK strip handle it;
    - multi-line cells use a per-column split policy (options / options+slash / join), not always options.
  - **User must do (per database; dev now, preview/prod later):**
    1. `npm run check:model-nos`, and fix anything it lists.
    2. In Atlas, open `products` → Indexes, then drop `variants.modelNo_1` (or in mongosh: `db.products.dropIndex("variants.modelNo_1")`).
    3. Right after step 2, run `npm run db:indexes`.
  - **Ask the client:** (merged cells are now ruled out by the template rules) the sheet's pictures are cropped in Excel but we import the full photo (OK, or apply the crop at commit?); should a picture outside the Image column (e.g. a dimension drawing) become a gallery image (today it does); Nos. 80/81 have no model no. (they will be blocked in the preview), the `95±` lumen efficiency values, the "High Effciency Reflector" typo, whether NO. restarts on each sheet, and whether a base code like `AR-10`/`AR-12` → `AR-1` is OK or should stop at a digit boundary (decide before the first real import: slugs are set on create only).
  - Subagents: `import-engineer`, `backend-architect`, `admin-panel-builder`, `qa-security-reviewer`. No new subagent. All on Opus.
- **Phase 3 must-dos (all planned in, see the plan's last section):**
  - ~~Fix gate B L-A~~ (done in T1, ADR 0055).
  - The import MUST call `withoutRestrictedFilters` (`src/lib/admin/products.ts`) so restricted columns never get filter numbers.
  - Import-preview images uploaded to Cloudinary and not confirmed within 24 h would be swept by `sweep:cloudinary`; design the preview step with this in mind (or confirm in the same sitting / track pending ids).
  - Open: per-environment Cloudinary folder prefix (dev/preview/prod share `yg/products|areas`; sweep has a mass-delete guard, ADR 0053).
- **Phase 2 leftovers (Low, not blocking):** gate C L-1 (escape `.` in key patterns, two `it.fails`), L-2/L-3 (delete races), L-4 (`aria-hidden` on hidden file inputs); gate D L-1/L-2/L-3; gate A L-1 (`[id]` pages 200 for unknown id), L-3; T13 follow-ups (uploader names in `listDatasheets()`), T11b low follow-ups. See the Phase 2 history below.
- **User must do:** rebuild before any local `npm start` (the `.next` folder may come from an e2e build). Provide the client's Arc sheet as the import fixture when available.

### Phase 2 history (done, kept for reference)
- **Done:**
  - T1 (shadcn + tokens, ADR 0034).
  - T2 (shared helpers + `products.datasheetId` index, ADR 0035):
    - `src/lib/revalidate.ts`, `audit.ts`, `slug.ts` and `constants.ts`;
    - the audit vocabulary in `src/models/audit-actions.ts`.

  - T3 (admin shell + dashboard, ADR 0036).
  - T4 (category schemas + service, ADR 0037): `src/lib/schemas/{common,category}.ts`, `src/lib/admin/{write-result,categories}.ts`; 991 tests green.
  - T5 (categories UI, ADR 0038): `/admin/categories` (tree, new, edit, move, delete), reusable `callAction`/`ActionResult` pattern, action guard rules in `test/admin-guards.test.ts`; 1062 tests green, build OK.

  - T6 (areas, ADR 0039): schemas + service + UI; 1141 tests green. Built with Sonnet 5.5 subagents because the user asked for it.

  The review hook is on.
- **QA gate A: PASS** (T1–T6, 2026-10-06). Added `e2e/admin-catalog.qa.spec.ts` (19), `test/admin-write-path.qa.test.ts` (30), `e2e/fixtures/database.ts`. 1171 unit + 61 e2e green, build OK.
- T7 done (product schema, ADR 0040), 1209 tests green.
- T8 done (product service, ADR 0041), 1248 tests green.
- T9 done (products list + new draft UI, ADR 0042; gate A's L-4 and L-5 fixed), 1282 unit + 69 e2e green.
- T10a done (product edit form section (a), ADR 0043), 1364 unit + 74 e2e green.
  - Status changes only through publish/unpublish.
  - Optimistic concurrency on `updatedAt`.
  - A published product stays publishable.
  - Route groups `admin/(dashboard)` and `products/(list)` give a real 404.
- T10b done (ADR 0044): specs editor, variants, extra specs, public files. 1429 unit + 80 e2e green.
- **QA gate B: PASS** (T7–T10b, 2026-10-06; run on Sonnet 5.5 at the user's request). No Critical, High or Medium findings. Added `test/admin-products.qa.test.ts` (48) and `e2e/admin-products-gate-b.qa.spec.ts` (4). 1476 unit + 84 e2e green, build OK, audit ok. Firefox and WebKit are not installed, so focus after a move is checked in Chromium only.
- T11a done (ADR 0045, note on 0027): `src/lib/{cloudinary,cloudinary-ids}.ts`, `src/lib/admin/{uploads,product-images}.ts`, `setAreaImage` in `areas.ts`, `/admin/:path*` CSP. 1605 unit green, build OK. Gate A L-2 and gate B L-C are closed: publicId shape is enforced in Zod and Mongoose, and a variant image must be one of the product's own images.
- T11b done (ADR 0046): product images editor (own section + Save, XHR upload with progress, alt text, kind, reorder), variant image select over saved images, area black-and-white uploader, 4 actions with customer/visitor tests; gate A I-1 closed. 1670 unit + 84 e2e green, build OK. Built on Opus (the user wants good-looking UI; a Sonnet run was stopped).
- T12 done (ADR 0047, built on Sonnet 5.5 at the user's request): `src/lib/{storage,xlsx-signature}.ts`, `src/lib/schemas/datasheet.ts`, `src/lib/admin/datasheets.ts` (`listDatasheets`, `presignDatasheetUpload`, `finalizeDatasheet`, `renameDatasheet`, `deleteDatasheet`), `datasheet.rename` audit action, gate B I-2 re-check in `setStatus` (publish returns `fieldErrors.datasheetId`/`mainCategory`). 1736 unit green; fixed the T11b `NEXT_PUBLIC_` comment test failure.
- T13 done (ADR 0048, Sonnet 5.5 at the user's request): `/admin/datasheets` (list, search, paging, upload new/replace, rename, delete with in-use refusal), `datasheet-picker.tsx` in the product form, 5 actions with customer/visitor/banned tests; publish errors map `datasheetId`/`mainCategory`. 1787 unit green, build OK. NOT yet seen in a browser.
- **QA gate C: PASS** (T11a–T13, 2026-10-07, Sonnet 5.5 at the user's request). No Critical/High; 1 Medium (test infra) + 4 Low. Added `test/admin-uploads.qa.test.ts` (76, 3 `it.fails`) and `e2e/admin-datasheets-gate-c.qa.spec.ts` (16). 1860 unit + e2e green (see M-1), build OK, audit ok. User applied the R2 CORS rule 2026-10-07.
- T14 done (ADR 0049, Sonnet 5.5 at the user's request): `src/lib/schemas/settings.ts`, `src/lib/admin/settings.ts` (column visibility, WhatsApp, company email; filter cleanup runs on every save so a retry repairs; clearing deletes the siteContent doc). 1901 unit green (5 expected-fail), typecheck + lint OK.
- T15 done (ADR 0050, Sonnet 5.5 at the user's request): `/admin/settings` (28 column switches, WhatsApp, company email), 3 actions with customer/visitor/banned tests, static guard now requires revalidate + service call, T14 open item closed (`withoutRestrictedFilters` in `products.ts`). 1933 unit green (5 expected-fail), typecheck + lint + build OK. NOT yet seen in a browser.
- **QA gate D: PASS** (T14–T15, 2026-10-07, Sonnet 5.5 at the user's request). No Critical/High/Medium; 3 Low + info. Added `test/admin-settings.qa.test.ts` (90) and `e2e/admin-settings-gate-d.qa.spec.ts` (15, own Playwright project `settings-gate-d`, depends on chromium; it wipes `filters.cctK` so it must not overlap other specs). 2023 unit green (5 expected-fail), gate D e2e 15/15, build OK, audit ok. The settings page was seen in a browser (axe clean, 375 px OK).
- T16 done (no ADR, Sonnet 5.5 at the user's request): most already existed from T10a; added reason links (each publish reason links to its section/control and moves focus; `status-links.ts`) and `src/app/admin/not-found.tsx`. Root `admin/error.tsx` already covers all segments. 2025 unit green (5 expected-fail), typecheck/lint/build OK. NOT seen in a browser (link focus, not-found page); add e2e in T18.
- T17 done (ADR 0051, Sonnet 5.5 at the user's request): `src/lib/orphan-sweep.ts`, `scripts/{sweep-incoming,sweep-cloudinary-orphans,report-orphan-datasheets}.ts`, `listImages` in `cloudinary.ts`, npm scripts `sweep:incoming`, `sweep:cloudinary`, `report:datasheets`. 2039 unit green (5 expected-fail). NOT run against real R2/Cloudinary: do a dry-run smoke with real credentials. Never schedule `--apply` in cron without a mass-delete guard.
- T18 done (ADR 0052, Sonnet 5.5 at the user's request): `e2e/admin-product.spec.ts` (10 tests), in-memory R2/Cloudinary fakes (`e2e/fake-providers/`), shared sign-in (`e2e/global-setup.ts`, closes M-1), `workers: 1`. 2039 unit + 125 e2e green. Watch for a repeat of one unreproduced alt-text save flake.
- **QA gate E: PASS** (Phase 2 exit, 2026-10-07, Opus). No Critical/High. 2060 unit (6 expected-fail) + 133 e2e green, build/audit OK, gitleaks clean, db:indexes OK on a scratch DB. Added `test/phase2-exit.qa.test.ts` (22) and `e2e/admin-gate-e.qa.spec.ts` (8).
    - **M-1 and L-1 FIXED** (ADR 0053): sweep mass-delete guard + ETag-pinned finalize. 2094 unit (5 expected-fail) + 133 e2e green. Open: per-environment Cloudinary folder prefix; real-credential smoke must confirm R2 honours `If-Match` / `CopySourceIfMatch`.
- Still open, not blocking: gate B L-A (case-insensitive model no., **fix before Phase 3 import**), gate C L-1/L-2/L-3/L-4, gate D L-1/L-2/L-3, gate A L-1 ([id] pages 200 for unknown id) and L-3. Phase 3: import preview images uploaded >24 h before confirm would be swept.
- Phase 2 PR #11 merged; real-credential smoke done 2026-10-07 (R2 conditional read/copy, Cloudinary upload, sweep dry runs).
- **Open items from gate D:**
  - **L-1:** `updateProduct` reads the visibility setting then writes; a save racing a column restriction can re-write restricted filter numbers (repaired by saving the column setting again). Fix with a version/`updatedAt` check or a second cleanup pass.
  - **L-2:** a retry whose setting is unchanged but cleanup modified products writes no audit entry.
  - **L-3:** `parseStoredColumnVisibility` (`src/lib/schemas/settings.ts` ~50-58) reads `raw[key]` through the prototype chain; use `Object.hasOwn`.
  - **Info (T18, extends M-1):** full `npx playwright test` is flaky because of the per-email login limiter and parallel workers; use `workers: 1` in CI, shared `storageState`, or separate emails per spec.
- ~~T14 open item~~ (closed in T15): the product form can type `filters.*` for a restricted column, so a restricted filter can reappear after a later product edit. Fix in `src/lib/admin/products.ts` (drop `filters.<x>` for restricted columns on save via `getColumnVisibility()`), or ignore them in the Phase 4 public filter query. Also: making a column public again does not restore its filters (next import/save recomputes).
- **Open items from gate C:**
  - **M-1 (T18):** e2e sporadically hits the sign-in rate limit (10/15 min per email, ADR 0022; success doesn't reset). Sign in once in Playwright global setup and share `storageState`.
  - **L-1:** `INCOMING_KEY_PATTERN`/`DATASHEET_KEY_PATTERN` in `src/lib/schemas/datasheet.ts:22-30` have an unescaped dot (use `\.xlsx` in the template literal); two `it.fails` become `it`.
  - **L-2:** delete racing replace can orphan an R2 object: re-delete the key after `deleteOne`, or re-check the row after the copy (`it.fails`).
  - **L-3:** product attached mid-delete dangles `datasheetId`; publish re-check refuses it. Accept or narrow window.
  - **L-4:** hidden file input duplicates the button name: add `aria-hidden="true"` in `datasheet-uploader.tsx` HiddenFileInput and `image-drop-zone.tsx`.
  - **I-1:** Replace file picker unchecked in Firefox/WebKit. **I-2 (Phase 5):** encode file names in `Content-Disposition` (RFC 5987). **I-3:** key patterns ship in the client bundle via `datasheet-list.tsx`; move to a client-safe module if desired.
- **T13 follow-ups:** add uploader name/email to `listDatasheets()` and delete `src/app/admin/datasheets/uploader-names.ts`; optional service-side filter/paging. **T18 must-do:** `e2e/test-server.ts` env switch swapping `@/lib/storage` for an in-memory fake (PUT handler writes bytes so headObject/getObjectBytes/copyObject see them), exceljs .xlsx fixture; selectors "Choose Excel file", `#product-datasheetId`, per-row Replace/Rename/Delete.
- **T18 must-do (from T11b):** add a Cloudinary fake switch to `e2e/test-server.ts` and upload e2e tests: images editor (upload, alt, reorder, save, `PRODUCT_CHANGED`, variant-in-use refusal) and area uploader (set, replace, remove, plus axe on `/admin/areas/[id]`). The area uploader has not been seen in a browser yet, and real uploads have not been tried against Cloudinary: do a manual smoke once with the real credentials.
- **Low follow-ups from T11b:**
  - Backend: add `cloudinaryCloudName(): string | null` to `src/lib/cloudinary.ts` and delete `src/app/admin/cloudinary-cloud-name.ts`. Optionally return the new `updatedAt` from `saveProductImages`.
  - `applyServerErrors` is duplicated in `area-form.tsx` and `category-form.tsx`: make one shared helper.
  - `saveProductImagesAction` repeats the tail of `statusResult`.
  - Nice to have: a thumbnail column in the products list (`previewUrl`).
- **User must do before T13 runs against the real bucket:** apply the R2 CORS rule (plan, "Things the user must do"). Reminded 2026-10-06.
- **T17 must-do:** the orphan report also covers Cloudinary:
  - `yg/products/*` and `yg/areas/*` assets that nothing references;
  - images of deleted products;
  - signed but never-saved uploads.

  Removed images are never deleted at save time (ADR 0045).
- **Follow-up (low):** `scripts/check-services.ts` configures Cloudinary inline; it could reuse `src/lib/cloudinary.ts`.
- **Open items from gate B:**
  - **L-A:** model numbers are case-insensitive within a product but case-sensitive across products (`takenModelNos`, unique index), so `ZZ-9` and `zz-9` can coexist. Fix with a collation on the index or normalised case, before Phase 3 import (upsert by model no.). The `it.fails` test in `admin-products.qa.test.ts` turns into a plain `it` once fixed.
  - **L-B:** same as gate A L-1, below.
  - ~~L-C~~: fixed in T11a.
  - **L-D:** same as gate A L-3, below.
  - **L-E (Phase 4):** changing a published product's slug leaves no redirect.
  - **I-1:** area, category and new-draft forms still give inputs a `name` (low value, admin-only, no-store). Drop it when those forms are next touched.
  - **I-2:** publish doesn't re-check that `mainCategory` / `datasheetId` still exist. Re-check it in T13 when datasheets land.
- **Backend follow-ups from T10a (ADR 0043, not blocking):**
  - `invalidInput` should key nested Zod issues by the full dotted path.
  - Add a shared `isMagneticTrackCategory` helper, to remove the duplicate in `product-category-options.ts`.
  - Export the createDraft schema, and move `MAX_PRODUCT_SEARCH_LENGTH` to `constants.ts`.
  - Add a `group` field to `SPEC_COLUMNS` (ADR 0044).
  - When the column-visibility setting lands, pass the effective restricted keys to the edit form.
- **Open items from gate A:**
  - **P-1:** covered. `scripts/audit.mjs` allows GHSA-vfj7-8cjw-p6xm until 2027-01-05 (ADR 0033), and gate B ran it: "audit: ok". Before the merge, check that CI uses the script; add an `overrides` entry once a patch exists.
  - L-1: categories and areas `[id]` pages still answer 200 on not-found because of their `[id]/loading.tsx`. Products is fixed (ADR 0043); apply the same fix, or accept it in an ADR note.
  - ~~L-2~~: fixed in T11a.
  - L-3: add the planned ESLint rule (no `"use client"` import of `server-only`/`src/lib/admin/*`); a static test covers it now.
  - L-4 and L-5: fixed in T9.

- **Admin guards (ADR 0036):**
  - The layout's `requireAdmin()` gives the real 403; `loading.tsx` doesn't wrap the layout.
  - Pages still guard first, because client navigation skips the layout.
  - Admin metadata is static only.
  - `test/admin-guards.test.ts` enforces this. T5 adds its Server Action `describe` block: `requireAdmin` first, plus the customer and visitor behavioural tests (QA L2, task 6).
- **Nav:** the module list lives in `src/components/admin/admin-sections.ts`. Its links 404 until each module exists; don't add placeholder pages.
- **Write path (ADR 0035), applies from T4 on:**
  - Services run `connectDb` → Zod → write → `recordAudit` → return `{ok, data|errors, tags}`. When the audit write fails, they still return the tags.
  - Actions run `requireAdmin()` first → the service → `revalidateCatalogInAction(tags)` → `redirect` outside any `try`.
  - T14 should tie each `settings.*` audit action to its exact siteContent key.
- **Exit check:** `npm run db:indexes` builds the new `products.datasheetId` index on the real database.
- **Model guidance (user rule, 2026-10-06; overrides the plan's model column):** every subagent runs on **Opus**. UI work always goes to the frontend subagents (`admin-panel-builder`, `site-frontend`, `motion-engineer`) with `model: "opus"`. Never build UI in the main session.
- **shadcn adds:** every later `npx shadcn add` gets the ADR 0034 strip pass (header line, no animation, no `dark:`, tokens instead of raw colours). `design-shell.qa.test.ts` enforces it. Admin forms will probably need `field`, `alert`, `pagination` and `empty`.
- **GitHub:** use `gh` (push, PR, CI, merge); always ask the user before merging into `main`.
- **Verified 2026-10-06:** `npm run check:services` passes for MongoDB (non-SRV `mongodb://` string in `.env.local`, database `yg_unilux_db`), Cloudinary (upload + delete + Admin API) and R2 (write + delete). The `mongodb+srv://` form fails on the user's machine because a VPN DNS proxy (`127.0.0.1`) drops SRV lookups, so keep the non-SRV string.
- **Admin account:** the user still needs to run `npm run seed:admin -- --email <email> --name "<name>"` in PowerShell against `yg_unilux_db` before they can sign in at `/login`.
- **QA after:** each Phase 2 feature plus the Phase 2 exit (`qa-security-reviewer`). Every changed file also gets the automatic per-file review.
- **Per task:** typecheck, lint and tests, then a tasks.md update and exactly one commit. Every file starts with a 2–3 line header comment and has "what and why" comments.
- **User must add to `.env.local`:**
  - `AUTH_URL=http://localhost:3000` (required);
  - `IP_HASH_SECRET` (32+ random characters, different from `AUTH_SECRET`);
  - a database name in `MONGODB_URI` (`…mongodb.net/yg_unilux?…`).
- **User should try once:**
  - `npm run seed:admin -- --email <admin email> --name "<name>"` from **PowerShell** (hidden prompt; Git Bash needs `winpty`). QA could not test a real Windows console.
- **Local dev:** use `http://localhost`, not `127.0.0.1`, because the `__Host-` device cookie needs it. `npm run test:e2e` needs port 3000 free (it never reuses a running server) and runs on a seeded in-memory MongoDB (ADR 0029).
- **Open QA Lows from task 5:**
  - L3 (Phase 5): sign-in and reset must post to `/api/auth/*`, never through server actions (`/login` already does). The change-password UI sends `revokeOtherSessions: true`.
- **Must-do items carried forward:**
  - **Phase 5 (before the change-password UI):** enforce the 24 h server cap on the replacement session that `/change-password` creates when "Keep me signed in" was off (ADR 0032 "Known gap"). Then turn the `it.fails` test in `src/lib/remember-me.qa.test.ts` into a plain `it`.
  - **Phase 2:** per-session revoke must use `auth.api` on the server with session ids, because tokens are stripped from `/api/auth` JSON (ADR 0030; also affects `/admin/list-user-sessions`).
  - Admin pages and layouts call `requireAdmin()` at the top, outside any `<Suspense>`/`loading.tsx`, so the 403 status is real. Admin Route Handlers use `requireAdminForRoute()`. Never wrap either in `try/catch` without `unstable_rethrow` (ADR 0024). `/admin` already guards in both the layout and the page (ADR 0029).
  - **Phase 2:** each admin Server Action gets a test that calls it as a customer and asserts nothing changed (QA L2, task 6).
  - **Phase 2:** admin uploads need `connect-src` hosts (Cloudinary upload API, R2 presigned PUT) added in `src/lib/security-headers.ts` with a note in ADR 0027. `dangerouslySetInnerHTML` is used only for JSON-LD (`JSON.stringify` with `<` escaped).
  - **Phase 2:** the admin UI uses shadcn under `src/app/admin` (outside `(site)`). Use design tokens and the contrast rules in ADR 0028.
  - **Phase 4:** move the footer's `new Date().getFullYear()` out of the prerender path before turning on `cacheComponents` (QA L1, task 11).
  - **Phase 5:** `/change-password` must exist before any path can create an admin with `mustChangePassword: true`. Today `seedAdmin` always sets it to false, and `requireAdmin()` would redirect such an admin to a 404. Customers currently land on `/` after sign-in.
  - **Phase 7:** remove the smoke test's "404 resource" console filter once every nav page exists (ADR 0029).
  - The blocked-page wording lives once, in `BLOCKED_COPY` (`src/lib/geo.ts`). `/blocked` stays outside `(site)` with no chrome (ADR 0026, 0028).
  - Tests never wait for Playwright `networkidle`: 404 prefetches never settle (ADR 0028).

**Current focus:** Phase 3 — Bulk import — plan approved, T0–T3 done, next T4 (Phase 2 merged 2026-10-07)

**Phase 1 decisions (user, 2026-10-01):**
- **Logo:** no SVG yet, so the header uses a text placeholder.
- **Fonts:** two Google Fonts, bundled at build time with `next/font`, so there are no runtime requests to Google. Pairing chosen 2026-10-04: Cormorant Garamond (headings) + Inter (body) — ADR 0028.
- **Malformed `GEO_BLOCK_ENABLED`:** fail closed. Block CN and log the error; ADR in task 8.
- **Email:** no verified Resend domain yet. Reset emails are tested only to the user's own Resend account email.
- **QA:** `qa-security-reviewer` runs after tasks 3, 5, 6, 7, 8, 11 and 12. The other tasks get only the automatic per-file review.
- **Comments:** every file starts with a 2–3 line plain-English header. Important functions and blocks get a short "what and why" comment; obvious lines don't.
- **Per task:** typecheck, lint and tests, then a tasks.md update and exactly one commit.
**Working method:** plan mode → approve → small commits on a `phase-N` branch → lint + typecheck + tests + build green → security check against CLAUDE.md → PR → merge → tick here.

---

## Phase 0 — Setup & tooling (no features)
- [x] Read client requirement PDF, plan PDF and CLAUDE.md
- [x] Install `find-skills` skill
- [x] Approve full roadmap
- [x] Create `doc/tasks.md` and `doc/decisions/` (ADRs 0001–0012)
- [x] Install all project skills (20) and create 6 subagents in `.claude/agents/` — ADR 0013
- [x] Automatic per-file review: `.claude/agents/code-reviewer.md` + PostToolUse/FileChanged hooks — ADR 0014
- [x] Commit setup work on `main`
- [x] Reload session, verify agents + skills + hooks load (`/agents`, `/hooks`)
- [x] Decide security tooling: Dependabot (weekly, grouped; Next/React majors manual), `npm audit --audit-level=high` in CI, gitleaks in CI + pre-commit; CodeQL only if free on private repo, else skip + ADR 0015. Phase 0 plan approved in chat.
- [x] Install gitleaks 8.30.1 locally (winget; on user PATH after shell restart)
- [x] Gitleaks baseline: first history scan flags 1 false positive (`mockToken` example in `.claude/skills/playwright-best-practices/advanced/authentication-flows.md:54`). Add its fingerprint to `.gitleaksignore` (narrow, not a path allowlist) in Phase 0
- [ ] User checks GitHub → Settings → Code security (Dependabot alerts, code scanning, secret scanning) and reports what is available
- [x] Before scaffolding/`npm install`: `touch .claude/reviews/.disabled`
- [x] Remove `.claude/reviews/.disabled` after merge (done 2026-10-01; hook verified working)
- [x] Scaffold Next.js 16.3.7 (TS, App Router, `src/`, Tailwind 4, ESLint, `@/*`) with placeholder page
- [x] Read installed Next docs for caching, `proxy.ts` and dynamic APIs; finalised ADR 0008 + 0007
- [x] Install dependencies (ADR 0011): all except the auth library
- [x] **Decide the auth library**: Better Auth 1.7.7 + `mongodb@~7.6` (one shared driver) — ADR 0017
- [x] Config: strict tsconfig, Prettier, ESLint (bans `NEXT_PUBLIC_*`), Vitest, Playwright, npm scripts
- [x] `src/lib/env.ts` (Zod, server-only, lazy per feature, 43 tests) + `.env.example`; `.env*.local` gitignored
- [x] Update CLAUDE.md: 11 collections, `datasheetId`, `proxy.ts`, caching + no-restricted-data-in-cache, rate limit, keys, secrets, R2, npm/Vitest/Playwright
- [x] `.gitattributes` (LF), Dependabot, CI (checks + audit, e2e, gitleaks), gitleaks config + husky pre-commit — ADR 0015
- [x] `qa-security-reviewer` on `phase-0`: FAIL → fixed (F1 gitleaks allowlist, F2 NEXT_PUBLIC bypasses, F3 whitespace, F5 npm pin, F7 uuid) → re-review FAIL on N1 (devEngines `error` breaks npm 10) + N2 (config glob too broad) → both fixed by orchestrator and verified
- [x] Push `phase-0`, CI green on GitHub, merged to `main` (PR #1)
- [ ] Link Vercel project, deploy blank app — **deferred: client's Vercel account doesn't exist yet**
- **Exit:** CI green, docs committed (Vercel preview once the account exists)

## Between phases
- [x] `CLOUDINARY_URL` replaces the three Cloudinary variables; next/image limited to our cloud — ADR 0016 (branch `chore/cloudinary-url`)
- [x] Direct `mongodb` dependency: needed by Better Auth's adapter; pinned to Mongoose's range `~7.6` so npm dedupes to one copy (test + Dependabot ignore) — ADR 0017

## Phase 1 — Foundations ✅ (merged 2026-10-06, PR #9)
- [x] Task 1: `lib/db.ts`, one shared `MongoClient` for Mongoose and Better Auth, strict Mongoose, `MONGODB_URI` must name the database — ADR 0018
- [x] Task 2: 11 Mongoose models + read-only `users` + `loginAttempts` (TTL), `spec-columns.ts`, `npm run db:indexes` — ADR 0019 (8 open questions listed there)
- [ ] Task 5 must also apply ADR 0022's 'Required in task 5' list (issue a device token on password reset, token epoch, path passed to clearSignIn, wider guard, Better Auth limiter storage, reset hardening)
- [x] Task 5: Better Auth (`lib/auth.ts`, `auth-handler.ts`, `password-hash.ts`, `/api/auth/[...all]`); QA FAIL → fixed → re-review — ADR 0023
- [x] Task 3: `lib/rate-limit.ts` per-email limiter (HMAC keys, atomic window, fail closed); QA PASS — ADR 0020
  - [ ] Task 5 must: gate with `consume()`, clear on success and after password reset, generic 429, audit lockouts (ADR 0020 a/b/e/f)
  - [x] Task 7 must: `seed:admin` clears the admin's login/reset counters
  - [ ] User decision: add per-(email + hashed IP) key against targeted lockout (ADR 0020 c)
- [x] Task 4: `lib/email.ts` Resend sender + password-reset template; `env.isProduction()` — ADR 0021
- Task 3b QA (2026-10-02) FAIL → user decisions:
  - H1: a signed **known-device cookie** (OWASP device cookies), so known devices skip the shared per-email slow-down and have their own 5/15 min limit. Polling during a wait is no longer free (no give-back).
  - On success, clear only the caller's network counter (not the slow-down).
  - Reset requests get the same per-network + never-zero per-email treatment in task 5.
  - Fixes in progress: M2 wider whistleblower ESLint guard, L1 cap refusals, L2 private give-back, L3 IP_HASH_SECRET ≠ AUTH_SECRET.
  - Task 5 note (QA M1): Better Auth's built-in limiter stores raw `ip|path` keys, so it must use HMAC'd custom storage or be turned off for these paths. Set `ipAddressHeaders: ["x-vercel-forwarded-for"]` and `ipv6Subnet: 64`.
- [x] Task 3b: per-network limit (HMAC'd IP, `x-vercel-forwarded-for`), per-email slow-down, known-device cookie, wider whistleblower guard; QA PASS on the second review — ADR 0022
- [ ] Privacy + cookie pages (Phase 7) must include `doc/content/privacy.md` (login-attempt line + `__Host-yg-device` cookie)
- [x] Task 6: `lib/permissions.ts`: `requireAdmin` (redirect / `forbidden()` 403), `requireAdminForRoute` (JSON 401/403), `requireCustomerAccess`, `canSeeRestricted`; fail closed; `authInterrupts` on; QA PASS (L1 fixed, L2/L3 carried) — ADR 0024
- [x] Task 8: `src/proxy.ts` + `lib/geo.ts` + `lib/session-cookie.ts`: CN geo-block + coarse `/admin` redirect; QA PASS, L1 (matcher) fixed — ADR 0026
  - [x] The rewrite loses the 403 (Next source), so the proxy returns its own 403 page; verified with `next start` + curl
  - [x] A malformed `GEO_BLOCK_ENABLED` fails closed (block CN, log once) — ADR 0026
- [x] Task 9: security headers via `src/lib/security-headers.ts` + `next.config.ts`: static CSP (inline scripts allowed; tested that nonces/SRI don't fit), HSTS, nosniff, Referrer-Policy, framing, Permissions-Policy, whistleblower no-referrer, own headers on the CN 403 — ADR 0027
- [x] Task 10: `app/blocked/page.tsx` (static, noindex, shares `BLOCKED_COPY` with the proxy's 403 page)
- [x] Task 7: `scripts/seed-admin.ts` + `src/lib/seed-admin.ts` (`npm run seed:admin`: create, or `--reset` that ends sessions, unbans, bumps device epoch, clears counters); QA PASS, L-1..L-3 fixed — ADR 0025
- [x] Task 11: design tokens, fonts (Cormorant Garamond + Inter), header/footer shell, `(site)` group, 404/403/error/global-error; QA FAIL (footer focus + contrast) → fixed, QA e2e + axe green — ADR 0028
- [x] Task 12: `/login` (posts to `/api/auth`, method=post), `/admin` placeholder guarded in layout + page, sign-out; e2e on a seeded in-memory replica set (admin login, customer real 403, visitor/forged cookie → /login, CN 403, HK/MO/TW 200); QA PASS — ADR 0029
- [x] Tests: permissions matrix, rate limiter, proxy country matrix, env validation (773 unit + 34 e2e)
- **Exit:** seeded admin logs in; `/admin` rejects non-admin on server; fake `CN` header → 403 on preview — **met locally on `next start` (2026-10-04); preview pending the Vercel account**
- [x] Phase 1 wrap-up: task-12 Lows (ADR 0030), task-5 L1 (ADR 0031), "Keep me signed in" (ADR 0032), task-5 L2 (ADR 0033); CI green; PR #9 merged to `main` 2026-10-06

## Phase 2 — Admin core ✅ (merged 2026-10-07, PR #11) — plan: `doc/phase-2-plan.md` (T1–T18)
- [x] T1: shadcn init (radix-nova, 16 ui components), tokens mapped, animation and dark mode stripped, contrast pairs tested — ADR 0034
- [x] T3: admin layout with `requireAdmin()` everywhere (static guard test), sidebar + mobile nav, loading/error — ADR 0036
- [x] T3: dashboard counts (`src/lib/admin/dashboard.ts`, uncached)
- [x] T4/T5: categories schemas, service and tree editor UI — ADR 0037, 0038
- [x] T6: areas module (service + UI) — ADR 0039
- [x] T7: product Zod schema + `publishCheck` — ADR 0040
- [x] T8: product service — ADR 0041
- [x] T9: products list + new draft, gate A L-4/L-5 fixes — ADR 0042
- [x] T10a: product edit form section (a), status card, delete, optimistic concurrency — ADR 0043
- [x] T10b: specs, variants, extra specs, public files — ADR 0044
- [x] QA gate B (T7–T10): PASS, Lows L-A to L-E recorded
- [ ] Products CRUD + Cloudinary upload/reorder
- [ ] Datasheets module (R2, signature check, ≤10 MB, attach to many, block delete in use) — ADR 0001, 0009
- [ ] Settings: column visibility, WhatsApp number, company email
- [x] T2: shared helpers (revalidate, audit, slug, constants), audit vocabulary as schema enum, `products.datasheetId` index — ADR 0035
- [ ] auditLog on every write; tag revalidation on every save — ADR 0008, 0035
- [ ] Tests: Zod schemas, file signature, auth guard on every admin action
- **Exit:** full product built by hand with images and attached datasheet

## Phase 3 — Bulk import — plan: `doc/phase-3-plan.md` (T0–T11, draft awaiting approval)
- [x] Plan drafted (2026-10-07)
- [x] Plan approved by the user (Q1–Q6: all defaults, 2026-10-07)
- [x] T0: client sheet received (local only, gitignored), studied, ADR 0054 (product page layout)
- [x] T1: case-insensitive model no. (gate B L-A) + `sourceSha256` — ADR 0055
- [x] T2: workbook reader + safety + synthetic fixture (ADR 0047 note: stricter shared zip reader)
- [x] T3: cleaner + split policies + numeric parsers — ADR 0056
- [x] T4: grouping (products/variants, shared vs per-variant, base code, slug, labels)
- [x] T5: embedded images (drawings + rels, sha256, sharp checks); QA gate A PASS
- [x] T10a / T10b: controlled import template + admin template route — ADR 0059
- [x] T6: import staging, capped read, server image upload, sweep, audit — ADR 0060
- [x] T7: plan / preview service (matching, ownership merge, diff, planHash, writes nothing) — ADR 0057
- [x] T8: commit service (batches, idempotent) — ADR 0061 → QA gate B next
- [ ] Cell cleaner, multi-line options, numeric parsers
- [ ] Row grouping by `NO.`, shared-vs-variant diffing, slug builder
- [ ] Image extraction from `xl/drawings` → Cloudinary
- [ ] Preview with per-row warnings → confirm → upsert by model no. → revalidate
- [ ] Vitest against fixture (No. 76 → AR-013A1/A2)
- **Exit:** re-import changes nothing, no duplicates

## Phase 4 — Public catalog
**Plan: [phase-4-plan.md](phase-4-plan.md) (4a = data layer + product page; 4b = mega-menu, listings, area pages, search).**
- [x] 4a P0: plan approved, answers recorded, agent files edited, `ui-reviewer` created
- [x] 4a P1: `cacheComponents` spike: off, fallback adopted (ADR 0062)
- [ ] 4a P2: `placement` + `group` on `SPEC_COLUMNS` (ADR 0054), pink = quick test
- [ ] 4a P3: `src/lib/catalog` data layer (ADR 0063) → QA gate A
- [ ] 4a P4–P7: page shell, variant switcher, gallery + lightbox, restricted block (ADR 0064) → QA gate B
- [ ] 4a P8: motion pass; P9 exit e2e + Lighthouse → QA gate C
- [ ] `lib/catalog/` cached + tagged, restricted fields excluded by projection — ADR 0002
- [ ] Mega-menu (icon strip + subcategories)
- [ ] Listing pages + URL filters, sort, pagination; area pages
- [ ] Product page: gallery/zoom, variant switch, public specs, family strip, related
- [ ] Product page layout (client, ADR 0054): pink columns (Model Name, Model No., Housing Material, Housing Color/Finish, Reflector Color, Cut-out Size, CCT) in a right-side quick-spec panel; green columns in a full spec table below. Add `placement` to `SPEC_COLUMNS`. Restricted columns stay in the dynamic block. The user called this "Phase 6"; in our roadmap the product page is Phase 4.
- [ ] Dynamic `<Suspense>` block: restricted specs + datasheet button states
- [ ] Search overlay: Atlas Search + regex fallback — ADR 0006
- [ ] Playwright: restricted-leak check, filters, search by variant model no.
- **Exit:** leak test passes; Lighthouse ≥ 90 on listing + product page

## Phase 5 — Restricted access
- [ ] Request Access form + WhatsApp link
- [ ] Admin queue: approve with expiry / reject; Resend emails
- [ ] Customers module (create, extend, reset, disable, history, filters)
- [ ] Customer login, forced password change, email reset (admin too), `/my-downloads`
- [ ] `/api/datasheet/[productId]` → R2 presigned 60 s + downloadLogs, `private, no-store`
- [ ] Cron expiry reminders (`CRON_SECRET`, `vercel.json`)
- [ ] Tests: access matrix + Playwright gated download

## Phase 6 — Home page & motion
- [ ] Hero · Quote · 7-area horizontal scroll · Capabilities collage · Leadership · Closing menu
- [ ] Lenis + ScrollTrigger, page transitions, reduced-motion fallback, mobile swipe

## Phase 7 — Content pages
- [ ] Services, OEM/ODM, R&D, About (6 sub-sections), Contact
- [ ] Terms, Privacy, Cookies, Legal; cookie banner
- [ ] Admin Site Content + Leaders editors

## Phase 8 — Whistleblower
- [ ] Landing page + named mailto
- [ ] Anonymous form → case no. + password once; secure inbox
- [ ] `lib/crypto.ts` AES-256-GCM + keyVersion — ADR 0005
- [ ] Attachments: sharp EXIF strip → R2; no IP, no analytics
- [ ] Content-free alert email; admin case inbox
- [ ] Tests: crypto round trip, no IP stored, EXIF removed

## Phase 9 — Polish
- [ ] Metadata, sitemap, JSON-LD (public fields only)
- [ ] Image/video tuning, a11y pass, mobile pass
- [ ] `/security-review` + `/code-review` against CLAUDE.md rules

## Phase 10 — Launch
- [ ] Deploy via client-linked Vercel project (no third-party deploy scripts)
- [ ] Fluid compute: check current Vercel docs for `attachDatabasePool(client)` (`@vercel/functions`); decide `waitQueueTimeoutMS` after a load test (ADR 0018)
- [ ] Real content, Vercel Firewall CN rule, domain
- [ ] Go-live: `GEO_BLOCK_ENABLED=true` in Production AND the Vercel Firewall CN rule active, both tested with a CN request (ADR 0026, QA L2 task 8)
- [ ] Test every role + China block on production
- [ ] Admin handover guide + encryption-key backup instructions

---

## Needed from user / client
- [x] Client's Arc spec sheet (.xlsx), received 2026-10-07, at `doc/reference/` (local only)
- [ ] MongoDB Atlas, Cloudinary, Cloudflare R2, Resend, Vercel accounts — before Phases 1–5
- [ ] Company email (whistleblower + request alerts)
- [ ] Logo files (SVG preferred) — Phase 1
- [ ] Categories 8–10; empty subcategories (Hanging 3rd, Track Light, Motorized)
- [ ] Open client questions: admin from China, Catalog/Knowledge footer links, WeChat icon, sheet questions (blank vs "-" the same?; comma lists like `100,150W`?; Nos. 80/81 have no model no., `95±` lumen efficiency, "Effciency" typo, lm/W tolerance, base code for `AR-10`/`AR-12` → `AR-1` (stop at a digit boundary?), does NO. restart per sheet, empty columns, public/restricted split)

## Session log
- 2026-10-07: T3 done (`4c9821f`, ADR 0056): cell cleaner, per-column split policy, filter parsers. The auto-review caught wattage count and comma-list parsing bugs during test-first steps; all fixed. The real sheet cleans with zero warnings and zero CJK. 2452 unit green. Next: T4. The user is clearing the session here.
- 2026-10-07: T2 done (`be96922`): import safety pre-check, workbook reader, synthetic fixture, real-sheet test. The auto-review found 3 zip parser-difference bypasses (decoy directory, hidden entries past `count`, name or extra-field tricks); all fixed. The shared reader also hardens the datasheet check (note on ADR 0047). 2237 unit green. Next: T3.
- 2026-10-07: T1 done (`bfbfa6f`, ADR 0055): case-insensitive model nos. via a collated unique index, shared `modelNoKey`, `sourceSha256`, `check:model-nos`. The auto-review caught a broken regex in the migration message (lost backslash); it was fixed before the commit. 2149 unit green. Next: T2.
- 2026-10-07: Phase 3 plan approved (all six defaults). T0: client sheet received (WPS file; drawing-anchored PNGs; no merges; English before Chinese; Nos. 80/81 lack model nos.), gitignored, studied into the plan. ADR 0054 logs the client's pink/green product page layout for Phase 4. Next: T1.
- 2026-10-07 — Phase 3 planned: `doc/phase-3-plan.md` (stateless preview + planHash, idempotent commit batches, images uploaded at commit with sha256 dedupe, field-ownership table, 6 questions for the user). `/find-skills`: only the installed `xlsx` skill applies. Existing subagents reused. Awaiting review; nothing built.
- 2026-10-07 — Phase 2 merged to `main` (PR #11, `b689cb7`). `phase-3` branched. Next: plan Phase 3 in plan mode.
- 2026-10-07 — Real-credential smoke PASS (R2 conditional read/copy, Cloudinary upload, sweep dry runs); PR #11 CI green. Awaiting the user's merge approval.
- 2026-10-07 — Gate E fixes (ADR 0053): sweep guard + ETag-pinned datasheet finalize. 2094 unit + 133 e2e green. Next: push, PR.
- 2026-10-07 — QA gate E PASS (Phase 2 exit) on Opus: 1 Medium (sweep guard), 1 new Low (datasheet copy race). 30 QA tests added.
- 2026-10-07 — T18 done (ADR 0052): exit e2e, provider fakes, shared sign-in. 2039 unit + 125 e2e green. Next: QA gate E.
- 2026-10-07 — T17 done (ADR 0051): orphan sweep scripts, dry-run default. 2039 unit green. Next: T18.
- 2026-10-07 — QA gate D PASS (T14–T15) on Sonnet 5.5 at the user's request: 3 Low findings recorded, 90 unit + 15 e2e QA tests added. Next: T16.
- 2026-10-07 — T15 done (ADR 0050): settings UI, guard test extended, T14 open item closed. 1933 unit green. Next: QA gate D.
- 2026-10-06 — T11b done (ADR 0046): images editor, variant image select, area uploader. The first run on Sonnet was stopped because the user wants a very good-looking UI; Opus built it. 1670 unit + 84 e2e green, build OK. Next: T12.
- 2026-10-06 — T11a done on Opus (ADR 0045, note on 0027): Cloudinary sign/verify, `saveProductImages`, `setAreaImage`, admin-only CSP; gate A L-2 and gate B L-C closed. User reminded about the R2 CORS rule. 1605 unit green, build OK. Next: T11b.
- 2026-10-06 — QA gate B PASS (T7–T10b) on Sonnet 5.5 at the user's request: no Critical, High or Medium findings; Lows L-A (model-no. case across products) to L-E recorded. 52 QA tests added. 1476 unit + 84 e2e green. Next: T11a.
- 2026-10-06 — T10b done on Opus (ADR 0044). The auto-review caught a regex with literal line breaks (Critical); it was fixed. Input `name`s are dropped so a pre-hydration submit can't put spec text in the URL. 200 variants stay responsive. 1429 unit + 80 e2e green. Next: QA gate B.
- 2026-10-06 — T10a done on Opus (ADR 0043). The auto-review found two Highs, both fixed: every save after the first did nothing (the in-flight flag stayed set through the redirect), and a stale tab could overwrite newer data. The second fix: status now changes only through publish/unpublish, and saves are checked against `updatedAt`. Six Medium fixes followed. 1364 unit + 74 e2e green. Next: T10b.
- 2026-10-06 — T9 done on Opus (ADR 0042): products list, new draft, shared move guard, e2e for products. Next: T10.
- 2026-10-06 — T8 done (ADR 0041): product service with publish gate, trackSize rule, modelNo field errors. Next: T9.
- 2026-10-06 — T7 done (ADR 0040). Auto-review caught a server-only import in the schema; constants moved to `product-constants.ts`. Next: T8.
- 2026-10-06 — QA gate A PASS (T1–T6); e2e flows for categories and areas added; audit gate P-1 and Lows L1–L5 recorded in Resume here. Next: T7.
- 2026-10-06 — T6 done on Sonnet 5.5 subagents at the user's request (ADR 0039). 1141 tests green. Next: QA gate A, then T7.
- 2026-10-06 — T3 committed (ADR 0036). Found that Next puts static admin metadata into a customer's 403 payload, so admin metadata stays static. 933 unit and 42 e2e tests green. The user ends the session here; the next session starts at T4.
- 2026-10-06 — T2 committed (ADR 0035; ADR 0008 status points to it). The auto-review raised a Medium: `"max"` could serve newly restricted columns stale. Fixed: `settings:columns` always uses `{ expire: 0 }`. 899 tests green. Next: T3.
- 2026-10-06 — T1 committed (shadcn + token mapping, ADR 0034). The user ruled that UI work always goes to the frontend subagents on Opus. A Sonnet run was stopped and an Opus run reviewed its draft, fixing 11 issues: a dead QA regex, a nearly invisible destructive focus ring, leftover motion, needless `"use client"`, raw black overlays, CRLF. 819 tests and the build are green. Next: T2.
- 2026-10-06 — Phase 2 planned in plan mode and approved (`doc/phase-2-plan.md`, T1–T18, QA gates A–E). Services verified with `npm run check:services` (committed). User decisions: direct uploads with server verification; ADR 0019 defaults. Next: T1 (shadcn init) in a fresh session.
- 2026-10-06 — CI green and PR #9 merged to `main` (`5fff0bb`) with the user's approval. Phase 1 is done. `phase-2` branched off. Next: plan Phase 2 in plan mode.
- 2026-10-06 — The next CI run failed differently: on a cold binary cache, parallel Vitest workers raced on mongodb-memory-server's download lockfile. Fixed with a Vitest `globalSetup` (`test/global-setup.ts`) that downloads the binary once before the workers start. GitHub is now handled through `gh` (PR #9 "Phase 1"). Ask the user before merging to `main`.
- 2026-10-06 — CI failed on `scripts/sync-indexes.test.ts`, because `node_modules/.cache` is missing on a fresh runner. Fixed by creating the folder with `mkdir -p` and guarding the cleanup. Next: CI green, then PR and merge.
- 2026-10-05 — Wrap-up step 3 committed, ADR 0033: the full-tree audit is blocking through `scripts/audit.mjs` with one dated allowance. QA on the wrap-up diff: PASS (L1 session-cap gap after change-password recorded in ADR 0032; L2 audit-script fail-open cases fixed). Next: push, CI, PR, merge.
- 2026-10-05 — Wrap-up step 2b committed, ADR 0032: a "Keep me signed in" checkbox, off by default, the same for admin and customers. 786 unit and 36 e2e tests green. Next: task-5 L2 (blocking audit script).
- 2026-10-05 — Wrap-up step 2 (task-5 QA L1) committed, ADR 0031: a per-user `/change-password` limit (5 per 15 min) runs before the password check; 786 unit tests green. The user accepted ADR 0030 and chose a "Keep me signed in" checkbox (default off, same for every role); that is step 2b, next.
- 2026-10-04 — Wrap-up step 1 (task-12 QA Lows) committed, ADR 0030. The auto-review widened two items: `token` is now stripped from every auth JSON body, not just sign-in (get-session and list-sessions leaked it too), and the abort check no longer swallows outgoing ECONNRESET or AbortError. It also caught the missing R2 variables in the e2e env, so the blanks are now read from `.env.example`. 779 unit and 34 e2e tests green. Next: task-5 L1.
- 2026-10-04 — Task 12 committed (/login, guarded /admin, e2e test server on in-memory MongoDB, ADR 0029). QA PASS and Phase 1 exit met locally; fixed the pre-hydration GET password leak (method=post); the stray `[auth] request failed` was a client abort (ECONNRESET). Next session: the Phase 1 wrap-up list in Resume, then merge and Phase 2.
- 2026-10-04 — Task 11 committed (design shell, ADR 0028). User picked Cormorant Garamond + Inter. QA FAIL on footer focus visibility (H1) and grey-500-on-ink contrast (H2); fixed, plus a mobile menu that closes on navigation/Escape/outside click (M1), wordmark size, footer prefetch. All 14 e2e (axe) tests and 771 unit tests green. Next: task 12.
- 2026-10-04 — Task 10 committed (/blocked page sharing BLOCKED_COPY with the proxy 403; verified live). Next: task 11 (design shell, QA).
- 2026-10-03 — Task 9 committed (security headers, ADR 0027). A browser test showed experimental SRI leaves App Router inline scripts blocked (hydration fails), so the CSP allows inline scripts; zero violations in prod, dev and on the 403 page. Next: task 10 (/blocked page).
- 2026-10-03 — Task 8 committed (proxy geo-block + coarse admin redirect, ADR 0026). The proxy returns its own 403 (a rewrite loses the status); verified live. QA PASS; L1 matcher anchoring fixed; L2/I1/I2 recorded (go-live checklist, hosting dependency). Next: task 9 (security headers).
- 2026-10-03 — Task 7 committed (seed:admin CLI, ADR 0025). QA PASS; fixed L-1 (no echo of stray args), L-2 (escape keys refused at prompt), L-3 (audit before counter clear). Atlas unreachable from this machine (SRV timeout). Next: task 8 (proxy).
- 2026-10-03 — Task 6 committed (permissions, ADR 0024). QA PASS with 13 real-session tests; L1 fixed (a missing `mustChangePassword` now fails closed). Next: task 7 (seed:admin).
- 2026-10-03 — Task 5 committed (Better Auth). QA found the /verify-password oracle, env overrides and the change-password epoch issue, all fixed. CI audit split (ADR 0015). Session ended here; resume at task 6.
- 2026-10-02 — Task 3b committed after two QA rounds (FAIL → user chose a known-device cookie → PASS); ADR 0022; privacy/cookie text drafted; ADR 0004/0020 updated.
- 2026-10-02 — Task 4 committed (Resend email sender, ADR 0021). User approved per-network limit + progressive slow-down (task 3b).
- 2026-10-02 — Task 3 committed (per-email rate limiter); QA PASS; applied QA L1 (HKDF subkey), L2 (length cap), M1 (doc: gate with consume only); ADR 0020.
- 2026-10-02 — Task 2 committed (models + index script); whistleblower schema hardened after review (neutral file names, size caps, MIME allow-list); ADR 0019.
- 2026-10-01 — Task 1 committed (db.ts, ADR 0018).
- 2026-10-01 — Auth decided: Better Auth (ADR 0017) after checking current Better Auth and Auth.js docs; installed better-auth 1.7.7 + mongodb ~7.6 (deduped with Mongoose); CLAUDE.md, ADR 0004/0011 updated. User rotated the Cloudinary secret.
- 2026-10-01 — Phase 0 merged (PR #1). Review hook re-enabled. Switched to a single `CLOUDINARY_URL` (ADR 0016) and fixed the user's next.config edit (missing comma, unrestricted Cloudinary host).
- 2026-09-30 — Read all docs, settled ADRs 0001–0012, approved roadmap, created `doc/`.
- 2026-09-30 — Installed 20 skills, rejected `code-review` (mattpocock) and `deploy-to-vercel`; created 6 subagents (ADR 0013).
- 2026-10-01 — Two QA rounds on Phase 0; all findings fixed; F4/F6 documented (ADR 0015, Phase 1 tasks); npm 12 via devEngines `warn` (ADR 0011).
- 2026-09-30 — Phase 0 built by backend-architect on `phase-0` (9 commits); ADRs 0007/0008/0010/0011 updated from installed Next 16.3.7 docs; ADR 0015 added; Auth.js found to be maintenance-only → decision pending.
- 2026-09-30 — Added the automatic review hook (ADR 0014) and moved code-reviewer into `.claude/agents/`; replaced the find-skills symlink with a copy (`core.symlinks=false`); committed the setup on `main`. Vercel deferred.
- 2026-10-07: Plan amended (ADR 0059): the client fills a template we control; T10 split into T10a (generator + parser additions) and T10b (route), both run next, before T6. Areas = one Yes/No column per area, extras = 2 numbered dropdown slots (user's choice). Next: T10a.
- 2026-10-07: QA gate A PASS after three rounds (M-1 range expansion in exceljs → sheet guard + zip rewrite; M-2 cubic parsers; L-1 CJK punctuation; L-2 case-only part names; M-3 non-canonical part names). 2659 unit green, build OK, audit ok. Next: T6.
- 2026-10-07: T5 done (`7866406`, images): own drawing/rels reader + linear XML reader, sha256 dedupe, sniff + sharp header checks, gallery/variant pictures. Found the real sheet uses `twoCellAnchor editAs="oneCell"` and Excel crops (plan corrected). `readZipPart` stricter on inflated length. 2559 unit green. Next: QA gate A.
- 2026-10-07: T4 done (grouping, `group.ts`). The auto-review caught colliding variant labels and extras wiping stored values; both fixed. Main session made `duplicate_product_no` per sheet, widened the base-code trim, added type/name tests. 2506 unit green. Next: T5 (images), then QA gate A.
- 2026-10-07: T10a done (template generator + parser additions, golden round trip). Next: T10b.
- 2026-10-07: T10b done (admin template route + tests). Next: T6.
- 2026-10-07: T6 done (ADR 0060): import staging presign + capped read, server image upload, imports sweep, audit vocabulary, import schemas; gate C L-1 closed. Server upload checks the Upload API answer instead of `inspectImage` (Admin API quota). 2802 unit green. Next: T7.
- 2026-10-07: T7 done (ADR 0057): plan / preview service (`plan.ts`, `index.ts`): case-insensitive matching, cross-product conflicts, ownership merge, Zod on every merged record, restricted filters gated, diff, planHash; preview writes nothing (tested); auto-review Medium (stale trackSize after leaving Magnetic Track) fixed; tests added for `invalid_record`, `no_slug` and the image cap. 2833 unit green. Next: T8, then QA gate B.
- 2026-10-07: T8 done (ADR 0061): commit service with per-entry hashes (hash v2), 20-product batches, conditional updates of sheet-owned paths, picture keep/destroy rule, one audit entry per writing batch; 30 new tests, 2873 unit green. Next: QA gate B.
- 2026-10-07 — T9 done (ADR 0058): admin import UI + actions. Next: T11, gate C.
- 2026-10-08: Phase 4a planning: `/find-skills` run (nothing installed), subagents reused (no new one), ADR 0054 applied in `doc/phase-4-plan.md` (P0–P9, gates A/B/C). Waiting for the user's review; no code written.
- 2026-10-08: Phase 3 merged (PR #12). Branch `phase-4`; CSP fix cherry-picked. Phase 4a plan approved with answers; `ui-reviewer` (read-only) added; agent files edited (P0). P1 spike started.
- 2026-10-08: P1 done (ADR 0062): `cacheComponents` off (customer would get 200 not 403 on /admin); `unstable_cache` + ISR + client-fetched restricted block. Plan amended. Next: P2.
