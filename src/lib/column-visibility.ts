// Which spec columns are restricted (ADR 0049), read from `siteContent`. Not
// an admin service: the cached catalog reads it to project restricted
// columns away (ADR 0002), so it lives outside src/lib/admin and never
// reaches the session, headers or the admin actor check (ADR 0073). The
// admin's own settings screen reads it through getAdminSettings(actor).

import "server-only";

import {
  DEFAULT_COLUMN_VISIBILITY,
  parseStoredColumnVisibility,
  SETTINGS_KEYS,
  type ColumnVisibility,
} from "@/lib/schemas/settings";
import { SiteContentModel } from "@/models";

import { connectDb } from "./db";

/**
 * The stored setting (`undefined` when never saved) and the visibility it
 * means: the defaults when never saved, else parsed (fails closed). The one
 * place that decides the fallback, for the catalog and the settings save.
 */
export async function readColumnVisibilitySetting(): Promise<{
  stored: unknown;
  visibility: ColumnVisibility;
}> {
  await connectDb();
  const doc = await SiteContentModel.findOne(
    { key: SETTINGS_KEYS.columnVisibility },
    { value: 1 },
  ).lean<{ value: unknown } | null>();
  const stored = doc ? doc.value : undefined;
  return {
    stored,
    visibility:
      stored === undefined
        ? { ...DEFAULT_COLUMN_VISIBILITY }
        : parseStoredColumnVisibility(stored),
  };
}

/** Column visibility as stored; defaults when never saved; fails closed. */
export async function getColumnVisibility(): Promise<ColumnVisibility> {
  return (await readColumnVisibilitySetting()).visibility;
}
