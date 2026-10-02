// The internal `loginAttempts` collection (ADR 0004): one counter per rate-limit
// key, e.g. "email:<normalised email>", that MongoDB deletes by itself when
// its window ends. The per-IP limit is Better Auth's own (ADR 0017).

import type { Types } from "mongoose";

import { mongoose } from "@/lib/db";

import { defineModel } from "./shared";

const { Schema } = mongoose;

/** A rate-limit counter as stored (and as returned by `lean()`). */
export interface LoginAttempt {
  _id: Types.ObjectId;
  /** What is being counted, e.g. "email:jane@example.com". */
  key: string;
  /** Attempts so far in the current window. */
  count: number;
  /** When the window ends; MongoDB removes the document soon after. */
  expiresAt: Date;
}

const loginAttemptSchema = new Schema<LoginAttempt>(
  {
    key: { type: String, required: true, trim: true, maxlength: 400 },
    count: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: "count must be a whole number",
      },
    },
    expiresAt: { type: Date, required: true },
  },
  // Counters are updated atomically by src/lib/rate-limit.ts (task 4); no
  // timestamps or version key needed.
  {
    collection: "loginAttempts",
    timestamps: false,
    versionKey: false,
    strict: "throw",
  },
);

// One counter per key, so concurrent attempts increment the same document.
loginAttemptSchema.index({ key: 1 }, { unique: true });
// TTL: MongoDB deletes a counter once `expiresAt` has passed. The TTL monitor
// runs about once a minute, so the rate limiter must also compare expiresAt
// itself rather than rely on the document being gone.
loginAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const LoginAttemptModel = defineModel<LoginAttempt>(
  "LoginAttempt",
  loginAttemptSchema,
);
