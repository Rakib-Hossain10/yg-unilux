// Zod schemas for the admin settings stored in `siteContent` (ADR 0049):
// column visibility (28 spec columns, public or restricted), the WhatsApp
// number and the company email. Pure (no server-only), shared by the form
// resolver and re-parsed by src/lib/admin/settings.ts.

import { z } from "zod";

import {
  SPEC_COLUMNS,
  SPEC_KEYS,
  type SpecKey,
  type SpecVisibility,
} from "@/models/spec-columns";

/** The siteContent keys the settings live under. */
export const SETTINGS_KEYS = {
  columnVisibility: "settings.columnVisibility",
  whatsappNumber: "settings.whatsappNumber",
  companyEmail: "settings.companyEmail",
} as const;

export const SPEC_VISIBILITIES = ["public", "restricted"] as const;

export type ColumnVisibility = Record<SpecKey, SpecVisibility>;

/** The visibility of every column before the admin changes anything. */
export const DEFAULT_COLUMN_VISIBILITY: Readonly<ColumnVisibility> =
  Object.freeze(
    Object.fromEntries(
      SPEC_COLUMNS.map((column) => [column.key, column.defaultVisibility]),
    ) as ColumnVisibility,
  );

const visibility = z.enum(SPEC_VISIBILITIES, {
  error: "Choose public or restricted",
});

/**
 * The column visibility form: all 28 keys, no extras, so a typo or a missing
 * column is an error instead of a silently public column.
 */
export const columnVisibilitySchema = z.strictObject(
  Object.fromEntries(SPEC_KEYS.map((key) => [key, visibility])) as Record<
    SpecKey,
    typeof visibility
  >,
);
export type ColumnVisibilityInput = z.output<typeof columnVisibilitySchema>;

/**
 * Reads a STORED column visibility value. Fails closed: a missing or unknown
 * entry is restricted, never public, so a damaged document cannot expose a
 * column. A completely missing document is handled by the caller (defaults).
 */
export function parseStoredColumnVisibility(value: unknown): ColumnVisibility {
  const raw =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    SPEC_KEYS.map((key) => [
      key,
      raw[key] === "public" ? "public" : "restricted",
    ]),
  ) as ColumnVisibility;
}

/** E.164 allows at most 15 digits; below 8 is not a dialable number. */
export const WHATSAPP_MIN_DIGITS = 8;
export const WHATSAPP_MAX_DIGITS = 15;

/**
 * Turns what an admin types ("+852 1234-5678", "(852) 12345678", "00852...")
 * into digits only, or null for "". The `wa.me` link wants digits with the
 * country code and no "+" or "00".
 */
export const whatsappNumberSchema = z
  .string()
  .trim()
  .max(40, "At most 40 characters")
  .transform((raw, ctx) => {
    if (raw === "") return null;
    if (!/^\+?[\d\s().-]+$/.test(raw)) {
      ctx.addIssue({
        code: "custom",
        message: "Use digits only, with the country code (e.g. +852 1234 5678)",
      });
      return z.NEVER;
    }
    const digits = raw.replace(/\D/g, "").replace(/^00/, "");
    if (
      digits.length < WHATSAPP_MIN_DIGITS ||
      digits.length > WHATSAPP_MAX_DIGITS ||
      digits.startsWith("0")
    ) {
      ctx.addIssue({
        code: "custom",
        message: `Enter ${WHATSAPP_MIN_DIGITS} to ${WHATSAPP_MAX_DIGITS} digits including the country code`,
      });
      return z.NEVER;
    }
    return digits;
  });
export type WhatsappNumberInput = z.output<typeof whatsappNumberSchema>;

/** Stored whatsapp value: digits or null. */
export const storedWhatsappSchema = z
  .string()
  .regex(/^[1-9]\d{7,14}$/)
  .nullable();

/** The company email shown on the site; "" clears it (the env value is used). */
export const companyEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "At most 254 characters")
  .transform((raw, ctx) => {
    if (raw === "") return null;
    if (!z.email().safeParse(raw).success) {
      ctx.addIssue({ code: "custom", message: "Enter a valid email address" });
      return z.NEVER;
    }
    return raw;
  });
export type CompanyEmailInput = z.output<typeof companyEmailSchema>;

export const storedEmailSchema = z.email().nullable();
