# 0005 — Whistleblower encryption
- Status: Accepted
- Date: 2026-09-30

## Context
Anonymous report text and messages must be encrypted at rest; attachments must not leak metadata.

## Decision
- AES-256-GCM (Node `crypto`), random 12-byte IV per value, auth tag stored with ciphertext.
- Key in env `WHISTLEBLOWER_ENC_KEY` (32 bytes, base64). Every encrypted record stores `keyVersion`.
- Rotation: keep old keys available (e.g. `WHISTLEBLOWER_ENC_KEYS_OLD` as `version:key` list) for decryption; a script re-encrypts records to the current version.
- Image attachments pass through `sharp` (re-encode, metadata stripped incl. GPS) before upload to private R2.
- No IP stored, no analytics, no IP rate limiting on these routes. Alert email says only "New report received" + admin link.

## Consequences
- **Losing the key makes the data permanently unreadable.** The key must be backed up outside Vercel (handover doc, Phase 10).
- Encrypted fields cannot be searched in the database; admin inbox filters by status/date only.
