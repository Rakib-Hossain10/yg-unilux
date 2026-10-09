// Public, read-only access to the WhatsApp number from the admin settings
// (ADR 0049/0050), for pages that offer a "Message us on WhatsApp" link
// (/reset-password's expired view now, /request-access in P6). Uncached: its
// callers render per request anyway, and a cached copy would need its own
// invalidation when the admin changes the number.
// Also the company alert address (setting, then COMPANY_EMAIL) for the
// access-request alert and the expiry digest: server-side only, never
// rendered to the browser.

import "server-only";

import {
  SETTINGS_KEYS,
  storedEmailSchema,
  storedWhatsappSchema,
} from "@/lib/schemas/settings";
import { SiteContentModel } from "@/models";

import { connectDb } from "./db";
import { env } from "./env";

/**
 * The WhatsApp number as digits (e.g. "85291234567"), or null when it is
 * unset, malformed or can't be read. A database failure only hides the
 * WhatsApp link (logged by type), so the page around it still renders.
 */
export async function getWhatsappNumber(): Promise<string | null> {
  try {
    await connectDb();
    const doc = await SiteContentModel.findOne(
      { key: SETTINGS_KEYS.whatsappNumber },
      { value: 1 },
    ).lean<{ value: unknown } | null>();
    const parsed = storedWhatsappSchema.safeParse(doc?.value ?? null);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    console.error(
      `[contact-settings] WhatsApp number not read: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    return null;
  }
}

/** The wa.me link for a stored number (digits only, checked again). */
export function whatsappLink(digits: string): string | null {
  return /^[1-9]\d{7,14}$/.test(digits) ? `https://wa.me/${digits}` : null;
}

/**
 * Where company alerts go (new access requests, the expiry digest): the
 * admin setting when set, else COMPANY_EMAIL (the settings value wins, as
 * in Phase 2). Null when neither is usable; the reason is logged by type
 * only, never the address.
 */
export async function getCompanyAlertEmail(): Promise<string | null> {
  try {
    await connectDb();
    const doc = await SiteContentModel.findOne(
      { key: SETTINGS_KEYS.companyEmail },
      { value: 1 },
    ).lean<{ value: unknown } | null>();
    const stored = storedEmailSchema.safeParse(doc?.value ?? null);
    if (stored.success && stored.data) return stored.data;
  } catch (error) {
    console.error(
      `[contact-settings] company email setting not read: ${error instanceof Error ? error.name : "unknown error"}`,
    );
  }
  try {
    return env.companyEmail();
  } catch (error) {
    console.error(
      `[contact-settings] no company email configured: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    return null;
  }
}
