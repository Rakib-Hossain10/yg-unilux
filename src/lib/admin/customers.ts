// Admin services for customer accounts (plan Q1, Q5, Q10; ADR 0070). Every
// write to `users` goes through Better Auth: its admin endpoints (create,
// ban, unban, set password, revoke sessions, reset request) called with the
// signed-in admin's own request headers, or src/lib/account-writes.ts for
// our `input: false` fields. Never Mongoose (UserModel is read-only).
// Callers are requireAdmin() Server Actions and pages (P7/P8) passing the
// admin's id and request headers; every read and write re-checks them from
// the database first (src/lib/admin/actor.ts). Results follow ADR 0035.

import "server-only";

import { randomBytes, randomInt } from "node:crypto";

import { isAPIError } from "better-auth/api";
import { Types } from "mongoose";

import { computeAccessExpiry, type AccessChoice } from "@/lib/access-expiry";
import {
  AccountWriteError,
  revokePasswordLinks,
  updateAccountFields,
} from "@/lib/account-writes";
import { getAuthContext, hasRole, withAuth } from "@/lib/auth";
import { connectDb } from "@/lib/db";
import {
  getDownloadHistory,
  type DownloadHistoryPage,
} from "@/lib/download-history";
import {
  EmailSendError,
  sendAccessExtendedEmail,
  sendInviteEmail,
} from "@/lib/email";
import {
  createInviteLink,
  inviteStatus,
  type InviteStatus,
} from "@/lib/invite";
import {
  acquireLock,
  buildKey,
  consume,
  hashUserId,
  RateLimitUnavailableError,
  releaseLock,
  type RateLimitRule,
} from "@/lib/rate-limit";
import type { InviteDelivery } from "@/lib/schemas/access-request";
import {
  banCustomerSchema,
  createCustomerSchema,
  customerDetailSchema,
  customerIdSchema,
  CUSTOMERS_PAGE_SIZE,
  EXPIRING_SOON_DAYS,
  listCustomersSchema,
  regenerateInviteSchema,
  setCustomerAccessSchema,
  updateCustomerProfileSchema,
  type CustomerSort,
  type CustomerStatusFilter,
} from "@/lib/schemas/customer";
import { AccessRequestModel, AuditLogModel, UserModel } from "@/models";
import type {
  AccessRequestKind,
  AccessRequestSource,
  AccessRequestStatus,
} from "@/models/access-request";
import type { User } from "@/models/user";

import { assertAdminActor, refuseUnlessAdmin, type AdminActor } from "./actor";
import {
  auditAndFinish,
  auditKeepingData,
  fieldError,
  formError,
  invalidInput,
  unchanged,
  type ServiceResult,
} from "./write-result";

// ---------------------------------------------------------------------------
// Shared pieces (also used by src/lib/admin/access-requests.ts)
// ---------------------------------------------------------------------------

export type { AdminActor } from "./actor";

/** Invites per customer per hour (plan Q1: against double-clicks). */
export const INVITE_LIMIT = {
  limit: 10,
  windowSeconds: 60 * 60,
} as const satisfies RateLimitRule;
/** A crashed invite run frees its lock after this long. */
const INVITE_LOCK_SECONDS = 30;

/** Length of a generated temporary password (Better Auth minimum is 12). */
export const TEMPORARY_PASSWORD_LENGTH = 16;
/* No look-alikes (0/O, 1/l/I), so it can be read out over WhatsApp. */
const LOOK_ALIKES = new Set(["0", "O", "1", "l", "I"]);
const PASSWORD_ALPHABET = [
  ...charRange("A", "Z"),
  ...charRange("a", "z"),
  ...charRange("2", "9"),
]
  .filter((c) => !LOOK_ALIKES.has(c))
  .join("");

function charRange(from: string, to: string): string[] {
  const start = from.charCodeAt(0);
  return Array.from({ length: to.charCodeAt(0) - start + 1 }, (_, i) =>
    String.fromCharCode(start + i),
  );
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/* Sorts "no expiry" after every real date. */
const NO_EXPIRY_SORT = new Date("9999-12-31T23:59:59.999Z");

/*
 * Role checks in queries. The admin plugin stores several roles as one
 * comma-joined string, so these mirror hasRole() (src/lib/auth.ts).
 */
const CUSTOMER_ROLE = /(?:^|,)\s*customer\s*(?:,|$)/;
const ADMIN_ROLE = /(?:^|,)\s*admin\s*(?:,|$)/;

/** The user fields the admin screens read (never deviceEpoch or tokens). */
const CUSTOMER_PROJECTION = {
  name: 1,
  email: 1,
  role: 1,
  banned: 1,
  banReason: 1,
  banExpires: 1,
  createdAt: 1,
  mustChangePassword: 1,
  accessExpiresAt: 1,
  company: 1,
  country: 1,
  invitedAt: 1,
  inviteExpiresAt: 1,
  passwordSetAt: 1,
} as const;

type CustomerDoc = Pick<User, "_id" | "name" | "email" | "createdAt"> &
  Partial<
    Pick<
      User,
      | "role"
      | "banned"
      | "banReason"
      | "banExpires"
      | "mustChangePassword"
      | "accessExpiresAt"
      | "company"
      | "country"
      | "invitedAt"
      | "inviteExpiresAt"
      | "passwordSetAt"
    >
  >;

/** Where a customer's datasheet access stands (plan Q10). */
export type AccessState = "no_expiry" | "active" | "expiring" | "expired";

/** A customer as the admin list and page show them. */
export interface CustomerSummary {
  id: string;
  name: string;
  email: string;
  company: string | null;
  country: string | null;
  createdAt: Date;
  accessExpiresAt: Date | null;
  access: AccessState;
  /** Better Auth ban in force (no end, or an end in the future). */
  blocked: boolean;
  /** Still on a temporary or random password (must change it first). */
  mustChangePassword: boolean;
  invite: InviteStatus;
}

export interface CustomerDetail extends CustomerSummary {
  /** The admin's internal block reason; never shown to the customer. */
  banReason: string | null;
}

function isBlocked(doc: CustomerDoc, now: Date): boolean {
  if (doc.banned !== true) return false;
  return !doc.banExpires || doc.banExpires.getTime() > now.getTime();
}

function accessState(expiresAt: Date | null, now: Date): AccessState {
  if (expiresAt === null) return "no_expiry";
  const left = expiresAt.getTime() - now.getTime();
  if (left <= 0) return "expired";
  return left <= EXPIRING_SOON_DAYS * MS_PER_DAY ? "expiring" : "active";
}

function toSummary(doc: CustomerDoc, now: Date): CustomerSummary {
  const accessExpiresAt = doc.accessExpiresAt ?? null;
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    email: doc.email,
    company: doc.company ?? null,
    country: doc.country ?? null,
    createdAt: doc.createdAt,
    accessExpiresAt,
    access: accessState(accessExpiresAt, now),
    blocked: isBlocked(doc, now),
    // Fails closed like the permissions: only an explicit false is "done".
    mustChangePassword: doc.mustChangePassword !== false,
    invite: inviteStatus(doc, now),
  };
}

/** True for a customer account that is not (also) the admin. */
function isCustomerOnly(doc: { role?: string | null }): boolean {
  return hasRole(doc, "customer") && !hasRole(doc, "admin");
}

/** One customer by id; null when missing, not a customer, or the admin. */
async function findCustomer(userId: string): Promise<CustomerDoc | null> {
  await connectDb();
  const doc = await UserModel.findById(userId, CUSTOMER_PROJECTION)
    .lean<CustomerDoc | null>()
    .exec();
  return doc && isCustomerOnly(doc) ? doc : null;
}

/** Any account with this email (customer or admin); for approve/create. */
export async function findAccountByEmail(
  email: string,
): Promise<CustomerDoc | null> {
  await connectDb();
  return UserModel.findOne({ email }, CUSTOMER_PROJECTION)
    .lean<CustomerDoc | null>()
    .exec();
}

const NOT_FOUND = "This customer no longer exists.";

/* Only the error's type (and an email provider's code): never values. */
function logProblem(what: string, error: unknown): void {
  const kind =
    error instanceof EmailSendError
      ? `${error.reason} status=${error.statusCode ?? "-"} code=${error.providerCode ?? "-"}`
      : error instanceof Error
        ? error.name
        : "unknown error";
  console.error(`[customers] ${what}: ${kind}`);
}

/** What happened to an invite link. `url` is a credential: show it once. */
export type InviteOutcome =
  | { state: "sent"; expiresAt: Date }
  | { state: "copy"; url: string; expiresAt: Date }
  /** The link was made (earlier ones are dead) but the email failed. */
  | { state: "send_failed"; expiresAt: Date }
  | { state: "limited"; retryAfterSeconds: number }
  /** Another invite for this customer is being made right now. */
  | { state: "busy" }
  /**
   * Our own systems failed (limiter, database) before a link was handed
   * out. Earlier links may already be dead; the admin makes a new one.
   */
  | { state: "failed" };

/**
 * Makes a new invite link for a customer and delivers it (plan Q1):
 * 1. counts against INVITE_LIMIT for this customer (HMAC'd id);
 * 2. takes the customer's in-flight lock, so two clicks can't race (one
 *    of them is refused as "busy" instead of handing out a dead link);
 * 3. createInviteLink(): a 72 h link, every earlier link deleted; never
 *    touches accessExpiresAt or mustChangePassword;
 * 4. emails it, or returns it once for copying.
 * Never throws: an infrastructure failure is `{ state: "failed" }` (logged
 * by type), so a caller that already created or extended an account can
 * still finish, audit and tell the admin to send a new link.
 */
export async function issueInvite(
  customer: { id: string; email: string; name: string },
  delivery: InviteDelivery,
): Promise<InviteOutcome> {
  try {
    return await issueInviteOrThrow(customer, delivery);
  } catch (error) {
    logProblem("invite not made", error);
    return { state: "failed" };
  }
}

async function issueInviteOrThrow(
  customer: { id: string; email: string; name: string },
  delivery: InviteDelivery,
): Promise<InviteOutcome> {
  const digest = hashUserId(customer.id);
  const limit = await consume(buildKey("invite-user", digest), INVITE_LIMIT);
  if (!limit.allowed) {
    return { state: "limited", retryAfterSeconds: limit.retryAfterSeconds };
  }
  const lock = buildKey("invite-lock", digest);
  const owner = await acquireLock(lock, INVITE_LOCK_SECONDS);
  if (owner === null) return { state: "busy" };
  try {
    const link = await createInviteLink(customer.id);
    if (delivery === "copy") {
      return { state: "copy", url: link.url, expiresAt: link.expiresAt };
    }
    try {
      await sendInviteEmail({
        to: customer.email,
        name: customer.name,
        url: link.url,
        expiresAt: link.expiresAt,
      });
      return { state: "sent", expiresAt: link.expiresAt };
    } catch (error) {
      logProblem("invite email not sent", error);
      return { state: "send_failed", expiresAt: link.expiresAt };
    }
  } finally {
    try {
      await releaseLock(lock, owner);
    } catch (error) {
      // The lock ends by itself after INVITE_LOCK_SECONDS.
      logProblem("invite lock not released", error);
    }
  }
}

/** A Better Auth admin endpoint refused; `code` is its fixed error code. */
function apiErrorCode(error: unknown): string | null {
  if (!isAPIError(error)) return null;
  const code: unknown = (error.body as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : String(error.statusCode);
}

/**
 * Creates a customer through Better Auth's admin createUser, as the signed-in
 * admin: role customer, mustChangePassword true, the chosen expiry, company
 * and country in ONE insert, and a random password nobody ever sees (the
 * customer sets their own through the invite). Returns the new id, or null
 * when the email was taken meanwhile (a race; the caller re-checks).
 */
export async function createCustomerAccount(
  actor: AdminActor,
  profile: {
    name: string;
    email: string;
    company: string | null;
    country: string | null;
    accessExpiresAt: Date | null;
  },
): Promise<string | null> {
  try {
    const { user } = await withAuth((auth) =>
      auth.api.createUser({
        headers: actor.headers,
        body: {
          email: profile.email,
          name: profile.name,
          password: randomBytes(32).toString("base64url"),
          role: "customer",
          data: {
            mustChangePassword: true,
            accessExpiresAt: profile.accessExpiresAt,
            company: profile.company,
            country: profile.country,
          },
        },
      }),
    );
    return user.id;
  } catch (error) {
    if (apiErrorCode(error)?.startsWith("USER_ALREADY_EXISTS")) return null;
    throw error;
  }
}

/**
 * Sets or extends a customer's access (plan Q5) through the one user-field
 * writer. Returns the stored value. "months" count from the later of today
 * and the current expiry; "date" and "none" set it outright.
 */
export async function applyAccess(
  customer: CustomerDoc,
  choice: AccessChoice,
  now: Date,
): Promise<Date | null> {
  const accessExpiresAt = computeAccessExpiry(choice, {
    now,
    current: customer.accessExpiresAt ?? null,
  });
  const context = await getAuthContext();
  await updateAccountFields(context, customer._id.toHexString(), {
    accessExpiresAt,
  });
  return accessExpiresAt;
}

/**
 * True when the new end really gives the customer MORE access than before:
 * no end where there was one, or a future end later than the old end (an
 * ended access re-opened counts). Shortening, an unchanged end, a past end
 * or "no expiry" replaced by a date never count.
 */
export function accessGrew(
  before: Date | null,
  after: Date | null,
  now: Date,
): boolean {
  if (after === null) return before !== null;
  if (before === null) return false;
  return after.getTime() > now.getTime() && after.getTime() > before.getTime();
}

/**
 * The optional "access extended" email (plan Q4). Sent only when access
 * really grew (accessGrew) and the customer is not blocked, so nobody is
 * told "extended" when it was shortened or downloads stay locked.
 * `customer.accessExpiresAt` is the value BEFORE the change. Returns whether
 * it was sent; failures are logged, never thrown.
 */
export async function notifyAccessExtended(
  customer: CustomerDoc,
  accessExpiresAt: Date | null,
  now: Date,
): Promise<boolean> {
  if (
    isBlocked(customer, now) ||
    !accessGrew(customer.accessExpiresAt ?? null, accessExpiresAt, now)
  ) {
    return false;
  }
  try {
    await sendAccessExtendedEmail({
      to: customer.email,
      name: customer.name,
      accessExpiresAt,
    });
    return true;
  } catch (error) {
    logProblem("access-extended email not sent", error);
    return false;
  }
}

/* A failure of our own systems, shown as one generic sentence. */
const TRY_AGAIN = "Something went wrong. Please try again.";

/*
 * Runs a write step and turns infrastructure failures into a generic form
 * error (logged by type only). Everything else is a programming error and
 * is thrown.
 */
async function guarded<T>(
  what: string,
  run: () => Promise<ServiceResult<T>>,
): Promise<ServiceResult<T>> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof RateLimitUnavailableError ||
      error instanceof AccountWriteError ||
      isAPIError(error) ||
      (error instanceof Error && error.name.startsWith("Mongo"))
    ) {
      logProblem(what, error);
      return formError(TRY_AGAIN);
    }
    throw error;
  }
}

/** The form message for a refused invite (limited or busy). */
export function inviteRefusalMessage(outcome: InviteOutcome): string | null {
  if (outcome.state === "limited") {
    const minutes = Math.max(1, Math.ceil(outcome.retryAfterSeconds / 60));
    return `Too many new links for this customer. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }
  if (outcome.state === "busy") {
    return "A new link for this customer is already being made. Wait a moment.";
  }
  if (outcome.state === "failed") {
    return "The new link could not be made. Please try again.";
  }
  return null;
}

/* Only the parts of an invite outcome that may go into audit meta. */
const inviteMeta = (outcome: InviteOutcome | null) =>
  outcome === null ? "none" : outcome.state;

// ---------------------------------------------------------------------------
// Reads (admin only, never cached)
// ---------------------------------------------------------------------------

/* Escapes text for use inside a RegExp (search box input). */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/* "Accepted" = a password chosen at or after the latest invite. */
const INVITE_ACCEPTED = { $gte: ["$passwordSetAt", "$invitedAt"] };

/**
 * Never invited, or the latest invite was accepted (a password chosen at or
 * after it). The complement of "invite pending or expired" (the same
 * invitedAt vs passwordSetAt rule as customerStatusFilter); the expiry
 * reminder only goes to these customers (ADR 0072 amendment).
 */
export const INVITE_SETTLED = {
  $or: [{ invitedAt: null }, { $expr: INVITE_ACCEPTED }],
};

/**
 * The MongoDB filter for one status (plan Q10) at `now`. Exported for the
 * dashboard counts so both always agree.
 * - blocked: banned with no end, or an end still ahead;
 * - active / expiring / expired: NOT blocked, by accessExpiresAt
 *   (active = no expiry or ends after now; expiring = ends within 30 days;
 *   expired = ended);
 * - invite_pending / invite_expired: invited, password not chosen since the
 *   invite ($expr comparing passwordSetAt and invitedAt), link still valid
 *   (inviteExpiresAt > now) or not (missing or <= now, fail closed).
 */
export function customerStatusFilter(
  status: CustomerStatusFilter,
  now: Date,
): Record<string, unknown> {
  const notBlocked = {
    $or: [{ banned: { $ne: true } }, { banExpires: { $lte: now } }],
  };
  const notAccepted = { $expr: { $not: [INVITE_ACCEPTED] } };
  switch (status) {
    case "blocked":
      return {
        $and: [
          { banned: true },
          { $or: [{ banExpires: null }, { banExpires: { $gt: now } }] },
        ],
      };
    case "active":
      return {
        $and: [
          notBlocked,
          {
            $or: [{ accessExpiresAt: null }, { accessExpiresAt: { $gt: now } }],
          },
        ],
      };
    case "expiring":
      return {
        $and: [
          notBlocked,
          {
            accessExpiresAt: {
              $gt: now,
              $lte: new Date(now.getTime() + EXPIRING_SOON_DAYS * MS_PER_DAY),
            },
          },
        ],
      };
    case "expired":
      return { $and: [notBlocked, { accessExpiresAt: { $lte: now } }] };
    case "invite_pending":
      return {
        $and: [
          { invitedAt: { $ne: null } },
          { inviteExpiresAt: { $gt: now } },
          notAccepted,
        ],
      };
    case "invite_expired":
      return {
        $and: [
          { invitedAt: { $ne: null } },
          {
            $or: [
              { inviteExpiresAt: null },
              { inviteExpiresAt: { $lte: now } },
            ],
          },
          notAccepted,
        ],
      };
  }
}

/** Customers only: the customer role, and never the admin account. */
export const CUSTOMERS_ONLY = {
  $and: [{ role: { $regex: CUSTOMER_ROLE } }, { role: { $not: ADMIN_ROLE } }],
};

const SORTS: Record<CustomerSort, Record<string, 1 | -1>> = {
  // Soonest end first; "no expiry" last.
  expiry: { _expirySort: 1, _id: 1 },
  created: { createdAt: -1, _id: -1 },
  name: { name: 1, _id: 1 },
};

export interface CustomerListPage {
  rows: CustomerSummary[];
  page: number;
  pageCount: number;
  total: number;
}

/**
 * The customers list (plan Q10): search name/email/company (the text is
 * regex-escaped, case-insensitive), one status filter, sort by expiry,
 * created or name, 50 per page; a page past the end shows the last page.
 * Invalid input gets the first page of everything. Not index-backed:
 * Better Auth owns `users` and its indexes, and customers number hundreds.
 */
export async function listCustomers(
  actor: AdminActor,
  input: unknown,
  options: { now?: Date } = {},
): Promise<CustomerListPage> {
  await assertAdminActor(actor);
  const parsed = listCustomersSchema.safeParse(input);
  const query = parsed.success ? parsed.data : listCustomersSchema.parse({});
  const now = options.now ?? new Date();

  const conditions: Record<string, unknown>[] = [CUSTOMERS_ONLY];
  if (query.q) {
    const pattern = { $regex: escapeRegex(query.q), $options: "i" };
    conditions.push({
      $or: [{ name: pattern }, { email: pattern }, { company: pattern }],
    });
  }
  if (query.status) conditions.push(customerStatusFilter(query.status, now));
  const match = { $and: conditions };

  await connectDb();
  const total = await UserModel.countDocuments(match).exec();
  const pageCount = Math.max(1, Math.ceil(total / CUSTOMERS_PAGE_SIZE));
  const page = Math.min(query.page, pageCount);
  if (total === 0) return { rows: [], page: 1, pageCount, total };

  const docs = await UserModel.aggregate<CustomerDoc>(
    [
      { $match: match },
      {
        $addFields: {
          _expirySort: { $ifNull: ["$accessExpiresAt", NO_EXPIRY_SORT] },
        },
      },
      { $sort: SORTS[query.sort] },
      { $skip: (page - 1) * CUSTOMERS_PAGE_SIZE },
      { $limit: CUSTOMERS_PAGE_SIZE },
      { $project: CUSTOMER_PROJECTION },
    ],
    // Name sort ignores case ("anna" next to "Anna").
    { collation: { locale: "en", strength: 2 } },
  ).exec();

  return {
    rows: docs.map((doc) => toSummary(doc, now)),
    page,
    pageCount,
    total,
  };
}

/** An access request linked to a customer (by account or by email). */
export interface LinkedRequest {
  id: string;
  kind: AccessRequestKind;
  source: AccessRequestSource;
  status: AccessRequestStatus;
  createdAt: Date;
  handledAt: Date | null;
}

/** One audit entry about the customer: the action and when, ids only. */
export interface CustomerAuditEntry {
  id: string;
  action: string;
  createdAt: Date;
}

export interface CustomerPage {
  customer: CustomerDetail;
  downloads: DownloadHistoryPage;
  requests: LinkedRequest[];
  audit: CustomerAuditEntry[];
}

const LINKED_LIMIT = 50;

/**
 * The customer page: profile and status, one page of download history,
 * linked access requests (by account or email) and the audit trail (entries
 * about the customer, or approvals that created/extended them). Null for an
 * unknown id, a non-customer or the admin.
 */
export async function getCustomer(
  actor: AdminActor,
  input: unknown,
  options: { now?: Date } = {},
): Promise<CustomerPage | null> {
  await assertAdminActor(actor);
  const parsed = customerDetailSchema.safeParse(input);
  if (!parsed.success) return null;
  const { userId, page } = parsed.data;
  const doc = await findCustomer(userId);
  if (!doc) return null;
  const now = options.now ?? new Date();

  const [downloads, requests, audit] = await Promise.all([
    getDownloadHistory(userId, page),
    AccessRequestModel.find(
      { $or: [{ user: new Types.ObjectId(userId) }, { email: doc.email }] },
      { kind: 1, source: 1, status: 1, createdAt: 1, handledAt: 1 },
    )
      .sort({ createdAt: -1 })
      .limit(LINKED_LIMIT)
      .lean()
      .exec(),
    AuditLogModel.find(
      {
        $or: [
          { "target.type": "customer", "target.id": userId },
          { "meta.userId": userId },
        ],
      },
      { action: 1, createdAt: 1 },
    )
      .sort({ createdAt: -1 })
      .limit(LINKED_LIMIT)
      .lean()
      .exec(),
  ]);

  return {
    customer: { ...toSummary(doc, now), banReason: doc.banReason ?? null },
    downloads,
    requests: requests.map((r) => ({
      id: r._id.toHexString(),
      kind: r.kind ?? "new",
      source: r.source,
      status: r.status,
      createdAt: r.createdAt,
      handledAt: r.handledAt ?? null,
    })),
    audit: audit.map((entry) => ({
      id: entry._id.toHexString(),
      action: entry.action,
      createdAt: entry.createdAt,
    })),
  };
}

/** Dashboard figures for the customers module (cheap counts). */
export async function getCustomerCounts(
  actor: AdminActor,
  options: { now?: Date } = {},
): Promise<{ expiringSoon: number; invitesExpired: number }> {
  await assertAdminActor(actor);
  const now = options.now ?? new Date();
  await connectDb();
  const [expiringSoon, invitesExpired] = await Promise.all([
    UserModel.countDocuments({
      $and: [CUSTOMERS_ONLY, customerStatusFilter("expiring", now)],
    }).exec(),
    UserModel.countDocuments({
      $and: [CUSTOMERS_ONLY, customerStatusFilter("invite_expired", now)],
    }).exec(),
  ]);
  return { expiringSoon, invitesExpired };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Creates a customer by hand (plan Q1): the chosen expiry, mustChangePassword
 * true, a random password nobody sees, and an invite emailed or shown once.
 * An email that already has an account is refused (this admin-only screen
 * may say so); use set/extend access on the existing customer instead.
 */
export async function createCustomer(
  actor: AdminActor,
  input: unknown,
  options: { now?: Date } = {},
): Promise<
  ServiceResult<{
    userId: string;
    accessExpiresAt: Date | null;
    invite: InviteOutcome;
    auditFailed: boolean;
  }>
> {
  const refused = await refuseUnlessAdmin(actor, "customers");
  if (refused) return refused;
  const parsed = createCustomerSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const data = parsed.data;
  const now = options.now ?? new Date();

  return guarded("customer not created", async () => {
    const taken = () =>
      fieldError("email", "An account with this email already exists.");
    if (await findAccountByEmail(data.email)) return taken();
    const accessExpiresAt = computeAccessExpiry(data.access, { now });
    const userId = await createCustomerAccount(actor, {
      name: data.name,
      email: data.email,
      company: data.company,
      country: data.country,
      accessExpiresAt,
    });
    if (userId === null) return taken();
    const invite = await issueInvite(
      { id: userId, email: data.email, name: data.name },
      data.delivery,
    );
    return auditKeepingData(
      {
        actorId: actor.id,
        action: "customer.create",
        target: { type: "customer", id: userId },
        meta: { access: data.access.kind, invite: inviteMeta(invite) },
      },
      { userId, accessExpiresAt, invite },
      [],
    );
  });
}

/** Edits name, company and country (the email is not editable). */
export async function updateCustomerProfile(
  actor: AdminActor,
  input: unknown,
): Promise<ServiceResult<{ userId: string }>> {
  const refused = await refuseUnlessAdmin(actor, "customers");
  if (refused) return refused;
  const parsed = updateCustomerProfileSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { userId, ...profile } = parsed.data;

  return guarded("customer not updated", async () => {
    const doc = await findCustomer(userId);
    if (!doc) return formError(NOT_FOUND);
    const fields = (["name", "company", "country"] as const).filter(
      (field) => (doc[field] ?? null) !== profile[field],
    );
    if (fields.length === 0) return unchanged({ userId });
    const context = await getAuthContext();
    await updateAccountFields(context, userId, profile);
    return auditAndFinish(
      {
        actorId: actor.id,
        action: "customer.update",
        target: { type: "customer", id: userId },
        meta: { fields: [...fields] },
      },
      { userId },
      [],
    );
  });
}

/**
 * Sets or extends access (plan Q5) and, when asked and the new end is still
 * ahead, emails "access extended". Never touches the invite.
 */
export async function setCustomerAccess(
  actor: AdminActor,
  input: unknown,
  options: { now?: Date } = {},
): Promise<ServiceResult<{ accessExpiresAt: Date | null; notified: boolean }>> {
  const refused = await refuseUnlessAdmin(actor, "customers");
  if (refused) return refused;
  const parsed = setCustomerAccessSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { userId, access, notify } = parsed.data;
  const now = options.now ?? new Date();

  return guarded("access not set", async () => {
    const doc = await findCustomer(userId);
    if (!doc) return formError(NOT_FOUND);
    const accessExpiresAt = await applyAccess(doc, access, now);
    const notified = notify
      ? await notifyAccessExtended(doc, accessExpiresAt, now)
      : false;
    return auditAndFinish(
      {
        actorId: actor.id,
        action: "customer.access.set",
        target: { type: "customer", id: userId },
        meta: { access: access.kind, notified },
      },
      { accessExpiresAt, notified },
      [],
    );
  });
}

/**
 * Blocks a customer (Better Auth banUser, as the admin): sessions are
 * deleted by Better Auth and our after-hook bumps the device epoch. The
 * reason is stored on the user (admin-only), never in the audit log.
 */
export async function banCustomer(
  actor: AdminActor,
  input: unknown,
): Promise<ServiceResult<{ userId: string }>> {
  const refused = await refuseUnlessAdmin(actor, "customers");
  if (refused) return refused;
  const parsed = banCustomerSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { userId, reason } = parsed.data;

  return guarded("customer not blocked", async () => {
    if (!(await findCustomer(userId))) return formError(NOT_FOUND);
    await withAuth((auth) =>
      auth.api.banUser({
        headers: actor.headers,
        body: { userId, banReason: reason },
      }),
    );
    return auditAndFinish(
      {
        actorId: actor.id,
        action: "customer.ban",
        target: { type: "customer", id: userId },
      },
      { userId },
      [],
    );
  });
}

/** Lifts a block (Better Auth unbanUser). No-op when not blocked. */
export async function unbanCustomer(
  actor: AdminActor,
  input: unknown,
): Promise<ServiceResult<{ userId: string }>> {
  const refused = await refuseUnlessAdmin(actor, "customers");
  if (refused) return refused;
  const parsed = customerIdSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { userId } = parsed.data;

  return guarded("customer not unblocked", async () => {
    const doc = await findCustomer(userId);
    if (!doc) return formError(NOT_FOUND);
    if (doc.banned !== true) return unchanged({ userId });
    await withAuth((auth) =>
      auth.api.unbanUser({ headers: actor.headers, body: { userId } }),
    );
    return auditAndFinish(
      {
        actorId: actor.id,
        action: "customer.unban",
        target: { type: "customer", id: userId },
      },
      { userId },
      [],
    );
  });
}

/** Ends every session of the customer (Better Auth revokeUserSessions). */
export async function revokeCustomerSessions(
  actor: AdminActor,
  input: unknown,
): Promise<ServiceResult<{ userId: string }>> {
  const refused = await refuseUnlessAdmin(actor, "customers");
  if (refused) return refused;
  const parsed = customerIdSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { userId } = parsed.data;

  return guarded("sessions not revoked", async () => {
    if (!(await findCustomer(userId))) return formError(NOT_FOUND);
    await withAuth((auth) =>
      auth.api.revokeUserSessions({ headers: actor.headers, body: { userId } }),
    );
    return auditAndFinish(
      {
        actorId: actor.id,
        action: "customer.sessions.revoke",
        target: { type: "customer", id: userId },
      },
      { userId },
      [],
    );
  });
}

/**
 * Emails the customer a normal 1 h reset link through Better Auth's own
 * request-password-reset (its per-email and per-network limits apply; the
 * email goes out in the background). A completed reset clears
 * mustChangePassword (ADR 0068).
 */
export async function sendCustomerResetLink(
  actor: AdminActor,
  input: unknown,
): Promise<ServiceResult<{ userId: string }>> {
  const refused = await refuseUnlessAdmin(actor, "customers");
  if (refused) return refused;
  const parsed = customerIdSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { userId } = parsed.data;

  return guarded("reset link not sent", async () => {
    const doc = await findCustomer(userId);
    if (!doc) return formError(NOT_FOUND);
    try {
      await withAuth((auth) =>
        auth.api.requestPasswordReset({
          headers: actor.headers,
          body: { email: doc.email, redirectTo: "/reset-password" },
        }),
      );
    } catch (error) {
      if (isAPIError(error) && error.statusCode === 429) {
        return formError(
          "Too many reset emails for this customer. Try again later.",
        );
      }
      throw error;
    }
    return auditAndFinish(
      {
        actorId: actor.id,
        action: "customer.password.link",
        target: { type: "customer", id: userId },
      },
      { userId },
      [],
    );
  });
}

/** A random temporary password from PASSWORD_ALPHABET (unbiased). */
export function generateTemporaryPassword(): string {
  let password = "";
  for (let i = 0; i < TEMPORARY_PASSWORD_LENGTH; i += 1) {
    password += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return password;
}

/**
 * The WhatsApp fallback (plan Q1): a generated temporary password, returned
 * ONCE for the admin to pass on; never stored readable, logged or audited.
 * Order (fail safe):
 * 1. every reset/invite link dies, the invite fields are cleared (status
 *    "none") and mustChangePassword is set: if step 2 then fails, nothing
 *    is weaker than before;
 * 2. Better Auth setUserPassword, as the admin; our after-hook deletes the
 *    customer's sessions and bumps the device epoch.
 */
export async function setTemporaryPassword(
  actor: AdminActor,
  input: unknown,
): Promise<
  ServiceResult<{ userId: string; password: string; auditFailed: boolean }>
> {
  const refused = await refuseUnlessAdmin(actor, "customers");
  if (refused) return refused;
  const parsed = customerIdSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { userId } = parsed.data;

  return guarded("temporary password not set", async () => {
    if (!(await findCustomer(userId))) return formError(NOT_FOUND);
    const context = await getAuthContext();
    await revokePasswordLinks(context, userId);
    await updateAccountFields(context, userId, {
      mustChangePassword: true,
      invitedAt: null,
      inviteExpiresAt: null,
    });
    const password = generateTemporaryPassword();
    await withAuth((auth) =>
      auth.api.setUserPassword({
        headers: actor.headers,
        body: { userId, newPassword: password },
      }),
    );
    return auditKeepingData(
      {
        actorId: actor.id,
        action: "customer.password.temp",
        target: { type: "customer", id: userId },
      },
      { userId, password },
      [],
    );
  });
}

/**
 * A new invite link at any time (plan Q1 addition): emailed, or returned
 * once for copying into WhatsApp. Earlier links die; accessExpiresAt and
 * mustChangePassword are untouched. Limited per customer and refused while
 * another one is being made. A blocked customer can't use a link, so the
 * admin unblocks first.
 */
export async function regenerateInvite(
  actor: AdminActor,
  input: unknown,
  options: { now?: Date } = {},
): Promise<
  ServiceResult<{ userId: string; invite: InviteOutcome; auditFailed: boolean }>
> {
  const refused = await refuseUnlessAdmin(actor, "customers");
  if (refused) return refused;
  const parsed = regenerateInviteSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { userId, delivery } = parsed.data;
  const now = options.now ?? new Date();

  return guarded("invite not made", async () => {
    const doc = await findCustomer(userId);
    if (!doc) return formError(NOT_FOUND);
    if (isBlocked(doc, now)) {
      return formError("Unblock this customer before sending a new link.");
    }
    const invite = await issueInvite(
      { id: userId, email: doc.email, name: doc.name },
      delivery,
    );
    const refusal = inviteRefusalMessage(invite);
    if (refusal) return formError(refusal);
    return auditKeepingData(
      {
        actorId: actor.id,
        action: "customer.invite.resend",
        target: { type: "customer", id: userId },
        meta: { delivery, invite: inviteMeta(invite) },
      },
      { userId, invite },
      [],
    );
  });
}
