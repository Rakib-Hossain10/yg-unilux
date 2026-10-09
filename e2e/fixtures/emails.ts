// Reads the e2e Resend sink (e2e/fake-providers/server.ts): the emails the app
// "sent" during the run, and the first link in one, so specs can follow a
// reset or invite link like a person opening their mailbox.

import { expect } from "@playwright/test";

import type { SentEmail } from "../fake-providers/server";
import { E2E_FAKE_PROVIDERS_URL } from "./providers-port";

/** Every email sent to `to` so far, oldest first. */
export async function sentEmails(to: string): Promise<SentEmail[]> {
  const reply = await fetch(
    `${E2E_FAKE_PROVIDERS_URL}/__e2e/emails?to=${encodeURIComponent(to)}`,
  );
  if (!reply.ok) throw new Error(`email sink read failed: ${reply.status}`);
  const body = (await reply.json()) as { emails: SentEmail[] };
  return body.emails;
}

/** Forgets every sent email, so a spec reads only its own. */
export async function clearEmails(): Promise<void> {
  const reply = await fetch(`${E2E_FAKE_PROVIDERS_URL}/__e2e/emails`, {
    method: "DELETE",
  });
  if (!reply.ok) throw new Error(`email sink clear failed: ${reply.status}`);
}

/**
 * Waits for the newest email to `to` whose subject matches, and returns it.
 * Emails are sent in the background (Next `after()`), so they can land a
 * moment after the HTTP answer.
 */
export async function waitForEmail(
  to: string,
  subject: RegExp,
  timeoutMs = 10_000,
): Promise<SentEmail> {
  let found: SentEmail | undefined;
  await expect
    .poll(
      async () => {
        found = (await sentEmails(to))
          .filter((email) => email.subject.search(subject) !== -1)
          .at(-1);
        return found !== undefined;
      },
      { timeout: timeoutMs },
    )
    .toBe(true);
  if (!found) throw new Error("email not found");
  return found;
}

/** The first http(s) link in an email's plain-text body that matches. */
export function linkIn(email: SentEmail, pattern: RegExp): string {
  const link = email.text
    .split(/\s+/)
    .find((word) => /^https?:\/\//.test(word) && word.search(pattern) !== -1);
  if (!link) throw new Error("no matching link in the email");
  return link;
}
