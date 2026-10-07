# 0053 — Sweep mass-delete guard and ETag-pinned datasheet finalize

Status: Accepted (Phase 2, QA gate E fixes M-1, L-1). Amends 0047 and 0051.

## Decision
- `--apply` on a sweep is refused when the reference set is empty, or the selection exceeds 20% of listed Cloudinary assets (or 100 objects for `incoming/`), unless `--max-delete N` is given and the selection is at most N (`checkMassDelete`, pure). N: positive integer, separate argument, repeated or `=` forms rejected. Scripts print database, cloud and bucket names (never URI/credentials) first. Dry run stays the default.
- `finalizeDatasheet` pins one version of the upload by the ETag from `headObject`: the GET uses `If-Match`, the copy uses `CopySourceIfMatch` (both, to close an A-B-A swap). A 412 becomes `StorageConditionError` -> generic `UPLOAD_FAILED`, nothing stored, incoming deleted. A missing ETag is refused. `copyObject` requires `ifMatch`.

## Consequences
- Residual: single-part ETag is an MD5; an attacker holding the 5-minute presigned PUT could in theory craft an MD5 collision. They already hold the admin's upload capability; accepted. PutObject of the checked buffer would remove it.
- Per-environment Cloudinary folder prefix is still open (touches signing and data paths).
- Real-credential smoke must confirm R2 honours `If-Match` on GET and `x-amz-copy-source-if-match` on copy (only the fake has exercised them).
