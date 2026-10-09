// The e2e Resend sink (Phase 5 P1): a forgot-password request through the
// real /api/auth route lands in the fake's mailbox, with a reset link a spec
// can follow. P2's forgot/reset and invite specs build on this.

import { expect, test } from "@playwright/test";

import { E2E_MAIL_CUSTOMER } from "./fixtures/accounts";
import {
  clearEmails,
  linkIn,
  sentEmails,
  waitForEmail,
} from "./fixtures/emails";

test.describe("Resend sink", () => {
  test("a reset request's email is captured with its link", async ({
    request,
    baseURL,
  }) => {
    await clearEmails();
    const response = await request.post("/api/auth/request-password-reset", {
      headers: { origin: baseURL ?? "" },
      data: { email: E2E_MAIL_CUSTOMER.email, redirectTo: "/reset-password" },
    });
    expect(response.status()).toBe(200);

    const email = await waitForEmail(E2E_MAIL_CUSTOMER.email, /Reset your/);
    expect(email.from).toContain("no-reply@e2e.invalid");
    const link = linkIn(email, /\/api\/auth\/reset-password\//);
    expect(new URL(link).origin).toBe(baseURL);

    // Following the link redirects to the page with the token (P2 builds it).
    const followed = await request.get(link, { maxRedirects: 0 });
    expect(followed.status()).toBe(302);
    expect(followed.headers().location).toMatch(/\/reset-password\?token=/);
  });

  test("an unknown email gets the same answer and no email", async ({
    request,
    baseURL,
  }) => {
    await clearEmails();
    const ghost = "e2e-ghost@example.com";
    const response = await request.post("/api/auth/request-password-reset", {
      headers: { origin: baseURL ?? "" },
      data: { email: ghost, redirectTo: "/reset-password" },
    });
    expect(response.status()).toBe(200);
    // Give a background send the time it would need, then check.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await sentEmails(ghost)).toEqual([]);
  });
});
