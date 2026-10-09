// Public, read-only access to the WhatsApp number from the admin settings
// (ADR 0049/0050), for pages that offer a "Message us on WhatsApp" link
// (/reset-password's expired view now, /request-access in P6). Uncached: its
// callers render per request anyway, and a cached copy would need its own
// invalidation when the admin changes the number.

import "server-only";

import { SETTINGS_KEYS, storedWhatsappSchema } from "@/lib/schemas/settings";
import { SiteContentModel } from "@/models";

import { connectDb } from "./db";

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
