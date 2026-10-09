// Zod schemas for access requests (ADR 0069): the public form, the admin's
// manual WhatsApp entry, approve, reject and the queue listing. Pure Zod
// (no server-only import), so the forms and the services parse alike.

import { z } from "zod";

import {
  ACCESS_MONTH_CHOICES,
  MAX_ACCESS_DATE,
  MIN_ACCESS_DATE,
  parseAccessDay,
} from "@/lib/access-expiry";
import {
  ACCESS_REQUEST_KINDS,
  MAX_REJECT_REASON_LENGTH,
} from "@/models/access-request-constants";

import { objectIdSchema } from "./common";

/*
 * Plain character sets (ADR 0068 "Open for P3"). Text from the public form
 * reaches the company inbox and a greeting, so it holds letters (any
 * script), digits where useful, spaces and a few punctuation marks. No
 * ":", "@", "<", ">" or line breaks, so nothing typed can become a link,
 * an address or markup.
 */
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;
const COMPANY_PATTERN = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'’&()/+-]*$/u;
const COUNTRY_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} .,'’()-]*$/u;
const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{5,38}$/;

export const MAX_NAME_LENGTH = 100;
export const MAX_COMPANY_LENGTH = 200;
export const MAX_COUNTRY_LENGTH = 100;
export const MAX_MESSAGE_LENGTH = 2000;

/* Trim and collapse runs of spaces before the pattern check. */
const squeezed = () =>
  z
    .string()
    .trim()
    .transform((value) => value.replace(/ {2,}/g, " "));

/** A person's name: required, letters and simple punctuation. */
export const personNameSchema = squeezed().pipe(
  z
    .string()
    .min(1, "Enter a name")
    .max(MAX_NAME_LENGTH, `At most ${MAX_NAME_LENGTH} characters`)
    .regex(NAME_PATTERN, "Use letters, spaces, dots, hyphens or apostrophes"),
);

/** A company name: letters, digits and simple punctuation. */
export const companySchema = squeezed().pipe(
  z
    .string()
    .min(1, "Enter a company")
    .max(MAX_COMPANY_LENGTH, `At most ${MAX_COMPANY_LENGTH} characters`)
    .regex(COMPANY_PATTERN, "Use letters, digits and simple punctuation"),
);

/** A country name (the form offers a select; the server still checks it). */
export const countrySchema = squeezed().pipe(
  z
    .string()
    .min(2, "Choose a country")
    .max(MAX_COUNTRY_LENGTH, `At most ${MAX_COUNTRY_LENGTH} characters`)
    .regex(COUNTRY_PATTERN, "Choose a country"),
);

/** Optional company/country: "" or missing = none (null). */
export const optionalCompanySchema = z
  .union([z.literal(""), companySchema])
  .optional()
  .transform((value) => (value ? value : null));
export const optionalCountrySchema = z
  .union([z.literal(""), countrySchema])
  .optional()
  .transform((value) => (value ? value : null));

/** An email address, trimmed and lowercased. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "Enter a valid email address")
  .pipe(z.email("Enter a valid email address"));

/** An optional phone number: "" or missing = none. */
export const optionalPhoneSchema = z
  .string()
  .trim()
  .max(40, "Enter a valid phone number")
  .refine((value) => value === "" || PHONE_PATTERN.test(value), {
    message: "Enter a valid phone number",
  })
  .optional()
  .transform((value) => (value ? value : null));

/** An optional free-text message: line breaks allowed, other controls not. */
export const optionalMessageSchema = z
  .string()
  .transform((value) => value.replace(/\r\n?/g, "\n").trim())
  .pipe(
    z
      .string()
      .max(MAX_MESSAGE_LENGTH, `At most ${MAX_MESSAGE_LENGTH} characters`)
      .regex(/^[^\x00-\x09\x0b-\x1f\x7f]*$/, "Remove special characters"),
  )
  .optional()
  .transform((value) => (value ? value : null));

/** An optional product id from `?product=`; anything malformed is dropped. */
const optionalProductSchema = z
  .unknown()
  .optional()
  .transform((value) => {
    const parsed = objectIdSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });

/** The consent checkbox: true, or the "on"/"true" a plain form posts. */
const consentSchema = z
  .union([z.literal(true), z.literal("on"), z.literal("true")], {
    error: "Please accept the privacy notice",
  })
  .transform(() => true as const);

export const accessRequestKindSchema = z.enum(ACCESS_REQUEST_KINDS);

/**
 * The public request form (plan Q2). The honeypot (`website`) and the form's
 * start time (`startedAt`, ms since epoch, rendered by the server) are read
 * by the service BEFORE this schema, so a bot gets no validation feedback.
 */
export const publicAccessRequestSchema = z.object({
  name: personNameSchema,
  email: emailSchema,
  company: companySchema,
  country: countrySchema,
  phone: optionalPhoneSchema,
  message: optionalMessageSchema,
  product: optionalProductSchema,
  kind: accessRequestKindSchema.optional().default("new"),
  consent: consentSchema,
});
export type PublicAccessRequestInput = z.input<
  typeof publicAccessRequestSchema
>;

/** The admin's manual entry from a WhatsApp chat (`create_manual`). */
export const manualAccessRequestSchema = z.object({
  name: personNameSchema,
  email: emailSchema,
  company: optionalCompanySchema,
  country: optionalCountrySchema,
  phone: optionalPhoneSchema,
  message: optionalMessageSchema,
  product: optionalProductSchema,
  kind: accessRequestKindSchema.optional().default("new"),
});
export type ManualAccessRequestInput = z.input<
  typeof manualAccessRequestSchema
>;

const accessDaySchema = z
  .string()
  .trim()
  .refine((value) => parseAccessDay(value) !== null, {
    message: `Choose a day between ${MIN_ACCESS_DATE} and ${MAX_ACCESS_DATE}`,
  });

/** The expiry picker (plan Q5). */
export const accessChoiceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("months"),
    months: z.union(ACCESS_MONTH_CHOICES.map((m) => z.literal(m))),
  }),
  z.object({ kind: z.literal("date"), date: accessDaySchema }),
  z.object({ kind: z.literal("none") }),
]);

/** How a new invite link reaches the customer. */
export const inviteDeliverySchema = z.enum(["email", "copy"]);
export type InviteDelivery = z.infer<typeof inviteDeliverySchema>;

/** Approve: the admin may correct the profile before the account is made. */
export const approveAccessRequestSchema = z.object({
  requestId: objectIdSchema,
  name: personNameSchema,
  company: optionalCompanySchema,
  country: optionalCountrySchema,
  access: accessChoiceSchema,
  delivery: inviteDeliverySchema.optional().default("email"),
  /** Existing customers only: email them the new end date (plan Q4). */
  notifyExtension: z.boolean().optional().default(true),
});
export type ApproveAccessRequestInput = z.input<
  typeof approveAccessRequestSchema
>;

/** Reject: an internal reason and an optional polite decline email. */
export const rejectAccessRequestSchema = z.object({
  requestId: objectIdSchema,
  reason: z
    .string()
    .trim()
    .max(
      MAX_REJECT_REASON_LENGTH,
      `At most ${MAX_REJECT_REASON_LENGTH} characters`,
    )
    .regex(/^[^\x00-\x09\x0b-\x1f\x7f]*$/, "Remove special characters")
    .optional()
    .transform((value) => (value ? value : null)),
  sendEmail: z.boolean().optional().default(false),
});
export type RejectAccessRequestInput = z.input<
  typeof rejectAccessRequestSchema
>;

export const accessRequestIdSchema = z.object({ requestId: objectIdSchema });

/** The queue: pending or handled (approved + rejected), paged. */
export const listAccessRequestsSchema = z.object({
  tab: z.enum(["pending", "handled"]).optional().default("pending"),
  page: z.coerce.number().int().min(1).max(1000).optional().default(1),
});
export type ListAccessRequestsInput = z.input<typeof listAccessRequestsSchema>;
