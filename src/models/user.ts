// A READ-ONLY view of the `users` collection, which Better Auth owns and writes
// (ADR 0017). Use it for admin listings and joins only. Every write must go
// through Better Auth (src/lib/auth.ts), so writes through this model throw.

import type { Types } from "mongoose";

import { mongoose } from "@/lib/db";

import { defineModel } from "./shared";

const { Schema } = mongoose;

/*
 * Field names and storage types mirror Better Auth 1.7.7 with its MongoDB
 * adapter (checked in node_modules):
 * - core user fields: @better-auth/core/dist/db/get-tables.mjs (user table);
 * - role / banned / banReason / banExpires: better-auth/dist/plugins/admin/schema.mjs;
 * - `_id` is a BSON ObjectId (the adapter maps Better Auth's `id` to `_id` and
 *   converts the string id to an ObjectId on insert), so other collections
 *   store user ids as ObjectId too;
 * - dates are BSON Dates and booleans are booleans (the adapter keeps both).
 * mustChangePassword, accessExpiresAt, company, country, deviceEpoch and the
 * Phase 5 dates (expiryReminderFor, invitedAt, inviteExpiresAt,
 * passwordSetAt) are our own `additionalFields`, configured in
 * src/lib/auth.ts and written only by src/lib/account-writes.ts.
 *
 * No indexes are declared here: Better Auth's indexes are created by
 * syncBetterAuthIndexes() (src/lib/db-indexes.ts), and this model is skipped
 * by the Mongoose index sync.
 */

/** A user as stored by Better Auth (and as returned by `lean()`). */
export interface User {
  _id: Types.ObjectId;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  /**
   * "admin" or "customer". The admin plugin stores several roles as one
   * comma-joined string ("admin,customer"), so treat it as a list when checking.
   */
  role?: string | null;
  /** Blocked by the admin (Better Auth's ban); a banned user cannot sign in. */
  banned?: boolean | null;
  banReason?: string | null;
  banExpires?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Forces a password change at next sign-in (new accounts start true). */
  mustChangePassword?: boolean | null;
  /** End of datasheet access; null = no expiry. Login still works after it. */
  accessExpiresAt?: Date | null;
  company?: string | null;
  country?: string | null;
  /**
   * Known-device token epoch (ADR 0022 QA L1). Bumped on a password reset, an
   * admin password change and a ban, which invalidates every device token
   * issued before. Missing = 0. Never sent to the browser.
   */
  deviceEpoch?: number | null;
  /** The accessExpiresAt value the last 7-day reminder was sent for (cron). */
  expiryReminderFor?: Date | null;
  /** When the latest invite link was made; null/missing = never invited. */
  invitedAt?: Date | null;
  /** When that invite link stops working (invitedAt + 72 h). */
  inviteExpiresAt?: Date | null;
  /** When the user last chose their own password (reset, invite or change). */
  passwordSetAt?: Date | null;
}

/** Thrown when code tries to write to Better Auth's users through Mongoose. */
export class ReadOnlyModelError extends Error {
  override readonly name = "ReadOnlyModelError";

  constructor(operation: string) {
    super(
      `The users collection is owned by Better Auth and is read-only through Mongoose (${operation}). Use src/lib/auth.ts instead.`,
    );
  }
}

const userSchema = new Schema<User>(
  {
    // Better Auth core fields.
    name: String,
    email: String,
    emailVerified: Boolean,
    image: String,
    createdAt: Date,
    updatedAt: Date,
    // Admin plugin fields.
    role: String,
    banned: Boolean,
    banReason: String,
    banExpires: Date,
    // Our additional fields.
    mustChangePassword: Boolean,
    accessExpiresAt: Date,
    company: String,
    country: String,
    deviceEpoch: Number,
    expiryReminderFor: Date,
    invitedAt: Date,
    inviteExpiresAt: Date,
    passwordSetAt: Date,
  },
  {
    collection: "users",
    // Better Auth sets createdAt/updatedAt itself and stores no `__v`.
    timestamps: false,
    versionKey: false,
  },
);

/*
 * Write guard. Each pre-hook below throws before Mongoose sends anything to
 * MongoDB, covering every Mongoose write path:
 * - save: doc.save(), Model.create(), Model.insertOne(), Model.bulkSave();
 * - updateOne / deleteOne on a document and as queries;
 * - the other update, replace and delete queries;
 * - insertMany, bulkWrite and createCollection on the model.
 * This stops our own code from writing by mistake. It is not a security
 * boundary: `{ middleware: false }` or the raw `Model.collection` skip hooks.
 */
function refuse(operation: string): () => never {
  return () => {
    throw new ReadOnlyModelError(operation);
  };
}

userSchema.pre("save", refuse("save"));
userSchema.pre(
  "updateOne",
  { document: true, query: true },
  refuse("updateOne"),
);
userSchema.pre(
  "deleteOne",
  { document: true, query: true },
  refuse("deleteOne"),
);
for (const operation of [
  "updateMany",
  "replaceOne",
  "deleteMany",
  "findOneAndUpdate",
  "findOneAndReplace",
  "findOneAndDelete",
] as const) {
  userSchema.pre(operation, refuse(operation));
}
userSchema.pre("insertMany", refuse("insertMany"));
userSchema.pre("bulkWrite", refuse("bulkWrite"));
userSchema.pre("createCollection", refuse("createCollection"));

export const UserModel = defineModel<User>("User", userSchema);
