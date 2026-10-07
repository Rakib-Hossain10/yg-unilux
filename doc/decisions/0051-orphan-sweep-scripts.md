# 0051 — Orphan sweep scripts

Status: Accepted (Phase 2, T17)

## Decision
- Selection is pure (`src/lib/orphan-sweep.ts`); the three CLIs list, select, then delete only what was selected. Dry run is the default; `--apply` is the only flag and any other argument is rejected.
- `npm run sweep:incoming`: R2 `incoming/` objects strictly older than 24 h (matches the presign TTL). Unknown age is kept.
- `npm run sweep:cloudinary`: `yg/products/` and `yg/areas/` assets that match the server-built public-id pattern, are referenced by no product image, variant image or area image, and are older than 24 h. The DB is read before Cloudinary is listed. Other folders (leaders) are not swept.
- `npm run report:datasheets`: list-only report of `datasheets/` R2 keys that no `datasheets` document references (1 h grace). It cannot delete; deleting needs a separate decision.
- R2 only through `src/lib/storage.ts`; `listImages` added to `src/lib/cloudinary.ts`. Output holds keys, public ids and counts only. One failed delete does not stop the run; exit 1 if any failed.

## Consequences
- If the DB read wrongly returned nothing, assets over 24 h old would look unreferenced. Manual and dry-run by default; do NOT schedule `--apply` in cron without a mass-delete guard (refuse above some orphan share).
- Not run against real R2/Cloudinary yet; pagination of the list functions is not unit tested.
