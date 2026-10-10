// Tests for src/lib/email.ts: the generic Resend sender and the password-reset
// template. The Resend client is mocked, so no network call is ever made; each
// test re-imports the module so the lazily created client starts fresh.

import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Stand-in for the Resend SDK. `constructed` counts `new Resend(...)` calls and
 * `send` records every payload; tests set send's resolved value per case.
 */
const resendMock = vi.hoisted(() => ({
  constructed: [] as (string | undefined)[],
  send: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: class {
    readonly emails = { send: resendMock.send };
    constructor(key?: string) {
      resendMock.constructed.push(key);
    }
  },
}));

const API_KEY = "re_test_not_a_real_key_0000";
const FROM = "YG UniLUX <onboarding@resend.dev>";
const TO = "customer@example.com";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWx";
const RESET_URL = `https://www.example.com/api/auth/reset-password/${TOKEN}?callbackURL=%2Freset`;

/**
 * Fresh copy of the module under test, with no client created yet. EnvError
 * comes from the same fresh module graph, so `instanceof` checks hold.
 */
async function loadEmail() {
  vi.resetModules();
  const [email, { EnvError }] = await Promise.all([
    import("./email"),
    import("./env"),
  ]);
  return { ...email, EnvError };
}

/** The single payload passed to resend.emails.send. */
function sentPayload(): Record<string, unknown> {
  expect(resendMock.send).toHaveBeenCalledTimes(1);
  return resendMock.send.mock.calls[0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  resendMock.constructed.length = 0;
  resendMock.send.mockReset();
  resendMock.send.mockResolvedValue({
    data: { id: "email_123" },
    error: null,
    headers: null,
  });
  vi.stubEnv("RESEND_API_KEY", API_KEY);
  vi.stubEnv("EMAIL_FROM", FROM);
  vi.stubEnv("NODE_ENV", "production");
});

describe("lazy client", () => {
  it("does not construct the Resend client or read env on import", async () => {
    vi.stubEnv("RESEND_API_KEY", undefined);
    await loadEmail();
    expect(resendMock.constructed).toEqual([]);
  });

  it("throws EnvError on first send when RESEND_API_KEY is missing", async () => {
    vi.stubEnv("RESEND_API_KEY", undefined);
    const { sendEmail, EnvError } = await loadEmail();
    const error = await sendEmail({
      to: TO,
      subject: "Hi",
      text: "t",
      html: "<p>t</p>",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnvError);
    expect((error as InstanceType<typeof EnvError>).variables).toEqual([
      "RESEND_API_KEY",
    ]);
    expect(resendMock.constructed).toEqual([]);
    expect(resendMock.send).not.toHaveBeenCalled();
  });

  it("creates the client once, with the configured key, and reuses it", async () => {
    const { sendEmail } = await loadEmail();
    const input = { to: TO, subject: "Hi", text: "t", html: "<p>t</p>" };
    await sendEmail(input);
    await sendEmail(input);
    expect(resendMock.constructed).toEqual([API_KEY]);
    expect(resendMock.send).toHaveBeenCalledTimes(2);
  });
});

describe("sendEmail", () => {
  it("passes from, to, subject, text and html to Resend and returns the id", async () => {
    const { sendEmail } = await loadEmail();
    const result = await sendEmail({
      to: TO,
      subject: "Subject",
      text: "Plain body",
      html: "<p>HTML body</p>",
    });
    expect(result).toEqual({ id: "email_123" });
    expect(sentPayload()).toEqual({
      from: FROM,
      to: TO,
      subject: "Subject",
      text: "Plain body",
      html: "<p>HTML body</p>",
    });
  });

  it("forwards an idempotency key as a request option", async () => {
    const { sendEmail } = await loadEmail();
    await sendEmail({
      to: TO,
      subject: "Subject",
      text: "t",
      html: "<p>t</p>",
      idempotencyKey: "expiry-reminder/u1/2026-10-02",
    });
    expect(resendMock.send.mock.calls[0]![1]).toEqual({
      idempotencyKey: "expiry-reminder/u1/2026-10-02",
    });
  });

  it.each([
    ["an invalid address", { to: "not-an-email" }],
    ["a subject with a line break", { subject: "Hi\r\nBcc: x@example.com" }],
    ["an empty text body", { text: "" }],
  ])("rejects %s before calling Resend", async (_label, override) => {
    const { sendEmail, EmailSendError } = await loadEmail();
    const error = await sendEmail({
      to: TO,
      subject: "Subject",
      text: "t",
      html: "<p>t</p>",
      ...override,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSendError);
    expect((error as InstanceType<typeof EmailSendError>).reason).toBe(
      "invalid_input",
    );
    expect(String((error as Error).message)).not.toContain("not-an-email");
    expect(resendMock.send).not.toHaveBeenCalled();
  });

  it("turns a Resend error response into EmailSendError with no address, URL or token", async () => {
    // Resend error messages can echo the request, so plant every secret in it.
    resendMock.send.mockResolvedValue({
      data: null,
      error: {
        name: "validation_error",
        statusCode: 422,
        message: `Invalid to "${TO}" for ${RESET_URL} with key ${API_KEY}`,
      },
      headers: null,
    });
    const { sendPasswordResetEmail, EmailSendError } = await loadEmail();
    const error = await sendPasswordResetEmail({
      to: TO,
      name: "Ana",
      url: RESET_URL,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EmailSendError);
    const sendError = error as InstanceType<typeof EmailSendError>;
    expect(sendError.reason).toBe("provider_error");
    expect(sendError.statusCode).toBe(422);
    expect(sendError.providerCode).toBe("validation_error");
    expect(sendError.cause).toBeUndefined();

    const everything = JSON.stringify({
      message: sendError.message,
      stack: sendError.stack,
      own: Object.entries(sendError),
    });
    for (const secret of [TO, RESET_URL, TOKEN, API_KEY, "example.com"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("drops a provider code or status that is not in the expected shape", async () => {
    resendMock.send.mockResolvedValue({
      data: null,
      error: { name: `bad ${TO}`, statusCode: "x", message: TO },
      headers: null,
    });
    const { sendEmail, EmailSendError } = await loadEmail();
    const error = (await sendEmail({
      to: TO,
      subject: "s",
      text: "t",
      html: "<p>t</p>",
    }).catch((e: unknown) => e)) as InstanceType<typeof EmailSendError>;
    expect(error).toBeInstanceOf(EmailSendError);
    expect(error.providerCode).toBeUndefined();
    expect(error.statusCode).toBeUndefined();
    expect(error.message).not.toContain(TO);
  });

  it("wraps an unexpected throw from the SDK without chaining the original error", async () => {
    resendMock.send.mockRejectedValue(new Error(`boom ${TO} ${TOKEN}`));
    const { sendEmail, EmailSendError } = await loadEmail();
    const error = (await sendEmail({
      to: TO,
      subject: "s",
      text: TOKEN,
      html: "<p>t</p>",
    }).catch((e: unknown) => e)) as InstanceType<typeof EmailSendError>;
    expect(error).toBeInstanceOf(EmailSendError);
    expect(error.reason).toBe("unexpected");
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain(TO);
    expect(error.message).not.toContain(TOKEN);
  });
});

describe("sendPasswordResetEmail", () => {
  it("sends the reset link with brand, 1-hour expiry and ignore notice in text and HTML", async () => {
    const { sendPasswordResetEmail } = await loadEmail();
    await sendPasswordResetEmail({ to: TO, name: "Ana Lee", url: RESET_URL });

    const payload = sentPayload();
    expect(payload.from).toBe(FROM);
    expect(payload.to).toBe(TO);
    expect(payload.subject).toBe("Reset your YG UniLUX password");

    const text = payload.text as string;
    expect(text).toContain("Hello Ana Lee,");
    expect(text).toContain("YG UniLUX");
    expect(text).toContain(RESET_URL);
    expect(text).toContain("expires in 1 hour");
    expect(text).toContain("If you didn't ask for this, ignore this email");

    const html = payload.html as string;
    const escapedUrl = RESET_URL.replaceAll("&", "&amp;");
    expect(html).toContain(`href="${escapedUrl}"`);
    expect(html).toContain("YG UniLUX");
    expect(html).toContain("expires in 1 hour");
    expect(html).toContain("If you didn&#39;t ask for this, ignore this email");
    expect(html).toContain('<html lang="en">');
  });

  it("has no tracking pixel or external image in the HTML", async () => {
    const { sendPasswordResetEmail } = await loadEmail();
    await sendPasswordResetEmail({ to: TO, name: "Ana", url: RESET_URL });
    const html = sentPayload().html as string;
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/<script/i);
  });

  it("HTML-escapes a malicious name", async () => {
    const { sendPasswordResetEmail } = await loadEmail();
    await sendPasswordResetEmail({
      to: TO,
      name: `<script>alert("x")</script>&'`,
      url: RESET_URL,
    });
    const html = sentPayload().html as string;
    expect(html).not.toContain("<script>");
    expect(html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;",
    );
  });

  it("HTML-escapes the URL so it cannot break out of the href attribute", async () => {
    const { sendPasswordResetEmail } = await loadEmail();
    const url = `https://www.example.com/reset?a=1&b="><script>x</script>`;
    await sendPasswordResetEmail({ to: TO, name: "Ana", url });
    const html = sentPayload().html as string;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('"><script');
    // The URL parser percent-encodes the quote and brackets; & is still escaped.
    expect(html).toContain(
      'href="https://www.example.com/reset?a=1&amp;b=%22%3E%3Cscript%3Ex%3C/script%3E"',
    );
  });

  it("greets without a name when the name is blank", async () => {
    const { sendPasswordResetEmail } = await loadEmail();
    await sendPasswordResetEmail({ to: TO, name: "   ", url: RESET_URL });
    expect(sentPayload().text as string).toMatch(/^Hello,\n/);
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "ftp://www.example.com/reset",
    "mailto:a@example.com",
    "//www.example.com/reset",
    "/reset-password/abc",
    "not a url",
    "https://user:pass@www.example.com/reset",
  ])("rejects %s before any API call", async (url) => {
    const { sendPasswordResetEmail, EmailSendError } = await loadEmail();
    const error = (await sendPasswordResetEmail({
      to: TO,
      name: "Ana",
      url,
    }).catch((e: unknown) => e)) as InstanceType<typeof EmailSendError>;
    expect(error).toBeInstanceOf(EmailSendError);
    expect(error.reason).toBe("invalid_link");
    expect(error.message).not.toContain(url);
    expect(resendMock.constructed).toEqual([]);
    expect(resendMock.send).not.toHaveBeenCalled();
  });

  it("rejects http://localhost in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { sendPasswordResetEmail, EmailSendError } = await loadEmail();
    const error = await sendPasswordResetEmail({
      to: TO,
      name: "Ana",
      url: `http://localhost:3000/api/auth/reset-password/${TOKEN}`,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSendError);
    expect(resendMock.send).not.toHaveBeenCalled();
  });

  it("accepts http://localhost in production only when AUTH_URL is that same origin (local next start / e2e)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SECRET", "email-test-auth-secret-0123456789abcdefgh");
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    const { sendPasswordResetEmail, EmailSendError } = await loadEmail();
    const url = `http://localhost:3000/api/auth/reset-password/${TOKEN}`;
    await sendPasswordResetEmail({ to: TO, name: "Ana", url });
    expect(sentPayload().text as string).toContain(url);

    // Another port, or a site on https, still refuses it.
    for (const [site, link] of [
      ["http://localhost:3000", "http://localhost:4000/reset"],
      ["https://www.example.com", "http://localhost:3000/reset"],
    ] as const) {
      vi.stubEnv("AUTH_URL", site);
      const error = await sendPasswordResetEmail({
        to: TO,
        name: "Ana",
        url: link,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EmailSendError);
    }
    expect(resendMock.send).toHaveBeenCalledTimes(1);
  });

  it.each(["development", "test"])(
    "accepts http://localhost when NODE_ENV is %s",
    async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      const { sendPasswordResetEmail } = await loadEmail();
      const url = `http://localhost:3000/api/auth/reset-password/${TOKEN}`;
      await sendPasswordResetEmail({ to: TO, name: "Ana", url });
      expect(sentPayload().text as string).toContain(url);
    },
  );

  it("rejects plain http to any other host even outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { sendPasswordResetEmail, EmailSendError } = await loadEmail();
    const error = await sendPasswordResetEmail({
      to: TO,
      name: "Ana",
      url: "http://www.example.com/reset",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSendError);
    expect(resendMock.send).not.toHaveBeenCalled();
  });
});

describe("reset link lifetime", () => {
  it("is one hour, matching the 'expires in 1 hour' copy", async () => {
    const { PASSWORD_RESET_TOKEN_TTL_SECONDS } = await loadEmail();
    expect(PASSWORD_RESET_TOKEN_TTL_SECONDS).toBe(3600);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 account emails
// ---------------------------------------------------------------------------

const SITE = "https://www.example.com";
const INVITE_URL = `${SITE}/reset-password?token=${TOKEN}&invite=1`;
const EVIL = `<script>alert("x")</script>&'`;
const EVIL_ESCAPED =
  "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;";

function stubSite(): void {
  vi.stubEnv("AUTH_URL", SITE);
  vi.stubEnv("AUTH_SECRET", "email-test-auth-secret-0123456789abcdefgh");
}

/* Subject, text and HTML of the one sent email. */
function sent() {
  const payload = sentPayload();
  return {
    subject: payload.subject as string,
    text: payload.text as string,
    html: payload.html as string,
  };
}

describe("sendInviteEmail", () => {
  beforeEach(stubSite);

  it("says 'Set your password', states 72 hours and the China-time expiry, links the invite", async () => {
    const { sendInviteEmail } = await loadEmail();
    await sendInviteEmail({
      to: TO,
      name: "Ana Lee",
      url: INVITE_URL,
      expiresAt: new Date("2026-10-12T14:05:00Z"),
    });
    const { subject, text, html } = sent();
    expect(subject).toBe("Set your YG UniLUX password");
    expect(text).toContain("Hello Ana Lee,");
    expect(text).toContain(INVITE_URL);
    expect(text).toContain(
      "expires in 72 hours, at 12 Oct 2026, 22:05 (China time).",
    );
    expect(html).toContain(`href="${INVITE_URL.replaceAll("&", "&amp;")}"`);
    expect(html).toContain("Set your password");
    expect(html).not.toMatch(/<img|<script|<link/i);
  });

  it("escapes the name", async () => {
    const { sendInviteEmail } = await loadEmail();
    await sendInviteEmail({
      to: TO,
      name: EVIL,
      url: INVITE_URL,
      expiresAt: new Date(),
    });
    const { html } = sent();
    expect(html).not.toContain("<script>");
    expect(html).toContain(EVIL_ESCAPED);
  });

  it.each([
    "https://evil.example/reset-password?token=x",
    "http://www.example.com/reset-password?token=x",
    "javascript:alert(1)",
    "/reset-password?token=x",
  ])("refuses a link that is not our own https origin: %s", async (url) => {
    const { sendInviteEmail, EmailSendError } = await loadEmail();
    const error = (await sendInviteEmail({
      to: TO,
      name: "Ana",
      url,
      expiresAt: new Date(),
    }).catch((e: unknown) => e)) as InstanceType<typeof EmailSendError>;
    expect(error).toBeInstanceOf(EmailSendError);
    expect(error.reason).toBe("invalid_link");
    expect(error.message).not.toContain(url);
    expect(resendMock.send).not.toHaveBeenCalled();
  });

  it("refuses an invalid date without sending", async () => {
    const { sendInviteEmail, EmailSendError } = await loadEmail();
    const error = await sendInviteEmail({
      to: TO,
      name: "Ana",
      url: INVITE_URL,
      expiresAt: new Date("nope"),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSendError);
    expect(resendMock.send).not.toHaveBeenCalled();
  });
});

describe("sendExpiryReminderEmail", () => {
  beforeEach(stubSite);

  it("names the last day in China time and links the renewal form, with the idempotency key", async () => {
    const { sendExpiryReminderEmail } = await loadEmail();
    await sendExpiryReminderEmail({
      to: TO,
      name: "Ana",
      accessExpiresAt: new Date("2026-10-16T15:59:59.999Z"),
      idempotencyKey: "expiry-reminder/u1/2026-10-16",
    });
    const { subject, text, html } = sent();
    expect(subject).toBe("Your YG UniLUX datasheet access ends soon");
    expect(text).toContain("until the end of 16 Oct 2026 (China time)");
    expect(text).toContain(`${SITE}/request-access?renew=1`);
    expect(html).toContain(`href="${SITE}/request-access?renew=1"`);
    expect(resendMock.send.mock.calls[0]![1]).toEqual({
      idempotencyKey: "expiry-reminder/u1/2026-10-16",
    });
  });

  it("refuses an http (non-localhost) AUTH_URL link in production", async () => {
    vi.stubEnv("AUTH_URL", "http://www.example.com");
    const { sendExpiryReminderEmail, EmailSendError } = await loadEmail();
    const error = await sendExpiryReminderEmail({
      to: TO,
      name: "Ana",
      accessExpiresAt: new Date(),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSendError);
    expect(resendMock.send).not.toHaveBeenCalled();
  });
});

describe("sendAccessExtendedEmail", () => {
  beforeEach(stubSite);

  it("states the new end date", async () => {
    const { sendAccessExtendedEmail } = await loadEmail();
    await sendAccessExtendedEmail({
      to: TO,
      name: "Ana",
      accessExpiresAt: new Date("2027-04-30T15:59:59.999Z"),
    });
    const { text } = sent();
    expect(text).toContain(
      "now valid until the end of 30 Apr 2027 (China time)",
    );
    expect(text).toContain(`${SITE}/my-downloads`);
  });

  it("states 'no end date' for null", async () => {
    const { sendAccessExtendedEmail } = await loadEmail();
    await sendAccessExtendedEmail({
      to: TO,
      name: "Ana",
      accessExpiresAt: null,
    });
    expect(sent().text).toContain("no longer has an end date");
  });
});

describe("sendAccessRequestAlertEmail", () => {
  beforeEach(stubSite);

  it("holds name, company, country and the queue link; no personal data in the subject", async () => {
    const { sendAccessRequestAlertEmail } = await loadEmail();
    await sendAccessRequestAlertEmail({
      to: "company@example.com",
      name: "Ana Lee",
      company: "Acme Lighting",
      country: "Hong Kong",
      kind: "new",
    });
    const { subject, text, html } = sent();
    expect(subject).toBe("New datasheet access request");
    expect(subject).not.toContain("Ana");
    expect(text).toContain("Name: Ana Lee");
    expect(text).toContain("Company: Acme Lighting");
    expect(text).toContain("Country: Hong Kong");
    expect(html).toContain(`href="${SITE}/admin/access-requests"`);
  });

  it("never includes a message, email or phone, even if a caller passes them", async () => {
    const { sendAccessRequestAlertEmail } = await loadEmail();
    await sendAccessRequestAlertEmail({
      to: "company@example.com",
      name: "Ana",
      kind: "renewal",
      ...({
        message: "SECRET-MESSAGE",
        email: "requester@example.com",
        phone: "+85212345678",
      } as object),
    });
    const { subject, text, html } = sent();
    expect(subject).toBe("New datasheet access renewal request");
    for (const secret of ["SECRET-MESSAGE", "requester@", "12345678"]) {
      expect(text).not.toContain(secret);
      expect(html).not.toContain(secret);
    }
    expect(text).toContain("Company: -");
  });

  it("defangs URL-looking requester text so mail clients don't linkify it", async () => {
    const { sendAccessRequestAlertEmail } = await loadEmail();
    await sendAccessRequestAlertEmail({
      to: "company@example.com",
      name: "Verify at https://yg-login.example/x",
      company: "www.evil.example or admin@evil.example",
      country: "Hong Kong",
      kind: "new",
    });
    const { text, html } = sent();
    for (const body of [text, html]) {
      expect(body).not.toContain("https://yg-login");
      expect(body).not.toContain("www.evil");
      expect(body).not.toContain("admin@evil");
      expect(body).not.toMatch(/evil\.example/);
    }
    expect(text).toContain("Name: Verify at https[:]//yg-login[.]example/x");
    expect(text).toContain("Country: Hong Kong");
    // Only our own queue link remains a real link.
    expect(html.match(/href="/g)).toHaveLength(2);
  });

  it("leaves ordinary company names readable", async () => {
    const { sendAccessRequestAlertEmail } = await loadEmail();
    await sendAccessRequestAlertEmail({
      to: "company@example.com",
      name: "Ana Lee",
      company: "Acme Co. Ltd.",
      kind: "new",
    });
    expect(sent().text).toContain("Company: Acme Co. Ltd.");
  });

  it("escapes every requester value and folds line breaks", async () => {
    const { sendAccessRequestAlertEmail } = await loadEmail();
    await sendAccessRequestAlertEmail({
      to: "company@example.com",
      name: `${EVIL}\nInjected: line`,
      company: EVIL,
      country: EVIL,
      kind: "new",
    });
    const { text, html } = sent();
    expect(html).not.toContain("<script>");
    expect(html.split(EVIL_ESCAPED).length - 1).toBe(3);
    expect(text).not.toMatch(/\nInjected: line/);
  });
});

describe("sendAccessDeclinedEmail", () => {
  beforeEach(stubSite);

  it("defangs a URL-looking name in the greeting", async () => {
    const { sendAccessDeclinedEmail } = await loadEmail();
    await sendAccessDeclinedEmail({
      to: TO,
      name: "Security alert: verify at https://yg-login.example",
    });
    const { text, html } = sent();
    expect(text).toContain(
      "Hello Security alert: verify at https[:]//yg-login[.]example,",
    );
    expect(html).not.toContain("https://yg-login");
    expect(html).not.toMatch(/href=/);
  });

  it("is polite, escapes the name and carries no reason", async () => {
    const { sendAccessDeclinedEmail } = await loadEmail();
    await sendAccessDeclinedEmail({ to: TO, name: EVIL });
    const { subject, text, html } = sent();
    expect(subject).toBe("Your YG UniLUX datasheet access request");
    expect(text).toContain("Thank you for your interest");
    expect(html).not.toContain("<script>");
    expect(html).toContain(EVIL_ESCAPED);
  });
});

describe("sendExpiryDigestEmail", () => {
  beforeEach(stubSite);

  it("lists name, company and the China-time date per customer", async () => {
    const { sendExpiryDigestEmail } = await loadEmail();
    await sendExpiryDigestEmail({
      to: "company@example.com",
      customers: [
        {
          name: "Ana Lee",
          company: "Acme",
          accessExpiresAt: new Date("2026-10-14T15:59:59.999Z"),
        },
        {
          name: EVIL,
          company: null,
          accessExpiresAt: new Date("2026-10-15T15:59:59.999Z"),
        },
      ],
    });
    const { subject, text, html } = sent();
    expect(subject).toBe("2 customers' datasheet access ends within 7 days");
    expect(text).toContain("(dates in China time):");
    expect(text).toContain("- Ana Lee (Acme): 14 Oct 2026");
    expect(html).toContain(`${EVIL_ESCAPED}: 15 Oct 2026`);
    expect(html).not.toContain("<script>");
    expect(html).toContain(`href="${SITE}/admin/customers"`);
  });

  it("refuses an empty list", async () => {
    const { sendExpiryDigestEmail, EmailSendError } = await loadEmail();
    const error = await sendExpiryDigestEmail({
      to: "company@example.com",
      customers: [],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSendError);
    expect(resendMock.send).not.toHaveBeenCalled();
  });

  it("caps the listed rows and counts the rest", async () => {
    const { sendExpiryDigestEmail, EXPIRY_DIGEST_MAX_ROWS } = await loadEmail();
    const customers = Array.from(
      { length: EXPIRY_DIGEST_MAX_ROWS + 5 },
      (_, i) => ({
        name: `C${i}`,
        accessExpiresAt: new Date("2026-10-14T15:59:59.999Z"),
      }),
    );
    await sendExpiryDigestEmail({ to: "company@example.com", customers });
    const { text } = sent();
    expect(text).toContain("And 5 more.");
    expect(text).not.toContain(`C${EXPIRY_DIGEST_MAX_ROWS}:`);
  });
});

describe("email dates", () => {
  beforeEach(stubSite);

  it("are the China-time day, not the UTC or server day", async () => {
    const { sendExpiryReminderEmail } = await loadEmail();
    await sendExpiryReminderEmail({
      to: TO,
      name: "Ana",
      // 16:30Z on 16 Oct is 00:30 on 17 Oct in China.
      accessExpiresAt: new Date("2026-10-16T16:30:00.000Z"),
      idempotencyKey: "expiry-reminder/u1/tz",
    });
    expect(sent().text).toContain("until the end of 17 Oct 2026 (China time)");
  });
});
