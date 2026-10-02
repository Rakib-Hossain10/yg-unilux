// The `siteContent` collection: editable page content AND admin settings, one
// document per key (e.g. "home.quote", "settings.columnVisibility",
// "settings.whatsappNumber", "settings.companyEmail").

import type { Types } from "mongoose";

import { mongoose } from "@/lib/db";

import { defineModel } from "./shared";

const { Schema } = mongoose;

/*
 * Settings live here on purpose, so the project stays within its 11
 * collections (CLAUDE.md). `value` has a different shape per key; the app
 * validates each key's value with its own Zod schema when it reads or writes
 * it (Phase 2 / Phase 7). The database only checks that a value is present.
 */

/** Dotted camelCase keys: "home.quote", "settings.columnVisibility". */
export const SITE_CONTENT_KEY_PATTERN =
  /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;

/** A site content entry as stored (and as returned by `lean()`). */
export interface SiteContent {
  _id: Types.ObjectId;
  key: string;
  /** Any JSON value; its shape depends on `key` and is checked by the app. */
  value: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const siteContentSchema = new Schema<SiteContent>(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      match: SITE_CONTENT_KEY_PATTERN,
    },
    value: { type: Schema.Types.Mixed, required: true },
  },
  {
    collection: "siteContent",
    timestamps: true,
    strict: "throw",
    // Keep empty objects: a setting may legitimately be `{}`, and Mongoose
    // would otherwise drop it (and then fail `required`).
    minimize: false,
  },
);

// One document per key.
siteContentSchema.index({ key: 1 }, { unique: true });

export const SiteContentModel = defineModel<SiteContent>(
  "SiteContent",
  siteContentSchema,
);
