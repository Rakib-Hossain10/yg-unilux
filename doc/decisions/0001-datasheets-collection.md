# 0001 — Separate `datasheets` collection
- Status: Accepted
- Date: 2026-09-30

## Context
One uploaded .xlsx can serve several products (e.g. a whole Arc family sheet). Embedding file metadata in each product would mean updating every product when the file is replaced.

## Decision
- New 11th collection `datasheets`: `storageKey`, `fileName`, `size`, `mimeType`, `updatedAt`, `uploadedBy`.
- Products hold `datasheetId` (nullable). Empty → "Datasheet coming soon".
- Replacing a file overwrites the object and updates one document; `storageKey` stays stable.
- Admin has a Datasheets list: upload, replace, see which products use it, attach to many products.
- Deleting a datasheet still referenced by products is blocked (admin must detach first).
- Download route stays `/api/datasheet/[productId]`; it resolves the file via `datasheetId`. `downloadLogs` records user, product and datasheet.

## Consequences
- Collections: products, categories, areas, users, accessRequests, downloadLogs, **datasheets**, leaders, siteContent, whistleblowerCases, auditLog.
- CLAUDE.md's `product.datasheet` embedded object is replaced by `datasheetId`.
