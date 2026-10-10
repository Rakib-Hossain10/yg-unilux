// The `accessRequests` collection: requests from visitors for datasheet
// access, sent through the public form or typed in by the admin from a
// WhatsApp chat. The admin approves (creating or extending a customer) or
// rejects them (Phase 5, ADR 0069).

import type { Types } from "mongoose";

import { mongoose } from "@/lib/db";

import {
  ACCESS_REQUEST_KINDS,
  ACCESS_REQUEST_SOURCES,
  ACCESS_REQUEST_STATUSES,
  MAX_REJECT_REASON_LENGTH,
  type AccessRequestKind,
  type AccessRequestSource,
  type AccessRequestStatus,
} from "./access-request-constants";
import { defineModel, shortText } from "./shared";

export * from "./access-request-constants";

const { Schema } = mongoose;

/** An access request as stored (and as returned by `lean()`). */
export interface AccessRequest {
  _id: Types.ObjectId;
  name: string;
  company?: string;
  country?: string;
  email: string;
  phone?: string;
  message?: string;
  /** The product page the request came from, if any. */
  product?: Types.ObjectId;
  source: AccessRequestSource;
  kind: AccessRequestKind;
  /**
   * The customer account: set on approval, or at submission when a signed-in
   * customer sent it with their own email.
   */
  user?: Types.ObjectId;
  /** When the visitor ticked the privacy consent box (form requests). */
  consentAt?: Date;
  status: AccessRequestStatus;
  /** Admin-only note on a rejection; never emailed to the requester. */
  rejectReason?: string;
  /** The admin who approved or rejected it (Better Auth user id). */
  handledBy?: Types.ObjectId;
  handledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const accessRequestSchema = new Schema<AccessRequest>(
  {
    // Contact details the visitor typed in.
    name: { ...shortText, required: true },
    company: shortText,
    country: { type: String, trim: true, maxlength: 100 },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },
    phone: { type: String, trim: true, maxlength: 40 },
    message: { type: String, trim: true, maxlength: 2000 },
    product: { type: Schema.Types.ObjectId, ref: "Product" },
    source: { type: String, required: true, enum: ACCESS_REQUEST_SOURCES },
    kind: {
      type: String,
      required: true,
      enum: ACCESS_REQUEST_KINDS,
      default: "new",
    },
    user: { type: Schema.Types.ObjectId, ref: "User" },
    consentAt: Date,

    // Review state, set by the admin.
    status: {
      type: String,
      required: true,
      enum: ACCESS_REQUEST_STATUSES,
      default: "pending",
    },
    rejectReason: {
      type: String,
      trim: true,
      maxlength: MAX_REJECT_REASON_LENGTH,
    },
    handledBy: { type: Schema.Types.ObjectId, ref: "User" },
    handledAt: Date,
  },
  { collection: "accessRequests", timestamps: true, strict: "throw" },
);

// The admin queue: requests with one status, newest first.
accessRequestSchema.index({ status: 1, createdAt: -1 });
// At most ONE pending request per email (ADR 0069): a second submission
// from the same address merges into it, and two racing submissions can't
// both insert. Handled requests are outside the partial filter, so an email
// keeps its whole history. Also serves "requests of this email".
accessRequestSchema.index(
  { email: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } },
);
// The requests linked to one customer (customer page).
accessRequestSchema.index({ user: 1, createdAt: -1 });

export const AccessRequestModel = defineModel<AccessRequest>(
  "AccessRequest",
  accessRequestSchema,
);
