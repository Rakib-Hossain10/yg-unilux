// The daily access-expiry reminder (plan Q4, Q11, P5; ADR 0072). Customers
// whose datasheet access ends within the next 7 days get ONE reminder per
// expiry date; the company inbox gets a digest of who was reminded. Run by
// GET /api/cron/access-expiry (Vercel Cron) and `npm run cron:expiry`.

import "server-only";

import { createHash } from "node:crypto";

import type { Types } from "mongoose";
import { z } from "zod";

import { type AccountContext, updateAccountFields } from "@/lib/account-writes";
import { CUSTOMERS_ONLY, INVITE_SETTLED } from "@/lib/admin/customers";
import { getAuthContext } from "@/lib/auth";
import { getCompanyAlertEmail } from "@/lib/contact-settings";
import { connectDb } from "@/lib/db";
import {
  EmailSendError,
  sendExpiryDigestEmail,
  sendExpiryReminderEmail,
  type ExpiryDigestEntry,
} from "@/lib/email";
import { acquireLock, buildKey, releaseLock } from "@/lib/rate-limit";
import { AuditLogModel, UserModel } from "@/models";
import type { User } from "@/models/user";

/*
 * How it stays correct (ADR 0072):
 * - Idempotent: a customer is due while `expiryReminderFor` differs from
 *   `accessExpiresAt`; after a successful send it is set to that date. A
 *   second run finds nobody. An extension changes `accessExpiresAt`, so the
 *   customer is due again before the NEW date. A missed day is caught up,
 *   because the window is "ends within 7 days", not "ends in exactly 7".
 * - One run at a time: a lock in loginAttempts (acquireLock, owner token),
 *   held longer than a run can last. Each reminder also carries a Resend
 *   Idempotency-Key (user id + expiry), so even a run that outlived its lock
 *   can't send the same reminder twice within Resend's 24 h key window.
 * - Writes to `users` go only through account-writes (never Mongoose).
 * - Logs and the audit entry hold counts and error types only: never an
 *   email, a name or a provider message.
 */

/** Reminders go out when access ends within this many days. */
export const REMINDER_WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Customers read per query. */
export const REMINDER_BATCH_SIZE = 50;

/**
 * Wall-clock budget for starting new sends. The route's maxDuration is
 * 300 s; stopping new sends at 240 s leaves room for the last send, the
 * digest and the audit entry. Customers not reached stay due and are
 * reminded on the next run (`truncated` in the summary).
 */
export const RUN_BUDGET_MS = 240_000;

/**
 * The lock outlives the longest possible run (route maxDuration 300 s), so
 * a second run can't start while the first is still sending. A crashed run
 * frees it by itself after this long.
 */
export const RUN_LOCK_SECONDS = 330;

/**
 * Pause between reminder sends. Resend's default API limit is 2 requests
 * per second; sending sequentially with this pause keeps under it.
 */
export const SEND_PAUSE_MS = 600;

/** The digest is tried this many times before the run reports it failed. */
const DIGEST_ATTEMPTS = 2;

/** What a run did. Counts only: safe to return from the route and to audit. */
export interface ExpiryReminderSummary {
  /**
   * "busy": another run held the lock, so this one did nothing.
   * "aborted": a database failure stopped the run part-way; the counts,
   * the digest and the audit entry cover what was done before it.
   */
  status: "completed" | "busy" | "aborted";
  dryRun: boolean;
  /** Customers due a reminder when the run started. */
  due: number;
  /** Reminders sent (and marked). */
  sent: number;
  /** Reminders that could not be sent; those customers stay due. */
  failed: number;
  /**
   * Reminders sent whose `expiryReminderFor` write failed. They stay due,
   * so a later run may remind them once more (after Resend's 24 h key).
   */
  markFailed: number;
  /** Customers left for the next run because the time budget ran out. */
  truncated: boolean;
  /** "skipped" in a dry run or when nobody was reminded. */
  digest: "sent" | "skipped" | "failed" | "no_recipient";
}

export interface ExpiryReminderOptions {
  /** Read and count only: no lock, no email, no write, no audit. */
  dryRun?: boolean;
  /** Overrides for tests and the CLI. */
  now?: Date;
  pauseMs?: number;
  budgetMs?: number;
  batchSize?: number;
  /** Better Auth's context; defaults to the app's (the CLI passes its own). */
  accountContext?: AccountContext;
}

/* Only these fields are read; never anything else from `users`. */
const PROJECTION = {
  _id: 1,
  name: 1,
  email: 1,
  company: 1,
  accessExpiresAt: 1,
} as const;
type DueUser = Pick<User, "_id" | "name" | "email" | "company"> & {
  accessExpiresAt: Date;
};

/** Validates what the CLI and the route pass in (rule 8). */
const optionsSchema = z
  .object({
    dryRun: z.boolean().optional(),
    now: z
      .date()
      .refine((d) => !Number.isNaN(d.getTime()))
      .optional(),
    pauseMs: z.number().int().min(0).max(10_000).optional(),
    budgetMs: z.number().int().min(0).max(RUN_BUDGET_MS).optional(),
    batchSize: z.number().int().min(1).max(500).optional(),
  })
  .strict();

/**
 * The customers due a reminder at `now`:
 * - customers only (never the admin, also when it holds both roles);
 * - not blocked (no ban, or a timed ban that has ended, as isBanned());
 * - access ends after now and within 7 days (null expiry and already
 *   expired are out);
 * - not yet reminded about THIS expiry date;
 * - not waiting on an invite: never invited, or a password chosen at or
 *   after the latest invite (ADR 0072 amendment). A customer who never
 *   accepted their invite gets no reminder; once they set a password they
 *   become due like anyone else.
 * Exported so tests and the dashboard can agree with the run.
 */
export function dueFilter(now: Date): Record<string, unknown> {
  return {
    $and: [
      CUSTOMERS_ONLY,
      { $or: [{ banned: { $ne: true } }, { banExpires: { $lte: now } }] },
      {
        accessExpiresAt: {
          $gt: now,
          $lte: new Date(now.getTime() + REMINDER_WINDOW_DAYS * MS_PER_DAY),
        },
      },
      { $expr: { $ne: ["$expiryReminderFor", "$accessExpiresAt"] } },
      INVITE_SETTLED,
    ],
  };
}

/* The lock key: one per job, not secret (the job's name, hashed to fit). */
function runLockKey() {
  const digest = createHash("sha256").update("expiry-reminders").digest("hex");
  return buildKey("cron-lock", digest);
}

/* Error type (and the provider's status/code for email): never a message. */
function describeError(error: unknown): string {
  if (error instanceof EmailSendError) {
    return [error.name, error.reason, error.statusCode, error.providerCode]
      .filter((part) => part !== undefined)
      .join(" ");
  }
  return error instanceof Error ? error.name : typeof error;
}

function logProblem(what: string, error: unknown): void {
  console.error(`[expiry-reminders] ${what}: ${describeError(error)}`);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBatch(
  now: Date,
  exclude: Types.ObjectId[],
  limit: number,
): Promise<DueUser[]> {
  const filter = dueFilter(now);
  return UserModel.find(
    exclude.length === 0
      ? filter
      : { $and: [filter, { _id: { $nin: exclude } }] },
    PROJECTION,
  )
    .sort({ accessExpiresAt: 1, _id: 1 })
    .limit(limit)
    .lean<DueUser[]>()
    .exec();
}

/* Resend keeps an idempotency key for 24 h; ours is the reminder's identity. */
function reminderKey(user: DueUser): string {
  return `expiry-reminder/${user._id.toHexString()}/${user.accessExpiresAt.getTime()}`;
}

/* One digest per distinct set of reminded customers per UTC day. */
function digestKey(now: Date, reminded: readonly DueUser[]): string {
  const ids = reminded
    .map((user) => user._id.toHexString())
    .sort()
    .join(",");
  const hash = createHash("sha256").update(ids).digest("hex").slice(0, 32);
  return `expiry-digest/${now.toISOString().slice(0, 10)}/${hash}`;
}

async function sendDigest(
  now: Date,
  reminded: readonly DueUser[],
  retryPauseMs: number,
): Promise<ExpiryReminderSummary["digest"]> {
  if (reminded.length === 0) return "skipped";
  const to = await getCompanyAlertEmail();
  if (to === null) return "no_recipient";
  const customers: ExpiryDigestEntry[] = reminded.map((user) => ({
    name: user.name,
    company: user.company ?? null,
    accessExpiresAt: user.accessExpiresAt,
  }));
  const message = { to, customers, idempotencyKey: digestKey(now, reminded) };
  /*
   * Tried twice, the second time after a short wait (Resend's per-second
   * limit). The customers are already marked, so a lost digest is never
   * rebuilt by a later run; ADR 0072 accepts that: the admin's customers
   * list ("expiring" filter) still shows them, and the audit entry records
   * `digest: "failed"`. The same idempotency key makes the retry safe.
   */
  for (let attempt = 1; ; attempt += 1) {
    try {
      await sendExpiryDigestEmail(message);
      return "sent";
    } catch (error) {
      logProblem(`digest not sent (attempt ${attempt})`, error);
      if (attempt >= DIGEST_ATTEMPTS) return "failed";
      if (retryPauseMs > 0) await pause(retryPauseMs);
    }
  }
}

/* One actorless entry per run, counts only (audit meta policy). */
async function auditRun(summary: ExpiryReminderSummary): Promise<void> {
  try {
    await AuditLogModel.create({
      action: "cron.expiry_reminders",
      meta: {
        due: summary.due,
        sent: summary.sent,
        failed: summary.failed,
        markFailed: summary.markFailed,
        truncated: summary.truncated,
        aborted: summary.status === "aborted",
        digest: summary.digest,
      },
    });
  } catch (error) {
    logProblem("audit entry not written", error);
  }
}

/*
 * Sends the reminders, batch by batch, oldest expiry first. Send and mark
 * failures are counted on `summary`; a failed batch read throws.
 */
async function remindAll(run: {
  now: Date;
  context: AccountContext;
  summary: ExpiryReminderSummary;
  reminded: DueUser[];
  pauseMs: number;
  budgetMs: number;
  batchSize: number;
}): Promise<void> {
  const { now, context, summary, reminded, pauseMs, budgetMs } = run;
  const startedAt = Date.now();
  // Every customer is tried once per run, whatever happens to them.
  const seen: Types.ObjectId[] = [];
  for (;;) {
    const batch = await readBatch(now, seen, run.batchSize);
    if (batch.length === 0) return;
    for (const user of batch) {
      if (Date.now() - startedAt >= budgetMs) {
        summary.truncated = true;
        return;
      }
      if (seen.length > 0 && pauseMs > 0) await pause(pauseMs);
      seen.push(user._id);
      try {
        await sendExpiryReminderEmail({
          to: user.email,
          name: user.name,
          accessExpiresAt: user.accessExpiresAt,
          idempotencyKey: reminderKey(user),
        });
      } catch (error) {
        summary.failed += 1;
        logProblem("reminder not sent", error);
        continue;
      }
      summary.sent += 1;
      reminded.push(user);
      try {
        await updateAccountFields(context, user._id.toHexString(), {
          expiryReminderFor: user.accessExpiresAt,
        });
      } catch (error) {
        summary.markFailed += 1;
        logProblem("reminder sent but not marked", error);
      }
    }
  }
}

/**
 * Runs the reminder job once. Database failures before any send (the lock,
 * Better Auth's context, the count) reject. After that, send and mark
 * failures are counted and the run goes on, so one bad customer or a down
 * email provider never stops the others; a failed batch read ends the run
 * as "aborted", still with its digest and audit entry.
 */
export async function runExpiryReminders(
  options: ExpiryReminderOptions = {},
): Promise<ExpiryReminderSummary> {
  const { accountContext, ...settings } = options;
  const parsed = optionsSchema.parse(settings);
  const now = parsed.now ?? new Date();
  const dryRun = parsed.dryRun ?? false;
  const pauseMs = parsed.pauseMs ?? SEND_PAUSE_MS;
  const budgetMs = parsed.budgetMs ?? RUN_BUDGET_MS;
  const batchSize = parsed.batchSize ?? REMINDER_BATCH_SIZE;

  await connectDb();
  const summary: ExpiryReminderSummary = {
    status: "completed",
    dryRun,
    due: 0,
    sent: 0,
    failed: 0,
    markFailed: 0,
    truncated: false,
    digest: "skipped",
  };

  if (dryRun) {
    summary.due = await UserModel.countDocuments(dueFilter(now)).exec();
    return summary;
  }

  const lock = runLockKey();
  const owner = await acquireLock(lock, RUN_LOCK_SECONDS);
  if (owner === null) return { ...summary, status: "busy" };

  try {
    const context = accountContext ?? (await getAuthContext());
    summary.due = await UserModel.countDocuments(dueFilter(now)).exec();
    const reminded: DueUser[] = [];
    try {
      await remindAll({
        now,
        context,
        summary,
        reminded,
        pauseMs,
        budgetMs,
        batchSize,
      });
    } catch (error) {
      // A database failure mid-run: stop, but still send the digest for the
      // customers already reminded (they are marked, so no later run would
      // list them) and record the run.
      summary.status = "aborted";
      logProblem("run stopped early", error);
    }

    summary.digest = await sendDigest(now, reminded, Math.max(pauseMs, 0) * 2);
    await auditRun(summary);
    return summary;
  } finally {
    try {
      await releaseLock(lock, owner);
    } catch (error) {
      // The lock ends by itself after RUN_LOCK_SECONDS.
      logProblem("lock not released", error);
    }
  }
}
