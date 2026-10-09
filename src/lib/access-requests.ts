// The public "Request access" submission (plan Q2-Q4, ADR 0069): anti-spam,
// limits, one pending request per email, and the company alert. Called by
// the P6 Server Action ONLY; it writes nothing but `accessRequests` (rule 4:
// no self-registration).

import "server-only";

import { after } from "next/server";
import { z } from "zod";

import {
  publicAccessRequestSchema,
  type PublicAccessRequestInput,
} from "@/lib/schemas/access-request";
import { AccessRequestModel, ProductModel } from "@/models";
import type { AccessRequestKind } from "@/models/access-request";

import type { ServiceErrors } from "./admin/write-result";
import { hasRole } from "./auth";
import type { HeaderSource } from "./client-ip";
import { getCompanyAlertEmail } from "./contact-settings";
import { connectDb } from "./db";
import { EmailSendError, sendAccessRequestAlertEmail } from "./email";
import { EnvError } from "./env";
import { RateLimitUnavailableError } from "./rate-limit";
import { consumeAccessRequest } from "./sign-in-limit";

/** A human needs at least this long to fill the form (plan Q3). */
export const MIN_FILL_MS = 3000;
/** The hidden field bots fill in; people never see it. */
export const HONEYPOT_FIELD = "website";
/** The hidden field holding when the form was rendered (ms since epoch). */
export const STARTED_AT_FIELD = "startedAt";

/** Shown for every accepted, merged, limited or spam submission alike. */
export const ACCESS_REQUEST_THANKS =
  "Thank you. We have received your request and will be in touch.";
/** Shown only when our own database or configuration fails. */
export const ACCESS_REQUEST_UNAVAILABLE =
  "We could not take your request just now. Please try again later or message us on WhatsApp.";

/**
 * The answer. `{ ok: true }` is the SAME object shape for a new request, a
 * merged duplicate, an existing customer, a limited sender, a honeypot hit
 * and a too-fast form, so nothing tells them apart (no enumeration).
 * Only invalid input (about the visitor's own typing) and an outage of our
 * own systems differ.
 */
export type SubmitAccessRequestResult =
  | { ok: true }
  | { ok: false; errors: ServiceErrors }
  | { ok: false; unavailable: true };

/** What the caller knows about the request beyond the form. */
export interface SubmitAccessRequestContext {
  /** Request headers; only Vercel's trusted IP header is read (hashed). */
  headers: HeaderSource;
  /**
   * The signed-in user from the SERVER session (getViewer), never from the
   * form. Links the request to the account only when it is a customer
   * submitting with that account's own email.
   */
  viewer?: { userId: string; email: string; role?: string | null } | null;
  now?: Date;
  /** Runs the alert after the response; defaults to Next's `after()`. */
  runInBackground?: (task: Promise<unknown>) => void;
}

/** The raw form: the schema's fields plus the two anti-spam fields. */
export type SubmitAccessRequestInput = PublicAccessRequestInput & {
  [HONEYPOT_FIELD]?: unknown;
  [STARTED_AT_FIELD]?: unknown;
};

/* Every "silent" outcome returns a fresh copy of the same answer. */
const received = (): SubmitAccessRequestResult => ({ ok: true });

function readField(source: unknown, key: string): unknown {
  return typeof source === "object" && source !== null
    ? Reflect.get(source, key)
    : undefined;
}

const startedAtSchema = z.coerce.number().int().positive();

/*
 * True for a bot: the honeypot has text, or the form came back faster than
 * a person can fill it (or with a missing, malformed or future start time).
 * Checked BEFORE validation, so a bot learns nothing from field errors.
 */
function looksAutomated(raw: unknown, now: Date): boolean {
  const honeypot = readField(raw, HONEYPOT_FIELD);
  if (typeof honeypot === "string" ? honeypot.trim() !== "" : honeypot != null)
    return true;
  const startedAt = startedAtSchema.safeParse(readField(raw, STARTED_AT_FIELD));
  if (!startedAt.success) return true;
  const elapsed = now.getTime() - startedAt.data;
  return elapsed < MIN_FILL_MS;
}

function logProblem(what: string, error: unknown): void {
  const kind =
    error instanceof EmailSendError
      ? `${error.reason} status=${error.statusCode ?? "-"} code=${error.providerCode ?? "-"}`
      : error instanceof Error
        ? error.name
        : "unknown error";
  console.error(`[access-request] ${what}: ${kind}`);
}

/* The alert to the company inbox: name, company, country and kind only. */
async function sendAlertSafely(details: {
  name: string;
  company: string;
  country: string;
  kind: AccessRequestKind;
}): Promise<void> {
  try {
    const to = await getCompanyAlertEmail();
    if (!to) return;
    await sendAccessRequestAlertEmail({ to, ...details });
  } catch (error) {
    logProblem("alert email not sent", error);
  }
}

/* A product reference is kept only when it is a published product. */
async function publishedProduct(id: string | null): Promise<string | null> {
  if (id === null) return null;
  const found = await ProductModel.exists({ _id: id, status: "published" });
  return found ? id : null;
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 11000
  );
}

/**
 * Handles one public submission. Steps:
 * 1. honeypot / minimum fill time → silent `{ ok: true }`, nothing stored;
 * 2. Zod (rule 8) → field errors;
 * 3. limits per network (HMAC'd) and per email → silent `{ ok: true }`;
 * 4. one pending request per email: a second one MERGES into the first
 *    (latest values win; never a new row), else a new pending row;
 * 5. a NEW row schedules the company alert after the response; a merge
 *    does not (the queue already shows it).
 * An existing customer's request is stored like any other (a renewal) and
 * gets the same answer. Our own outages answer `unavailable`.
 */
export async function submitAccessRequest(
  input: unknown,
  context: SubmitAccessRequestContext,
): Promise<SubmitAccessRequestResult> {
  const now = context.now ?? new Date();
  if (looksAutomated(input, now)) return received();

  const parsed = publicAccessRequestSchema.safeParse(input);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    return {
      ok: false,
      errors: { formErrors: flat.formErrors, fieldErrors: flat.fieldErrors },
    };
  }
  const data = parsed.data;

  try {
    const gate = await consumeAccessRequest({
      email: data.email,
      headers: context.headers,
    });
    if (!gate.allowed) return received();
  } catch (error) {
    if (
      error instanceof RateLimitUnavailableError ||
      error instanceof EnvError
    ) {
      logProblem("limiter unavailable", error);
      return { ok: false, unavailable: true };
    }
    throw error;
  }

  let inserted: boolean;
  try {
    await connectDb();
    const product = await publishedProduct(data.product);
    const viewer = context.viewer;
    const user =
      viewer &&
      viewer.email.trim().toLowerCase() === data.email &&
      hasRole({ role: viewer.role ?? null }, "customer")
        ? viewer.userId
        : null;
    // A merge takes the LATEST submission whole: optional fields it lacks
    // are removed, so one row never mixes two submissions.
    const optional = { phone: data.phone, message: data.message, product };
    const set: Partial<Record<string, string | Date>> = {
      name: data.name,
      company: data.company,
      country: data.country,
      kind: data.kind,
      consentAt: now,
      ...(user ? { user } : {}),
    };
    const unset: Partial<Record<string, 1>> = {};
    for (const [field, value] of Object.entries(optional)) {
      if (value) set[field] = value;
      else unset[field] = 1;
    }
    // Which pending row this submission may merge into. The form never
    // proves it owns the email, so it never touches a row it doesn't own:
    // not the admin's manual WhatsApp entry (source "whatsapp"), and,
    // unless signed in as that customer, not a row linked to an account.
    // Such a row makes the insert hit the one-pending-per-email index, and
    // the submission is dropped silently (same answer).
    const mine = {
      email: data.email,
      status: "pending" as const,
      source: "form" as const,
      ...(user ? {} : { user: { $exists: false } }),
    };
    const upsert = () =>
      AccessRequestModel.updateOne(
        mine,
        {
          $set: set,
          ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
          $setOnInsert: {
            email: data.email,
            status: "pending",
            source: "form",
          },
        },
        { upsert: true, runValidators: true },
      ).exec();
    let result: Awaited<ReturnType<typeof upsert>> | null;
    try {
      result = await upsert();
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      // Either two submissions for a new email raced (the retry merges into
      // the row the other one inserted), or the pending row is not ours to
      // merge into (the retry fails the same way: drop silently).
      result = await upsert().catch((retryError: unknown) => {
        if (isDuplicateKey(retryError)) return null;
        throw retryError;
      });
    }
    inserted = result !== null && result.upsertedCount > 0;
  } catch (error) {
    logProblem("request not stored", error);
    return { ok: false, unavailable: true };
  }

  if (inserted) {
    const run = context.runInBackground ?? ((task) => after(task));
    run(
      sendAlertSafely({
        name: data.name,
        company: data.company,
        country: data.country,
        kind: data.kind,
      }),
    );
  }
  return received();
}
