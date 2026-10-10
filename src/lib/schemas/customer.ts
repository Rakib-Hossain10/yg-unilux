// Zod schemas for the admin customers module (ADR 0070): list filters,
// create, profile, access, block and the password/invite actions. Pure Zod,
// shared with the admin forms.

import { z } from "zod";

import { MAX_REJECT_REASON_LENGTH } from "@/models/access-request-constants";

import {
  accessChoiceSchema,
  emailSchema,
  inviteDeliverySchema,
  optionalCompanySchema,
  optionalCountrySchema,
  personNameSchema,
} from "./access-request";
import { objectIdSchema } from "./common";

export { accessChoiceSchema, inviteDeliverySchema };

/** The list's status filter (plan Q10). */
export const CUSTOMER_STATUS_FILTERS = [
  "active",
  "expiring",
  "expired",
  "blocked",
  "invite_pending",
  "invite_expired",
] as const;
export type CustomerStatusFilter = (typeof CUSTOMER_STATUS_FILTERS)[number];

export const CUSTOMER_SORTS = ["expiry", "created", "name"] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];

export const CUSTOMERS_PAGE_SIZE = 50;
export const MAX_CUSTOMER_SEARCH_LENGTH = 100;
/** "Expiring" = access ends within this many days (plan Q10). */
export const EXPIRING_SOON_DAYS = 30;

export const listCustomersSchema = z.object({
  q: z
    .string()
    .trim()
    .max(MAX_CUSTOMER_SEARCH_LENGTH)
    .optional()
    .transform((value) => (value ? value : null)),
  status: z
    .union([z.literal(""), z.enum(CUSTOMER_STATUS_FILTERS)])
    .optional()
    .transform((value) => (value ? value : null)),
  sort: z.enum(CUSTOMER_SORTS).optional().default("created"),
  page: z.coerce.number().int().min(1).max(1000).optional().default(1),
});
export type ListCustomersInput = z.input<typeof listCustomersSchema>;

export const customerIdSchema = z.object({ userId: objectIdSchema });

/** Create a customer by hand: an invite goes out, never a password. */
export const createCustomerSchema = z.object({
  name: personNameSchema,
  email: emailSchema,
  company: optionalCompanySchema,
  country: optionalCountrySchema,
  access: accessChoiceSchema,
  delivery: inviteDeliverySchema.optional().default("email"),
});
export type CreateCustomerInput = z.input<typeof createCustomerSchema>;

/** Profile edit: name, company, country. The email is not editable. */
export const updateCustomerProfileSchema = z.object({
  userId: objectIdSchema,
  name: personNameSchema,
  company: optionalCompanySchema,
  country: optionalCountrySchema,
});
export type UpdateCustomerProfileInput = z.input<
  typeof updateCustomerProfileSchema
>;

/** Set or extend access (plan Q5), with the optional "extended" email. */
export const setCustomerAccessSchema = z.object({
  userId: objectIdSchema,
  access: accessChoiceSchema,
  notify: z.boolean().optional().default(true),
});
export type SetCustomerAccessInput = z.input<typeof setCustomerAccessSchema>;

/**
 * "End access now": access ends at this instant (downloads lock, sign-in
 * still works). Only the customer; the time is the server's, never input.
 */
export const endCustomerAccessSchema = z.object({ userId: objectIdSchema });
export type EndCustomerAccessInput = z.input<typeof endCustomerAccessSchema>;

/** Block with a reason (admin-only, never shown to the customer). */
export const banCustomerSchema = z.object({
  userId: objectIdSchema,
  reason: z
    .string()
    .trim()
    .min(1, "Enter a reason")
    .max(
      MAX_REJECT_REASON_LENGTH,
      `At most ${MAX_REJECT_REASON_LENGTH} characters`,
    )
    .regex(/^[^\x00-\x09\x0b-\x1f\x7f]*$/, "Remove special characters"),
});
export type BanCustomerInput = z.input<typeof banCustomerSchema>;

/** A new invite link: emailed, or shown once for copying. */
export const regenerateInviteSchema = z.object({
  userId: objectIdSchema,
  delivery: inviteDeliverySchema.optional().default("email"),
});
export type RegenerateInviteInput = z.input<typeof regenerateInviteSchema>;

/** Download history page on the customer page (20 per page). */
export const customerDetailSchema = z.object({
  userId: objectIdSchema,
  page: z.coerce.number().int().min(1).max(1000).optional().default(1),
});
export type CustomerDetailInput = z.input<typeof customerDetailSchema>;
