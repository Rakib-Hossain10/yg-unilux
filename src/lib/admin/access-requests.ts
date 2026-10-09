// Admin services for the access-request queue (plan Q1-Q5, Q12; ADR 0069):
// list, get, approve (create or extend a customer + invite), reject, the
// manual WhatsApp entry and deleting handled requests. Callers are
// requireAdmin() Server Actions (P7) passing the admin's id and headers.

import "server-only";

import type { Types } from "mongoose";

import { computeAccessExpiry } from "@/lib/access-expiry";
import { hasRole } from "@/lib/auth";
import { connectDb } from "@/lib/db";
import { EmailSendError, sendAccessDeclinedEmail } from "@/lib/email";
import { inviteStatus, type InviteStatus } from "@/lib/invite";
import {
  accessRequestIdSchema,
  approveAccessRequestSchema,
  listAccessRequestsSchema,
  manualAccessRequestSchema,
  rejectAccessRequestSchema,
} from "@/lib/schemas/access-request";
import { AccessRequestModel, ProductModel, UserModel } from "@/models";
import type {
  AccessRequest,
  AccessRequestKind,
  AccessRequestSource,
  AccessRequestStatus,
} from "@/models/access-request";

import {
  applyAccess,
  assertActor,
  createCustomerAccount,
  findAccountByEmail,
  issueInvite,
  notifyAccessExtended,
  type AdminActor,
  type InviteOutcome,
} from "./customers";
import {
  auditAndFinish,
  auditKeepingData,
  fieldError,
  formError,
  invalidInput,
  isDuplicateKeyError,
  type ServiceResult,
} from "./write-result";

export const ACCESS_REQUESTS_PAGE_SIZE = 50;

const CUSTOMER_ROLE = /(?:^|,)\s*customer\s*(?:,|$)/;
const NOT_FOUND = "This request no longer exists.";
const ALREADY_HANDLED = "This request has already been handled.";
const TRY_AGAIN = "Something went wrong. Please try again.";

/* Only the error's type (and an email provider's code): never values. */
function logProblem(what: string, error: unknown): void {
  const kind =
    error instanceof EmailSendError
      ? `${error.reason} status=${error.statusCode ?? "-"} code=${error.providerCode ?? "-"}`
      : error instanceof Error
        ? error.name
        : "unknown error";
  console.error(`[access-requests] ${what}: ${kind}`);
}

// ---------------------------------------------------------------------------
// Reads (admin only, never cached)
// ---------------------------------------------------------------------------

/** One row of the queue. */
export interface AccessRequestRow {
  id: string;
  name: string;
  email: string;
  company: string | null;
  country: string | null;
  phone: string | null;
  kind: AccessRequestKind;
  source: AccessRequestSource;
  status: AccessRequestStatus;
  productId: string | null;
  createdAt: Date;
  handledAt: Date | null;
  /** An account with this email is already a customer (admin-only notice). */
  existingCustomer: boolean;
}

export interface AccessRequestPage {
  rows: AccessRequestRow[];
  page: number;
  pageCount: number;
  total: number;
}

const ROW_PROJECTION = {
  name: 1,
  email: 1,
  company: 1,
  country: 1,
  phone: 1,
  kind: 1,
  source: 1,
  status: 1,
  product: 1,
  createdAt: 1,
  handledAt: 1,
} as const;

type RowDoc = Pick<
  AccessRequest,
  | "_id"
  | "name"
  | "email"
  | "company"
  | "country"
  | "phone"
  | "kind"
  | "source"
  | "status"
  | "product"
  | "createdAt"
  | "handledAt"
>;

function toRow(doc: RowDoc, customers: ReadonlySet<string>): AccessRequestRow {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    email: doc.email,
    company: doc.company ?? null,
    country: doc.country ?? null,
    phone: doc.phone ?? null,
    kind: doc.kind ?? "new",
    source: doc.source,
    status: doc.status,
    productId: doc.product ? doc.product.toHexString() : null,
    createdAt: doc.createdAt,
    handledAt: doc.handledAt ?? null,
    existingCustomer: customers.has(doc.email),
  };
}

/* Which of these emails already belong to a customer account (one query). */
async function customerEmails(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const users = await UserModel.find(
    { email: { $in: emails }, role: { $regex: CUSTOMER_ROLE } },
    { email: 1 },
  )
    .lean<{ email: string }[]>()
    .exec();
  return new Set(users.map((user) => user.email));
}

/**
 * The queue: "pending" (waiting) or "handled" (approved + rejected), newest
 * first, 50 per page; a page past the end shows the last page. Served by
 * the `{ status: 1, createdAt: -1 }` index.
 */
export async function listAccessRequests(
  input: unknown,
): Promise<AccessRequestPage> {
  const parsed = listAccessRequestsSchema.safeParse(input);
  const query = parsed.success
    ? parsed.data
    : listAccessRequestsSchema.parse({});
  const statuses: AccessRequestStatus[] =
    query.tab === "pending" ? ["pending"] : ["approved", "rejected"];
  const filter = { status: { $in: statuses } };

  await connectDb();
  const total = await AccessRequestModel.countDocuments(filter).exec();
  const pageCount = Math.max(1, Math.ceil(total / ACCESS_REQUESTS_PAGE_SIZE));
  const page = Math.min(query.page, pageCount);
  if (total === 0) return { rows: [], page: 1, pageCount, total };

  const docs = await AccessRequestModel.find(filter, ROW_PROJECTION)
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * ACCESS_REQUESTS_PAGE_SIZE)
    .limit(ACCESS_REQUESTS_PAGE_SIZE)
    .lean<RowDoc[]>()
    .exec();
  const customers = await customerEmails([
    ...new Set(docs.map((doc) => doc.email)),
  ]);
  return {
    rows: docs.map((doc) => toRow(doc, customers)),
    page,
    pageCount,
    total,
  };
}

/** The account that already uses a request's email, as the admin sees it. */
export interface ExistingAccount {
  userId: string;
  /** False for the admin's own account: approval is refused then. */
  isCustomer: boolean;
  accessExpiresAt: Date | null;
  blocked: boolean;
  invite: InviteStatus;
}

export interface AccessRequestDetail extends AccessRequestRow {
  message: string | null;
  rejectReason: string | null;
  consentAt: Date | null;
  userId: string | null;
  product: { id: string; name: string; slug: string; status: string } | null;
  existingAccount: ExistingAccount | null;
}

type CustomerAccount = NonNullable<
  Awaited<ReturnType<typeof findAccountByEmail>>
>;

function isBlockedAccount(account: CustomerAccount, now: Date): boolean {
  return (
    account.banned === true &&
    (!account.banExpires || account.banExpires.getTime() > now.getTime())
  );
}

/** One request with its product and any existing account; null if missing. */
export async function getAccessRequest(
  input: unknown,
  options: { now?: Date } = {},
): Promise<AccessRequestDetail | null> {
  const parsed = accessRequestIdSchema.safeParse(input);
  if (!parsed.success) return null;
  const now = options.now ?? new Date();
  await connectDb();
  const doc = await AccessRequestModel.findById(parsed.data.requestId)
    .lean<AccessRequest | null>()
    .exec();
  if (!doc) return null;

  const [product, account] = await Promise.all([
    doc.product
      ? ProductModel.findById(doc.product, { name: 1, slug: 1, status: 1 })
          .lean<{
            _id: Types.ObjectId;
            name: string;
            slug: string;
            status: string;
          } | null>()
          .exec()
      : null,
    findAccountByEmail(doc.email),
  ]);
  const isCustomer =
    account !== null &&
    hasRole(account, "customer") &&
    !hasRole(account, "admin");

  return {
    ...toRow(doc, new Set(isCustomer ? [doc.email] : [])),
    message: doc.message ?? null,
    rejectReason: doc.rejectReason ?? null,
    consentAt: doc.consentAt ?? null,
    userId: doc.user ? doc.user.toHexString() : null,
    product: product
      ? {
          id: product._id.toHexString(),
          name: product.name,
          slug: product.slug,
          status: product.status,
        }
      : null,
    existingAccount: account
      ? {
          userId: account._id.toHexString(),
          isCustomer,
          accessExpiresAt: account.accessExpiresAt ?? null,
          blocked: isBlockedAccount(account, now),
          invite: inviteStatus(account, now),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/*
 * Moves a pending request to `status` in one conditional update, so two
 * admins (or two clicks) can't both handle it. Returns the request as it
 * was, or a form error.
 */
async function claimPending(
  requestId: string,
  actorId: string,
  set: Record<string, unknown>,
  now: Date,
): Promise<AccessRequest | ServiceResult<never>> {
  await connectDb();
  const claimed = await AccessRequestModel.findOneAndUpdate(
    { _id: requestId, status: "pending" },
    { $set: { ...set, handledBy: actorId, handledAt: now } },
    { returnDocument: "before", runValidators: true },
  )
    .lean<AccessRequest | null>()
    .exec();
  if (claimed) return claimed;
  const exists = await AccessRequestModel.exists({ _id: requestId });
  return formError(exists ? ALREADY_HANDLED : NOT_FOUND);
}

function isClaimFailure(
  value: AccessRequest | ServiceResult<never>,
): value is ServiceResult<never> {
  return "ok" in value;
}

/*
 * Puts a claimed request back to pending when approval stopped BEFORE any
 * account was written, so the admin can simply retry. If a new pending
 * request for the same email arrived meanwhile (unique pending index), the
 * claim stays approved and the new one waits in the queue; that is logged.
 */
async function releaseClaim(requestId: string): Promise<void> {
  try {
    await AccessRequestModel.updateOne(
      { _id: requestId, status: "approved" },
      { $set: { status: "pending" }, $unset: { handledBy: 1, handledAt: 1 } },
    ).exec();
  } catch (error) {
    logProblem("approval not rolled back", error);
  }
}

export interface ApproveResult {
  requestId: string;
  userId: string;
  /** True when a new customer account was made; false = existing extended. */
  created: boolean;
  accessExpiresAt: Date | null;
  /**
   * The invite: always for a new account; for an existing one only when its
   * last invite expired or it never had one and never set a password. A
   * state other than "sent"/"copy" tells the UI to offer "New invite link".
   */
  invite: InviteOutcome | null;
  /** Existing customers: whether "access extended" was emailed. */
  notified: boolean;
  /** The existing account is blocked; approving does not unblock it. */
  blocked: boolean;
  /**
   * The approval is saved but its audit entry is not (ADR 0070): the result
   * is still returned, because a copy-once link exists only here.
   */
  auditFailed: boolean;
}

/*
 * Whether approving for an EXISTING customer should (re)send an invite: the
 * latest invite expired, or the customer never chose a password and has no
 * invite at all (e.g. an approval whose invite step failed earlier). A
 * customer with a pending invite, or who set a password, gets none.
 */
function needsInvite(account: CustomerAccount, now: Date): boolean {
  const state = inviteStatus(account, now).state;
  if (state === "expired") return true;
  return state === "none" && !account.passwordSetAt;
}

/**
 * Approves a pending request (plan Q1, Q5):
 * - no account with this email: a new customer (role customer,
 *   mustChangePassword true, the chosen expiry, the admin-corrected name /
 *   company / country) and an invite, emailed or shown once;
 * - an existing customer: never a second account. Access is extended
 *   (months from the later of today and the current end), "access extended"
 *   is emailed when asked, and an invite is (re)sent when the last one
 *   expired, or none was ever made and no password was chosen;
 * - the admin's own email: refused.
 * The request is claimed first (pending to approved, atomically). Only a
 * failure BEFORE the account is written puts it back to pending. Once the
 * account was created or extended, the approval stands: later steps (the
 * invite, the email, linking `user`) report their own outcome and never
 * throw, so "try again" can never extend access twice or skip an invite.
 */
export async function approveAccessRequest(
  actor: AdminActor,
  input: unknown,
  options: { now?: Date } = {},
): Promise<ServiceResult<ApproveResult>> {
  assertActor(actor);
  const parsed = approveAccessRequestSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const data = parsed.data;
  const now = options.now ?? new Date();

  let claimed: AccessRequest;
  try {
    const claim = await claimPending(
      data.requestId,
      actor.id,
      { status: "approved" },
      now,
    );
    if (isClaimFailure(claim)) return claim;
    claimed = claim;
  } catch (error) {
    logProblem("request not claimed", error);
    return formError(TRY_AGAIN);
  }

  // Step 1: the account write. Any failure here changed nothing, so the
  // claim is released and the admin can retry.
  let existing: CustomerAccount | null;
  let userId: string;
  let accessExpiresAt: Date | null;
  try {
    existing = await findAccountByEmail(claimed.email);
    if (existing && hasRole(existing, "admin")) {
      await releaseClaim(data.requestId);
      return formError(
        "This email belongs to the admin account. Reject the request instead.",
      );
    }
    if (existing && !hasRole(existing, "customer")) {
      await releaseClaim(data.requestId);
      return formError(
        "This email belongs to an account that is not a customer.",
      );
    }
    if (existing) {
      userId = existing._id.toHexString();
      accessExpiresAt = await applyAccess(existing, data.access, now);
    } else {
      accessExpiresAt = computeAccessExpiry(data.access, { now });
      const created = await createCustomerAccount(actor, {
        name: data.name,
        email: claimed.email,
        company: data.company,
        country: data.country,
        accessExpiresAt,
      });
      if (created === null) {
        // The email was taken between the check and the insert.
        await releaseClaim(data.requestId);
        return formError(TRY_AGAIN);
      }
      userId = created;
    }
  } catch (error) {
    logProblem("request not approved", error);
    await releaseClaim(data.requestId);
    return formError(TRY_AGAIN);
  }

  // Step 2: the account is written; nothing below throws or rolls back.
  let invite: InviteOutcome | null = null;
  let notified = false;
  if (existing === null) {
    invite = await issueInvite(
      { id: userId, email: claimed.email, name: data.name },
      data.delivery,
    );
  } else {
    if (needsInvite(existing, now)) {
      invite = await issueInvite(
        { id: userId, email: existing.email, name: existing.name },
        data.delivery,
      );
    }
    if (data.notifyExtension) {
      notified = await notifyAccessExtended(existing, accessExpiresAt, now);
    }
  }
  try {
    await AccessRequestModel.updateOne(
      { _id: data.requestId },
      { $set: { user: userId } },
    ).exec();
  } catch (error) {
    // The request still matches the customer by email on the customer page.
    logProblem("request not linked to the account", error);
  }

  const result: Omit<ApproveResult, "auditFailed"> = {
    requestId: data.requestId,
    userId,
    created: existing === null,
    accessExpiresAt,
    invite,
    notified,
    blocked: existing !== null && isBlockedAccount(existing, now),
  };
  return auditKeepingData(
    {
      actorId: actor.id,
      action: "access_request.approve",
      target: { type: "access_request", id: data.requestId },
      meta: {
        userId,
        created: result.created,
        access: data.access.kind,
        invite: invite ? invite.state : "none",
        notified,
      },
    },
    result,
    [],
  );
}

/**
 * Rejects a pending request with an optional internal reason (at most 500
 * characters, never emailed) and, only when asked, the polite decline email
 * (plan Q4).
 */
export async function rejectAccessRequest(
  actor: AdminActor,
  input: unknown,
  options: { now?: Date } = {},
): Promise<ServiceResult<{ requestId: string; emailSent: boolean }>> {
  assertActor(actor);
  const parsed = rejectAccessRequestSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { requestId, reason, sendEmail } = parsed.data;
  const now = options.now ?? new Date();

  let claimed: AccessRequest;
  try {
    const claim = await claimPending(
      requestId,
      actor.id,
      { status: "rejected", ...(reason ? { rejectReason: reason } : {}) },
      now,
    );
    if (isClaimFailure(claim)) return claim;
    claimed = claim;
  } catch (error) {
    logProblem("request not rejected", error);
    return formError(TRY_AGAIN);
  }

  let emailSent = false;
  if (sendEmail) {
    try {
      await sendAccessDeclinedEmail({ to: claimed.email, name: claimed.name });
      emailSent = true;
    } catch (error) {
      logProblem("decline email not sent", error);
    }
  }
  return auditAndFinish(
    {
      actorId: actor.id,
      action: "access_request.reject",
      target: { type: "access_request", id: requestId },
      meta: { hasReason: reason !== null, emailSent },
    },
    { requestId, emailSent },
    [],
  );
}

/**
 * The admin types in a request received on WhatsApp (source "whatsapp",
 * pending). A pending request for the same email already exists: refused
 * (open it instead); the unique pending index enforces it under races.
 */
export async function createManualAccessRequest(
  actor: AdminActor,
  input: unknown,
): Promise<ServiceResult<{ requestId: string }>> {
  assertActor(actor);
  const parsed = manualAccessRequestSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const data = parsed.data;

  let requestId: string;
  let product: string | null = null;
  try {
    await connectDb();
    product =
      data.product && (await ProductModel.exists({ _id: data.product }).exec())
        ? data.product
        : null;
    const doc = await AccessRequestModel.create({
      name: data.name,
      email: data.email,
      kind: data.kind,
      source: "whatsapp",
      status: "pending",
      ...(data.company ? { company: data.company } : {}),
      ...(data.country ? { country: data.country } : {}),
      ...(data.phone ? { phone: data.phone } : {}),
      ...(data.message ? { message: data.message } : {}),
      ...(product ? { product } : {}),
    });
    requestId = doc._id.toHexString();
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return fieldError(
        "email",
        "A pending request for this email is already in the queue.",
      );
    }
    logProblem("manual request not stored", error);
    return formError(TRY_AGAIN);
  }

  return auditAndFinish(
    {
      actorId: actor.id,
      action: "access_request.create_manual",
      target: { type: "access_request", id: requestId },
      meta: { kind: data.kind, hasProduct: product !== null },
    },
    { requestId },
    [],
  );
}

/**
 * Deletes a HANDLED request (plan Q12: retention is the admin's choice; no
 * automatic purge). A pending request can't be deleted: reject it first.
 */
export async function deleteAccessRequest(
  actor: AdminActor,
  input: unknown,
): Promise<ServiceResult<{ requestId: string }>> {
  assertActor(actor);
  const parsed = accessRequestIdSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { requestId } = parsed.data;

  let status: AccessRequestStatus;
  try {
    await connectDb();
    const deleted = await AccessRequestModel.findOneAndDelete(
      { _id: requestId, status: { $ne: "pending" } },
      { projection: { status: 1 } },
    )
      .lean<{ status: AccessRequestStatus } | null>()
      .exec();
    if (!deleted) {
      const exists = await AccessRequestModel.exists({ _id: requestId });
      return formError(
        exists
          ? "Approve or reject this request before deleting it."
          : NOT_FOUND,
      );
    }
    status = deleted.status;
  } catch (error) {
    logProblem("request not deleted", error);
    return formError(TRY_AGAIN);
  }

  return auditAndFinish(
    {
      actorId: actor.id,
      action: "access_request.delete",
      target: { type: "access_request", id: requestId },
      meta: { status },
    },
    { requestId },
    [],
  );
}
