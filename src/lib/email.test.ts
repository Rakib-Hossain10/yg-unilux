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
