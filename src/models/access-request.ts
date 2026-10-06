// The `accessRequests` collection: requests from visitors for datasheet
// access, sent through the form or WhatsApp. The admin approves (creating a
// customer account) or rejects them in Phase 5.

import type { Types } from "mongoose";

import { mongoose } from "@/lib/db";

import { defineModel, shortText } from "./shared";

const { Schema } = mongoose;

export const ACCESS_REQUEST_SOURCES = ["form", "whatsapp"] as const;
export type AccessRequestSource = (typeof ACCESS_REQUEST_SOURCES)[number];

export const ACCESS_REQUEST_STATUSES = [
  "pending",
  "approved",
  "rejected",
] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

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
  status: AccessRequestStatus;
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

    // Review state, set by the admin.
    status: {
      type: String,
      required: true,
      enum: ACCESS_REQUEST_STATUSES,
      default: "pending",
    },
    handledBy: { type: Schema.Types.ObjectId, ref: "User" },
    handledAt: Date,
  },
  { collection: "accessRequests", timestamps: true, strict: "throw" },
);

// The admin queue: requests with one status, newest first.
accessRequestSchema.index({ status: 1, createdAt: -1 });

export const AccessRequestModel = defineModel<AccessRequest>(
  "AccessRequest",
  accessRequestSchema,
);
