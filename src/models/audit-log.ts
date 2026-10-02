// The `auditLog` collection: one entry per admin write (who did what to which
// record, and when). Entries are only ever added, so there is no updatedAt.

import type { Types } from "mongoose";

import { mongoose } from "@/lib/db";

import { defineModel } from "./shared";

const { Schema } = mongoose;

/** The largest `meta` we accept, measured as JSON. Keeps entries small. */
export const MAX_AUDIT_META_BYTES = 4096;

/** What an audit entry is about, e.g. { type: "product", id: "<ObjectId>" }. */
export interface AuditTarget {
  type: string;
  /** The record's id as a string (an ObjectId in hex, or a key such as a siteContent key). */
  id: string;
}

/** An audit log entry as stored (and as returned by `lean()`). */
export interface AuditLog {
  _id: Types.ObjectId;
  /** The admin who made the change (Better Auth user id). */
  actor: Types.ObjectId;
  /** What happened, e.g. "product.update". The list is set in Phase 2. */
  action: string;
  target?: AuditTarget;
  /** Small extra details; never secrets, passwords or restricted spec values. */
  meta?: unknown;
  createdAt: Date;
}

/** True when `meta` serialises to at most MAX_AUDIT_META_BYTES of JSON. */
function isSmallMeta(meta: unknown): boolean {
  if (meta === undefined || meta === null) return true;
  const json = JSON.stringify(meta);
  return Buffer.byteLength(json ?? "", "utf8") <= MAX_AUDIT_META_BYTES;
}

// A field named `type` needs a nested schema; inline it would be read as
// "target is a String".
const targetSchema = new Schema<AuditTarget>(
  {
    type: { type: String, required: true, trim: true, maxlength: 50 },
    id: { type: String, required: true, trim: true, maxlength: 200 },
  },
  { _id: false, strict: "throw" },
);

const auditLogSchema = new Schema<AuditLog>(
  {
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    action: { type: String, required: true, trim: true, maxlength: 100 },
    target: targetSchema,
    meta: {
      type: Schema.Types.Mixed,
      validate: {
        validator: isSmallMeta,
        message: `meta must be at most ${MAX_AUDIT_META_BYTES} bytes of JSON`,
      },
    },
  },
  {
    collection: "auditLog",
    // Entries never change, so only createdAt.
    timestamps: { createdAt: true, updatedAt: false },
    strict: "throw",
  },
);

// The admin activity list, newest first.
auditLogSchema.index({ createdAt: -1 });

export const AuditLogModel = defineModel<AuditLog>("AuditLog", auditLogSchema);
