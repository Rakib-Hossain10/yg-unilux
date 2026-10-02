// Server-only transactional email on Resend. One generic sender, sendEmail(),
// plus one function per template (only the password reset for now); later
// templates (account created, expiry reminder, whistleblower alert) go here too.

import "server-only";

import { Resend } from "resend";
import { z } from "zod";

import { env } from "./env";

/*
 * No verified sending domain yet (user decision, Phase 1). EMAIL_FROM is then
 * Resend's test sender (e.g. onboarding@resend.dev), and Resend delivers only
 * to the Resend account owner's own address; every other recipient fails with
 * a provider error. Verify a domain in Resend and change EMAIL_FROM to go live.
 */

/** Why a send failed. Safe to log: nothing here identifies the recipient. */
export type EmailFailureReason =
  /** The caller passed an invalid address, subject or body. */
  | "invalid_input"
  /** A template link was not an allowed absolute http(s) URL. */
  | "invalid_link"
  /** Resend answered with an error (see statusCode / providerCode). */
  | "provider_error"
  /** The SDK threw instead of returning an error (should not happen). */
  | "unexpected";

/**
 * A send failed. The message is built only from fixed text, the HTTP status
 * and Resend's error code, and no `cause` is chained: Resend's error messages
 * and Zod issues can echo the recipient address or the body, which holds the
 * reset link, and loggers print causes.
 */
export class EmailSendError extends Error {
  override readonly name = "EmailSendError";
  readonly reason: EmailFailureReason;
  readonly statusCode: number | undefined;
  readonly providerCode: string | undefined;

  constructor(
    reason: EmailFailureReason,
    details: { statusCode?: number; providerCode?: string } = {},
  ) {
    const parts = [`Email not sent: ${reason}`];
    if (details.statusCode !== undefined)
      parts.push(`status ${details.statusCode}`);
    if (details.providerCode !== undefined)
      parts.push(`code ${details.providerCode}`);
    super(parts.join(", "));
    this.reason = reason;
    this.statusCode = details.statusCode;
    this.providerCode = details.providerCode;
  }
}

/** What every email needs. Both bodies are required: HTML plus a plain-text fallback. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Optional Resend Idempotency-Key, so a retried job never sends twice. */
  idempotencyKey?: string;
}

// Validates the generic message. A CR/LF in the subject is refused outright
// so no caller can ever smuggle in an extra header line.
const messageSchema = z.object({
  to: z.email(),
  subject: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]*$/),
  text: z.string().min(1),
  html: z.string().min(1),
  idempotencyKey: z.string().min(1).max(256).optional(),
});

/*
 * The Resend client and sender address, created on the first send. Importing
 * this module reads no env, so `next build` and tests need no secrets; a
 * missing RESEND_API_KEY or EMAIL_FROM surfaces as EnvError at send time.
 */
let transport: { client: Resend; from: string } | undefined;

function getTransport(): { client: Resend; from: string } {
  if (!transport) {
    const { resendApiKey, from } = env.email();
    transport = { client: new Resend(resendApiKey), from };
  }
  return transport;
}

// Resend's error fields come from the API's JSON, so accept them only in the
// expected shape; anything else could carry echoed input into our message.
function safeStatus(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z_]{1,64}$/.test(value)
    ? value
    : undefined;
}

/**
 * Sends one email through Resend and resolves with its Resend id.
 *
 * Rejects with EmailSendError on invalid input or any provider failure, and
 * with EnvError if Resend is not configured. The installed SDK returns
 * `{ data, error }` instead of throwing, and has no timeout option; the
 * serverless function's own time limit bounds a hung request. Nothing is
 * logged here: callers decide what to log, and the error is safe to log.
 */
export async function sendEmail(
  message: EmailMessage,
): Promise<{ id: string }> {
  const parsed = messageSchema.safeParse(message);
  if (!parsed.success) throw new EmailSendError("invalid_input");
  const { idempotencyKey, ...content } = parsed.data;

  const { client, from } = getTransport();

  let response: Awaited<ReturnType<Resend["emails"]["send"]>>;
  try {
    response = await client.emails.send(
      { from, ...content },
      idempotencyKey ? { idempotencyKey } : undefined,
    );
  } catch {
    // The original error is dropped on purpose (it may contain the payload).
    throw new EmailSendError("unexpected");
  }

  if (response.error) {
    throw new EmailSendError("provider_error", {
      statusCode: safeStatus(response.error.statusCode),
      providerCode: safeCode(response.error.name),
    });
  }
  return { id: response.data.id };
}

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

const BRAND = "YG UniLUX";

/** Escapes text for use in HTML element content and double-quoted attributes. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Validates a link before it goes into an email: it must be an absolute
 * https URL without embedded credentials. http is allowed only for
 * `localhost` and only outside production, for local development. Anything
 * else (javascript:, data:, relative links) is refused, so an unsafe link can
 * never be sent. Returns the normalised URL.
 */
function requireSafeLink(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EmailSendError("invalid_link");
  }
  const isHttps = url.protocol === "https:";
  const isLocalDev =
    url.protocol === "http:" &&
    url.hostname === "localhost" &&
    !env.isProduction();
  if (!(isHttps || isLocalDev) || url.username !== "" || url.password !== "") {
    throw new EmailSendError("invalid_link");
  }
  return url.href;
}

/** A user's display name for a greeting: whitespace collapsed, length capped. */
function displayName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 100);
}

/*
 * Wraps body paragraphs in a minimal, accessible HTML document: language set,
 * no external images, fonts, stylesheets or tracking pixels, inline styles
 * only. Every value in `bodyHtml` must already be escaped by the caller.
 */
function htmlLayout(title: string, bodyHtml: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    '<body style="margin:0;padding:24px;background:#ffffff;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;">',
    `<p style="margin:0 0 24px;font-size:20px;font-weight:bold;letter-spacing:0.05em;">${BRAND}</p>`,
    bodyHtml,
    "</body>",
    "</html>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Lifetime of a password-reset link, 1 hour (ADR 0017). The single source of
 * truth: task 5 passes it to Better Auth's `resetPasswordTokenExpiresIn`, and
 * the email text below is derived from it, so the two can never disagree.
 */
export const PASSWORD_RESET_TOKEN_TTL_SECONDS = 60 * 60;

/** "1 hour", "2 hours" or "15 minutes", for the expiry sentence. */
function describeDuration(seconds: number): string {
  const plural = (n: number, unit: string) =>
    `${n} ${unit}${n === 1 ? "" : "s"}`;
  return seconds % 3600 === 0
    ? plural(seconds / 3600, "hour")
    : plural(Math.ceil(seconds / 60), "minute");
}

const RESET_LINK_LIFETIME_TEXT = describeDuration(
  PASSWORD_RESET_TOKEN_TTL_SECONDS,
);

/**
 * Sends the password-reset email (Better Auth `sendResetPassword`, task 5).
 *
 * `url` is the reset link and contains the token: a password-reset
 * credential. It is never logged and never placed in an error.
 *
 * Rejects on failure. The caller must answer the HTTP request the same way,
 * and in about the same time, whether or not the account exists and whether
 * or not this send succeeds, so the reset form cannot be used to discover
 * which emails have accounts.
 */
export async function sendPasswordResetEmail(input: {
  to: string;
  name: string;
  url: string;
}): Promise<{ id: string }> {
  const link = requireSafeLink(input.url);
  const name = displayName(input.name);
  const greeting = name ? `Hello ${name},` : "Hello,";
  const subject = `Reset your ${BRAND} password`;

  const text = [
    greeting,
    "",
    `We received a request to reset the password for your ${BRAND} account.`,
    "Open this link to choose a new password:",
    "",
    link,
    "",
    `The link expires in ${RESET_LINK_LIFETIME_TEXT}.`,
    "",
    "If you didn't ask for this, ignore this email. Your password will not change.",
    "",
    BRAND,
  ].join("\n");

  const safeLink = escapeHtml(link);
  const html = htmlLayout(
    subject,
    [
      `<p style="margin:0 0 16px;">${escapeHtml(greeting)}</p>`,
      `<p style="margin:0 0 16px;">${escapeHtml(
        `We received a request to reset the password for your ${BRAND} account.`,
      )}</p>`,
      `<p style="margin:0 0 16px;"><a href="${safeLink}" style="display:inline-block;padding:12px 20px;background:#1a1a1a;color:#ffffff;text-decoration:none;">Reset your password</a></p>`,
      `<p style="margin:0 0 16px;">If the button does not work, copy this link into your browser:<br><a href="${safeLink}" style="color:#1a1a1a;word-break:break-all;">${safeLink}</a></p>`,
      `<p style="margin:0 0 16px;">The link expires in ${RESET_LINK_LIFETIME_TEXT}.</p>`,
      `<p style="margin:0;">${escapeHtml(
        "If you didn't ask for this, ignore this email. Your password will not change.",
      )}</p>`,
    ].join("\n"),
  );

  return sendEmail({ to: input.to, subject, text, html });
}
