// Records one auditLog entry per admin write: who (the admin's user id) did
// what (a fixed `<entity>.<verb>` action) to which record. Admin services call
// recordAudit() after a successful write; input is Zod-checked before saving.

import "server-only";

import { z } from "zod";

import {
  ADMIN_AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  type AdminAuditAction,
  type AuditTargetType,
} from "@/models/audit-actions";
import { AuditLogModel, MAX_AUDIT_META_BYTES } from "@/models/audit-log";

import { connectDb } from "./db";

export {
  ADMIN_AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  type AdminAuditAction,
  type AuditTargetType,
};

/*
 * META POLICY. `meta` holds only ids, changed field NAMES and counts, e.g.
 * { fields: ["name", "slug"], variantCount: 3, productIds: ["..."] }.
 * Never field values: no names or descriptions, no WhatsApp number or email,
 * no restricted spec values (ADR 0002), no file names typed by a person, no
 * secrets, IPs or user agents. The audit log is read by the admin panel and
 * kept indefinitely, so anything put here is effectively published to every
 * future admin and every backup.
 *
 * The schema below enforces the SHAPE of that policy (a flat object of short
 * scalars or scalar lists, at most 4096 bytes of JSON); it cannot tell an id
 * from a phone number, so each service is responsible for what it passes.
 */

/** A meta value: a scalar or a list of short scalars. No nested objects. */
export type AuditMetaValue =
  string | number | boolean | null | readonly (string | number)[];

/** What recordAudit() takes. See the meta policy above. */
export interface AuditInput {
  /** The signed-in admin's user id (Better Auth, an ObjectId in hex). */
  actorId: string;
  action: AdminAuditAction;
  /** The record changed; `type` must equal the action's first word. */
  target: { type: AuditTargetType; id: string };
  meta?: Readonly<Record<string, AuditMetaValue>>;
}

/** recordAudit() refused the input. Lists the bad paths, never the values. */
export class AuditInputError extends Error {
  override readonly name = "AuditInputError";

  constructor(readonly paths: readonly string[]) {
    super(`Invalid audit entry (${paths.join(", ")})`);
  }
}

/* A 24-character hex ObjectId. Stricter than Mongoose, which would also cast
   any 12-character string to an ObjectId. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/* A siteContent settings key, e.g. "settings.columnVisibility" (ADR 0019).
   Key-shaped on purpose: a phone number or email can never pass as an id. */
const SETTINGS_KEY = /^settings\.[a-z][A-Za-z]{0,63}$/;

/* Caps that keep a single entry small even before the byte check. */
const MAX_META_KEYS = 50;
const MAX_META_LIST = 200;
const MAX_META_STRING = 200;

const metaScalar = z.union([z.string().max(MAX_META_STRING), z.number()]);
const metaValue = z.union([
  metaScalar,
  z.boolean(),
  z.null(),
  z.array(metaScalar).max(MAX_META_LIST),
]);

const metaSchema = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), metaValue)
  .refine((meta) => Object.keys(meta).length <= MAX_META_KEYS, {
    message: `at most ${MAX_META_KEYS} keys`,
  })
  // Same measure as the auditLog schema: UTF-8 bytes of the JSON.
  .refine(
    (meta) =>
      Buffer.byteLength(JSON.stringify(meta), "utf8") <= MAX_AUDIT_META_BYTES,
    { message: `at most ${MAX_AUDIT_META_BYTES} bytes of JSON` },
  );

const auditInputSchema = z
  .strictObject({
    actorId: z.string().regex(OBJECT_ID_HEX),
    action: z.enum(ADMIN_AUDIT_ACTIONS),
    target: z.strictObject({
      type: z.enum(AUDIT_TARGET_TYPES),
      id: z.string().trim().min(1).max(200),
    }),
    meta: metaSchema.optional(),
  })
  .superRefine((entry, ctx) => {
    // "product.datasheet.attach" is about a product, "settings.*" about settings.
    if (entry.action.split(".")[0] !== entry.target.type) {
      ctx.addIssue({
        code: "custom",
        path: ["target", "type"],
        message: "target type must match the action",
      });
    }
    // Records are addressed by ObjectId; settings by their siteContent key.
    const idPattern =
      entry.target.type === "settings" ? SETTINGS_KEY : OBJECT_ID_HEX;
    if (!idPattern.test(entry.target.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["target", "id"],
        message: "target id must be an ObjectId or a settings key",
      });
    }
  });

/**
 * Validates and saves one audit entry, returning its id. Throws
 * AuditInputError for bad input (nothing is written); database errors pass
 * through.
 *
 * Called AFTER the write it describes, so it is not atomic with it (ADR 0035
 * draft): if this throws, the change is saved but unaudited, and the caller
 * must log the failure and report an error to the admin.
 */
export async function recordAudit(input: AuditInput): Promise<{ id: string }> {
  const parsed = auditInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new AuditInputError(
      parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"),
    );
  }

  const { actorId, action, target, meta } = parsed.data;
  await connectDb();
  const entry = await AuditLogModel.create({
    actor: actorId,
    action,
    target,
    ...(meta === undefined ? {} : { meta }),
  });
  return { id: entry._id.toHexString() };
}
