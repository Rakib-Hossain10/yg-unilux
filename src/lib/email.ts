// Server-only transactional email on Resend. One generic sender, sendEmail(),
// plus one function per template: password reset, and the Phase 5 account
// emails (invite, expiry reminder, access extended, request alert, decline,
// admin digest). Nothing here logs; errors never carry an address or a link.

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

/*
 * True when the site itself runs on http://localhost (AUTH_URL), e.g. a
 * local production build for the e2e suite. A link to that same origin then
 * points at the machine the site runs on, not somewhere else. A missing or
 * invalid AUTH_URL counts as false (fail closed).
 */
function siteIsLocalhostOrigin(url: URL): boolean {
  try {
    const site = new URL(env.auth().url);
    return site.protocol === "http:" && site.hostname === "localhost"
      ? site.origin === url.origin
      : false;
  } catch {
    return false;
  }
}

/**
 * Validates a link before it goes into an email: it must be an absolute
 * https URL without embedded credentials. http is allowed only for
 * `localhost`: outside production, or in a production build whose own
 * AUTH_URL is that same http://localhost origin (local `next start`, the
 * e2e suite; a real deployment's AUTH_URL is https). Anything else
 * (javascript:, data:, relative links) is refused, so an unsafe link can
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
    (!env.isProduction() || siteIsLocalhostOrigin(url));
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

// ---------------------------------------------------------------------------
// Phase 5 account emails
// ---------------------------------------------------------------------------

/**
 * Lifetime of an invite ("Set your password") link, 72 hours (plan Q1). The
 * single source of truth: src/lib/invite.ts sets the token's expiry from it
 * and the invite email's copy is derived from it.
 */
export const INVITE_TOKEN_TTL_SECONDS = 72 * 60 * 60;

/* Dates in emails are always UTC and spelled out ("12 October 2026"), so a
 * reader in any country reads the same day (plan Q5). */
const UTC_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const UTC_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "12 October 2026" (the UTC calendar day). */
export function formatUtcDate(date: Date): string {
  return UTC_DATE.format(date);
}

/** "12 October 2026, 14:05 UTC". */
export function formatUtcDateTime(date: Date): string {
  return `${UTC_DATE.format(date)}, ${UTC_TIME.format(date)} UTC`;
}

/*
 * Access ends at the END of a UTC day (23:59:59.999, plan Q5), so the
 * sentence names that day: "until the end of 12 October 2026 (UTC)".
 */
function accessUntilText(date: Date): string {
  return `until the end of ${formatUtcDate(date)} (UTC)`;
}

/*
 * An absolute link to one of our own pages. Built from AUTH_URL, the same
 * fixed origin Better Auth uses for reset links (never a request's Host
 * header), then checked like every other link.
 */
function siteLink(pathWithQuery: string): string {
  return requireSafeLink(new URL(pathWithQuery, env.auth().url).href);
}

/*
 * A link a caller passed in (the invite URL holds a token): it must be safe
 * AND point at our own origin, so a bug upstream can never mail a customer a
 * link to somewhere else.
 */
function requireOwnLink(raw: string): string {
  const link = requireSafeLink(raw);
  if (new URL(link).origin !== new URL(env.auth().url).origin) {
    throw new EmailSendError("invalid_link");
  }
  return link;
}

/* A one-line profile value (name, company, country) for an email body. */
function oneLine(value: string | null | undefined, max = 200): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/*
 * Requester text from the PUBLIC form (name, company, country) reaches the
 * company inbox and, as the greeting, the requester's own mailbox. Mail clients turn URL-looking text into links, so a
 * "company" of "verify at https://evil.example" would arrive as a clickable
 * phishing link from our own sender. Defang it: break schemes, "www.",
 * "@" and dots before a domain-like ending, so nothing is linkified.
 */
function defang(value: string): string {
  return value
    .replace(/:\/\//g, "[:]//")
    .replace(/@/g, "[at]")
    .replace(/\bwww\./gi, "www[.]")
    .replace(/([a-z0-9-])\.(?=[a-z]{2,}(?:\b|[/?#:]))/gi, "$1[.]");
}

/* Building blocks of the account emails; each renders to text and HTML. */
type Block =
  | { kind: "p"; text: string }
  | { kind: "button"; label: string; href: string }
  | { kind: "list"; items: readonly string[] };

const P_STYLE = "margin:0 0 16px;";

/*
 * Renders blocks into the plain-text and HTML bodies. Every value is
 * escaped here, so templates pass plain strings only.
 */
function renderBlocks(
  subject: string,
  blocks: readonly Block[],
): { text: string; html: string } {
  const text: string[] = [];
  const html: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "p":
        text.push(block.text, "");
        html.push(`<p style="${P_STYLE}">${escapeHtml(block.text)}</p>`);
        break;
      case "button": {
        const href = escapeHtml(block.href);
        text.push(`${block.label}:`, block.href, "");
        html.push(
          `<p style="${P_STYLE}"><a href="${href}" style="display:inline-block;padding:12px 20px;background:#1a1a1a;color:#ffffff;text-decoration:none;">${escapeHtml(block.label)}</a></p>`,
          `<p style="${P_STYLE}">If the button does not work, copy this link into your browser:<br><a href="${href}" style="color:#1a1a1a;word-break:break-all;">${href}</a></p>`,
        );
        break;
      }
      case "list":
        text.push(...block.items.map((item) => `- ${item}`), "");
        html.push(
          `<ul style="${P_STYLE}padding-left:20px;">${block.items
            .map((item) => `<li>${escapeHtml(item)}</li>`)
            .join("")}</ul>`,
        );
        break;
    }
  }
  text.push(BRAND);
  return { text: text.join("\n"), html: htmlLayout(subject, html.join("\n")) };
}

/* Names can come from the public request form: defanged like the alert. */
function greeting(name: string | null | undefined): string {
  const clean = defang(oneLine(name, 100));
  return clean ? `Hello ${clean},` : "Hello,";
}

/* Validates a template's input; a failure names no value (ADR 0021). */
function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new EmailSendError("invalid_input");
  return parsed.data;
}

const recipient = z.email().max(254);
const personName = z.string().max(200);
const profileValue = z.string().max(200).nullable().optional();
const realDate = z.date().refine((d) => !Number.isNaN(d.getTime()));
const idempotencyKey = z.string().min(1).max(256).optional();

const INVITE_LIFETIME_TEXT = describeDuration(INVITE_TOKEN_TTL_SECONDS);

/**
 * "Set your password" (plan Q1): the invite a new customer gets on approval
 * or creation. `url` is the invite link from createInviteLink() and holds a
 * single-use token: a credential, never logged or placed in an error.
 */
export async function sendInviteEmail(input: {
  to: string;
  name: string;
  url: string;
  expiresAt: Date;
}): Promise<{ id: string }> {
  const data = parseInput(
    z.object({
      to: recipient,
      name: personName,
      url: z.string().max(2048),
      expiresAt: realDate,
    }),
    input,
  );
  const link = requireOwnLink(data.url);
  const subject = `Set your ${BRAND} password`;
  const body = renderBlocks(subject, [
    { kind: "p", text: greeting(data.name) },
    {
      kind: "p",
      text: `An account has been created for you on the ${BRAND} website. It lets you download our product datasheets.`,
    },
    { kind: "p", text: "Open this link to choose your password:" },
    { kind: "button", label: "Set your password", href: link },
    {
      kind: "p",
      text: `The link works once and expires in ${INVITE_LIFETIME_TEXT} (${formatUtcDateTime(data.expiresAt)}). If it has expired, ask us for a new one.`,
    },
    {
      kind: "p",
      text: "If you didn't expect this email, you can ignore it.",
    },
  ]);
  return sendEmail({ to: data.to, subject, ...body });
}

/**
 * The 7-day expiry reminder (cron, P5). Links to the renewal form. Pass an
 * idempotency key (user id + expiry) so a retried run never sends twice.
 */
export async function sendExpiryReminderEmail(input: {
  to: string;
  name: string;
  accessExpiresAt: Date;
  idempotencyKey?: string;
}): Promise<{ id: string }> {
  const data = parseInput(
    z.object({
      to: recipient,
      name: personName,
      accessExpiresAt: realDate,
      idempotencyKey,
    }),
    input,
  );
  const subject = `Your ${BRAND} datasheet access ends soon`;
  const body = renderBlocks(subject, [
    { kind: "p", text: greeting(data.name) },
    {
      kind: "p",
      text: `Your access to ${BRAND} datasheets is valid ${accessUntilText(data.accessExpiresAt)}.`,
    },
    {
      kind: "p",
      text: "To keep downloading after that date, ask us to renew it:",
    },
    {
      kind: "button",
      label: "Renew access",
      href: siteLink("/request-access?renew=1"),
    },
    {
      kind: "p",
      text: "You can still sign in after that date; only downloads stop.",
    },
  ]);
  return sendEmail({
    to: data.to,
    subject,
    ...body,
    ...(data.idempotencyKey ? { idempotencyKey: data.idempotencyKey } : {}),
  });
}

/** "Access extended" (plan Q4): the new end date, or no expiry (null). */
export async function sendAccessExtendedEmail(input: {
  to: string;
  name: string;
  accessExpiresAt: Date | null;
}): Promise<{ id: string }> {
  const data = parseInput(
    z.object({
      to: recipient,
      name: personName,
      accessExpiresAt: realDate.nullable(),
    }),
    input,
  );
  const subject = `Your ${BRAND} datasheet access has been extended`;
  const body = renderBlocks(subject, [
    { kind: "p", text: greeting(data.name) },
    {
      kind: "p",
      text:
        data.accessExpiresAt === null
          ? `Your access to ${BRAND} datasheets no longer has an end date.`
          : `Your access to ${BRAND} datasheets is now valid ${accessUntilText(data.accessExpiresAt)}.`,
    },
    {
      kind: "button",
      label: "Go to your downloads",
      href: siteLink("/my-downloads"),
    },
  ]);
  return sendEmail({ to: data.to, subject, ...body });
}

/**
 * Alert to the company inbox on a new access request (plan Q4). Holds name,
 * company and country plus a link to the admin queue. Never the requester's
 * message, email or phone (the inbox keeps less personal data), and the
 * subject holds no personal data at all.
 */
export async function sendAccessRequestAlertEmail(input: {
  to: string;
  name: string;
  company?: string | null;
  country?: string | null;
  kind: "new" | "renewal";
}): Promise<{ id: string }> {
  const data = parseInput(
    z.object({
      to: recipient,
      name: personName,
      company: profileValue,
      country: profileValue,
      kind: z.enum(["new", "renewal"]),
    }),
    input,
  );
  const subject =
    data.kind === "renewal"
      ? "New datasheet access renewal request"
      : "New datasheet access request";
  const body = renderBlocks(subject, [
    {
      kind: "p",
      text:
        data.kind === "renewal"
          ? "A customer has asked to renew datasheet access:"
          : "Someone has asked for datasheet access:",
    },
    {
      kind: "list",
      items: [
        `Name: ${defang(oneLine(data.name)) || "-"}`,
        `Company: ${defang(oneLine(data.company)) || "-"}`,
        `Country: ${defang(oneLine(data.country)) || "-"}`,
      ],
    },
    {
      kind: "button",
      label: "Open the request queue",
      href: siteLink("/admin/access-requests"),
    },
  ]);
  return sendEmail({ to: data.to, subject, ...body });
}

/**
 * The optional, polite decline (plan Q4: off by default in the reject
 * dialog). It never includes the admin's internal reject reason.
 */
export async function sendAccessDeclinedEmail(input: {
  to: string;
  name: string;
}): Promise<{ id: string }> {
  const data = parseInput(z.object({ to: recipient, name: personName }), input);
  const subject = `Your ${BRAND} datasheet access request`;
  const body = renderBlocks(subject, [
    { kind: "p", text: greeting(data.name) },
    {
      kind: "p",
      text: `Thank you for your interest in ${BRAND}. We are unable to offer datasheet access for this request at the moment.`,
    },
    {
      kind: "p",
      text: "If you think this is a mistake or your situation changes, you are welcome to contact us.",
    },
  ]);
  return sendEmail({ to: data.to, subject, ...body });
}

/** One customer in the admin's daily expiry digest. */
export interface ExpiryDigestEntry {
  name: string;
  company?: string | null;
  accessExpiresAt: Date;
}

/** At most this many customers are listed; the rest are counted. */
export const EXPIRY_DIGEST_MAX_ROWS = 200;

/**
 * The admin's daily digest (plan Q11): customers whose access ends within
 * 7 days, to the company inbox. Only sent when there is at least one; an
 * empty list is refused as invalid input.
 */
export async function sendExpiryDigestEmail(input: {
  to: string;
  customers: readonly ExpiryDigestEntry[];
  idempotencyKey?: string;
}): Promise<{ id: string }> {
  const data = parseInput(
    z.object({
      to: recipient,
      customers: z
        .array(
          z.object({
            name: personName,
            company: profileValue,
            accessExpiresAt: realDate,
          }),
        )
        .min(1)
        .max(10_000),
      idempotencyKey,
    }),
    input,
  );
  const shown = data.customers.slice(0, EXPIRY_DIGEST_MAX_ROWS);
  const hidden = data.customers.length - shown.length;
  const count = data.customers.length;
  const subject =
    count === 1
      ? "1 customer's datasheet access ends within 7 days"
      : `${count} customers' datasheet access ends within 7 days`;
  const blocks: Block[] = [
    {
      kind: "p",
      text: "Datasheet access for these customers ends within the next 7 days (dates in UTC):",
    },
    {
      kind: "list",
      items: shown.map((entry) => {
        const company = defang(oneLine(entry.company));
        return `${defang(oneLine(entry.name)) || "-"}${company ? ` (${company})` : ""}: ${formatUtcDate(entry.accessExpiresAt)}`;
      }),
    },
  ];
  if (hidden > 0) blocks.push({ kind: "p", text: `And ${hidden} more.` });
  blocks.push({
    kind: "button",
    label: "Open customers",
    href: siteLink("/admin/customers"),
  });
  const body = renderBlocks(subject, blocks);
  return sendEmail({
    to: data.to,
    subject,
    ...body,
    ...(data.idempotencyKey ? { idempotencyKey: data.idempotencyKey } : {}),
  });
}
