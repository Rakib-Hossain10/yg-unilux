// The internal `loginAttempts` collection (ADR 0004, 0020, 0022): one counter
// per rate-limit key, e.g. "email-reset:<HMAC of the email>", that MongoDB
// deletes by itself when it expires. Keys never hold a plain email or IP.

import type { Types } from "mongoose";

import { mongoose } from "@/lib/db";

import { defineModel } from "./shared";

const { Schema } = mongoose;

/** A rate-limit counter as stored (and as returned by `lean()`). */
export interface LoginAttempt {
  _id: Types.ObjectId;
  /**
   * What is being counted: "<namespace>:<64 hex HMAC>", or for a per-network
   * counter "email-ip-login:<email HMAC>.<network HMAC>". Never a plain email or IP.
   */
  key: string;
  /** Attempts so far in the current window. */
  count: number;
  /** When the window ends; MongoDB removes the document soon after. */
  expiresAt: Date;
  /** Slow-down counters only: the earliest time the next attempt is allowed. */
  nextAllowedAt?: Date;
  /** Whether the most recent attempt was let through (set by every counter). */
  lastAttemptAllowed?: boolean;
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
    // nextAllowedAt: slow-down counters only. lastAttemptAllowed: every counter
    // stores its latest decision (src/lib/rate-limit.ts).
    nextAllowedAt: { type: Date },
    lastAttemptAllowed: { type: Boolean },
  },
  // Counters are updated atomically by src/lib/rate-limit.ts and
  // src/lib/sign-in-limit.ts; no
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
