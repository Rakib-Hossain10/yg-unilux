// Admin services for settings kept in `siteContent` (ADR 0049): which spec
// columns are restricted, the WhatsApp number and the company email. Each
// write audits and returns its cache tags. The caller (a Server Action) has
// already run requireAdmin() and passes the session's user id as `actorId`.

import "server-only";

import { type AuditInput } from "@/lib/audit";
import { connectDb } from "@/lib/db";
import { CATALOG_TAGS, type CatalogTag } from "@/lib/revalidate";
import {
  columnVisibilitySchema,
  companyEmailSchema,
  DEFAULT_COLUMN_VISIBILITY,
  parseStoredColumnVisibility,
  SETTINGS_KEYS,
  storedEmailSchema,
  storedWhatsappSchema,
  whatsappNumberSchema,
  type ColumnVisibility,
} from "@/lib/schemas/settings";
import { ProductModel, SiteContentModel } from "@/models";
import {
  FILTER_KEY_BY_SPEC,
  SPEC_KEYS,
  type SpecKey,
} from "@/models/spec-columns";

import {
  assertActorId,
  auditAndFinish,
  invalidInput,
  unchanged,
  type ServiceResult,
} from "./write-result";

/* Re-exported from the pure spec-columns module (the importer shares it) for
 * existing callers. */
export { FILTER_KEY_BY_SPEC };

const COLUMN_TAGS: CatalogTag[] = [
  CATALOG_TAGS.settingsColumns,
  CATALOG_TAGS.products,
];

export const SETTINGS_WRITE_FAILED =
  "The products could not be updated for the new column settings. Save again to retry.";

async function readSetting(key: string): Promise<unknown> {
  await connectDb();
  const doc = await SiteContentModel.findOne({ key }, { value: 1 }).lean<{
    value: unknown;
  } | null>();
  return doc ? doc.value : undefined;
}

async function writeSetting(key: string, value: unknown): Promise<void> {
  await connectDb();
  // `value` is required (Mixed rejects null), so "cleared" means no document;
  // reads already treat a missing document as null.
  if (value === null) {
    await SiteContentModel.deleteOne({ key });
    return;
  }
  await SiteContentModel.updateOne(
    { key },
    { $set: { value }, $setOnInsert: { key } },
    { upsert: true, runValidators: true },
  );
}

// ---------------------------------------------------------------------------
// Reads (admin only, never cached)
// ---------------------------------------------------------------------------

export interface AdminSettings {
  columnVisibility: ColumnVisibility;
  whatsappNumber: string | null;
  companyEmail: string | null;
}

/** Column visibility as stored; defaults when never saved; fails closed. */
export async function getColumnVisibility(): Promise<ColumnVisibility> {
  const stored = await readSetting(SETTINGS_KEYS.columnVisibility);
  return stored === undefined
    ? { ...DEFAULT_COLUMN_VISIBILITY }
    : parseStoredColumnVisibility(stored);
}

/** Every setting for the admin form. */
export async function getAdminSettings(): Promise<AdminSettings> {
  const [columnVisibility, whatsapp, email] = await Promise.all([
    getColumnVisibility(),
    readSetting(SETTINGS_KEYS.whatsappNumber),
    readSetting(SETTINGS_KEYS.companyEmail),
  ]);
  const w = storedWhatsappSchema.safeParse(whatsapp ?? null);
  const e = storedEmailSchema.safeParse(email ?? null);
  return {
    columnVisibility,
    whatsappNumber: w.success ? w.data : null,
    companyEmail: e.success ? e.data : null,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface SaveColumnVisibilityResult {
  columnVisibility: ColumnVisibility;
  /** Columns that were public and are now restricted. */
  newlyRestricted: SpecKey[];
  /** Columns that were restricted and are now public. */
  newlyPublic: SpecKey[];
}

/**
 * Saves which columns are restricted. Returns `settings:columns` (expired at
 * once by the route helper) and `products`. A column newly made restricted
 * also loses its filter numbers on every product (see FILTER_KEY_BY_SPEC).
 * The setting is saved FIRST, so the restriction is live even if the cleanup
 * then fails; that failure still returns the tags.
 */
export async function saveColumnVisibility(
  actorId: string,
  input: unknown,
): Promise<ServiceResult<SaveColumnVisibilityResult>> {
  assertActorId(actorId);
  const parsed = columnVisibilitySchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const next: ColumnVisibility = parsed.data;

  const stored = await readSetting(SETTINGS_KEYS.columnVisibility);
  const before =
    stored === undefined
      ? { ...DEFAULT_COLUMN_VISIBILITY }
      : parseStoredColumnVisibility(stored);
  const newlyRestricted = SPEC_KEYS.filter(
    (key) => before[key] === "public" && next[key] === "restricted",
  );
  const newlyPublic = SPEC_KEYS.filter(
    (key) => before[key] === "restricted" && next[key] === "public",
  );
  const changed =
    stored === undefined ||
    newlyRestricted.length > 0 ||
    newlyPublic.length > 0;
  const data = { columnVisibility: next, newlyRestricted, newlyPublic };

  if (changed) await writeSetting(SETTINGS_KEYS.columnVisibility, next);

  // Cleanup covers ALL restricted columns and is idempotent, so a retry after
  // a failed cleanup (the setting is already saved) still repairs products,
  // even though the retry itself sees no change.
  let cleaned: number;
  try {
    cleaned = await clearRestrictedFilters(next);
  } catch (error) {
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`[admin] column filter cleanup failed: ${kind}`);
    if (changed) {
      // The setting change is saved, so it is audited even though the call fails.
      await auditAndFinish(columnAudit(actorId, data, next, true), data, []);
    }
    return {
      ok: false,
      errors: { formErrors: [SETTINGS_WRITE_FAILED], fieldErrors: {} },
      tags: COLUMN_TAGS,
    };
  }

  if (!changed)
    return cleaned > 0
      ? { ok: true, data, tags: COLUMN_TAGS }
      : unchanged(data);

  return auditAndFinish(
    columnAudit(actorId, data, next, false),
    data,
    COLUMN_TAGS,
  );
}

function columnAudit(
  actorId: string,
  data: SaveColumnVisibilityResult,
  next: ColumnVisibility,
  cleanupFailed: boolean,
): AuditInput {
  return {
    actorId,
    action: "settings.columns.update",
    target: { type: "settings", id: SETTINGS_KEYS.columnVisibility },
    // Column keys only (a fixed vocabulary), never other values.
    meta: {
      restricted: data.newlyRestricted,
      madePublic: data.newlyPublic,
      restrictedCount: SPEC_KEYS.filter((k) => next[k] === "restricted").length,
      cleanupFailed,
    },
  };
}

/**
 * Removes the filter numbers of every restricted column from the products
 * that have them. Touches only matching products and leaves `updatedAt`
 * alone (ADR 0043 uses it for edit conflicts). Returns how many changed.
 */
async function clearRestrictedFilters(next: ColumnVisibility): Promise<number> {
  const paths = SPEC_KEYS.filter((key) => next[key] === "restricted").flatMap(
    (key) => {
      const filter = FILTER_KEY_BY_SPEC[key];
      return filter === undefined ? [] : [`filters.${filter}`];
    },
  );
  if (paths.length === 0) return 0;
  const result = await ProductModel.updateMany(
    { $or: paths.map((path) => ({ [path]: { $exists: true } })) },
    { $unset: Object.fromEntries(paths.map((path) => [path, ""])) },
    { timestamps: false },
  );
  return result.modifiedCount;
}

/**
 * Saves the WhatsApp number as digits ("" clears it). No cache tags: no
 * cached catalog data holds it. The audit meta says only whether it is set.
 */
export async function saveWhatsappNumber(
  actorId: string,
  input: unknown,
): Promise<ServiceResult<{ whatsappNumber: string | null }>> {
  assertActorId(actorId);
  const parsed = whatsappNumberSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const whatsappNumber = parsed.data;

  const stored = await readSetting(SETTINGS_KEYS.whatsappNumber);
  const current = storedWhatsappSchema.safeParse(stored ?? null);
  if (current.success && current.data === whatsappNumber)
    return unchanged({ whatsappNumber });

  await writeSetting(SETTINGS_KEYS.whatsappNumber, whatsappNumber);
  return auditAndFinish(
    {
      actorId,
      action: "settings.whatsapp.update",
      target: { type: "settings", id: SETTINGS_KEYS.whatsappNumber },
      meta: { isSet: whatsappNumber !== null },
    },
    { whatsappNumber },
    [],
  );
}

/** Saves the company email ("" clears it). Audit meta: only whether it is set. */
export async function saveCompanyEmail(
  actorId: string,
  input: unknown,
): Promise<ServiceResult<{ companyEmail: string | null }>> {
  assertActorId(actorId);
  const parsed = companyEmailSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const companyEmail = parsed.data;

  const stored = await readSetting(SETTINGS_KEYS.companyEmail);
  const current = storedEmailSchema.safeParse(stored ?? null);
  if (current.success && current.data === companyEmail)
    return unchanged({ companyEmail });

  await writeSetting(SETTINGS_KEYS.companyEmail, companyEmail);
  return auditAndFinish(
    {
      actorId,
      action: "settings.email.update",
      target: { type: "settings", id: SETTINGS_KEYS.companyEmail },
      meta: { isSet: companyEmail !== null },
    },
    { companyEmail },
    [],
  );
}
