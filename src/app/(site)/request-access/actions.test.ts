// The /request-access Server Action (P6): it only reads the FormData shape,
// takes the viewer from the DATABASE session (never from the form) and calls
// submitAccessRequest once; every accepted answer is the same "sent" state;
// outages and unexpected throws become "unavailable" without logging the form.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FORM_REFUSED,
  IDLE_STATE,
} from "@/components/site/request-access/request-form";

const mocks = vi.hoisted(() => ({
  headers: new Headers(),
  submit: vi.fn(),
  getViewer: vi.fn(),
  hasSessionCookie: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => mocks.headers }));
vi.mock("@/lib/access-requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/access-requests")>()),
  submitAccessRequest: mocks.submit,
}));
vi.mock("@/lib/permissions", () => ({ getViewer: mocks.getViewer }));
vi.mock("@/lib/session-cookie", () => ({
  hasSessionCookie: mocks.hasSessionCookie,
}));

const { requestAccessAction } = await import("./actions");
const { ACCESS_REQUEST_THANKS, ACCESS_REQUEST_UNAVAILABLE } =
  await import("@/lib/access-requests");

const SECRET_MESSAGE = "my-private-project-details-123";

function post(extra: Record<string, string> = {}): FormData {
  const data = new FormData();
  const fields = {
    name: "Ada Lovelace",
    email: "ada@example.com",
    company: "Acme",
    country: "Japan",
    message: SECRET_MESSAGE,
    consent: "on",
    kind: "new",
    website: "",
    startedAt: "1700000000000",
    ...extra,
  };
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

beforeEach(() => {
  mocks.headers = new Headers({ "x-vercel-forwarded-for": "203.0.113.7" });
  mocks.submit.mockReset().mockResolvedValue({ ok: true });
  mocks.getViewer.mockReset().mockResolvedValue(null);
  mocks.hasSessionCookie.mockReset().mockReturnValue(false);
});

describe("requestAccessAction", () => {
  it("passes the posted fields and the request headers to the service once", async () => {
    const state = await requestAccessAction(IDLE_STATE, post());
    expect(state).toEqual({ status: "sent", message: ACCESS_REQUEST_THANKS });
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    const [input, context] = mocks.submit.mock.calls[0]!;
    expect(input).toMatchObject({
      name: "Ada Lovelace",
      email: "ada@example.com",
      consent: "on",
      website: "",
      startedAt: "1700000000000",
    });
    expect(context.headers).toBe(mocks.headers);
    expect(context.viewer).toBeNull();
    // No session cookie: no database read.
    expect(mocks.getViewer).not.toHaveBeenCalled();
  });

  it("links the viewer from the database session, never from the form", async () => {
    mocks.hasSessionCookie.mockReturnValue(true);
    mocks.getViewer.mockResolvedValue({
      user: { id: "u1", email: "session@example.com", role: "customer" },
      session: {},
    });
    await requestAccessAction(
      IDLE_STATE,
      post({ userId: "someone-else", role: "admin", viewer: "x" }),
    );
    const [input, context] = mocks.submit.mock.calls[0]!;
    // The session's own email, not the one typed into the form.
    expect(context.viewer).toEqual({
      userId: "u1",
      email: "session@example.com",
      role: "customer",
    });
    expect(input.email).toBe("ada@example.com");
    expect(input).not.toHaveProperty("userId");
    expect(input).not.toHaveProperty("role");
  });

  it("a session read failure only means not linked", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.hasSessionCookie.mockReturnValue(true);
    mocks.getViewer.mockRejectedValue(new Error("db down"));
    const state = await requestAccessAction(IDLE_STATE, post());
    expect(state.status).toBe("sent");
    expect(mocks.submit.mock.calls[0]![1].viewer).toBeNull();
    expect(JSON.stringify(errors.mock.calls)).not.toContain("db down");
  });

  it("a cookie whose session is gone is not linked", async () => {
    mocks.hasSessionCookie.mockReturnValue(true);
    mocks.getViewer.mockResolvedValue(null);
    await requestAccessAction(IDLE_STATE, post());
    expect(mocks.submit.mock.calls[0]![1].viewer).toBeNull();
  });

  it("hands a filled honeypot to the service as is (the service drops it)", async () => {
    const state = await requestAccessAction(
      IDLE_STATE,
      post({ website: "http://spam.example" }),
    );
    expect(mocks.submit.mock.calls[0]![0].website).toBe("http://spam.example");
    expect(state).toEqual({ status: "sent", message: ACCESS_REQUEST_THANKS });
  });

  it("maps field errors and echoes the typed values", async () => {
    mocks.submit.mockResolvedValue({
      ok: false,
      errors: { formErrors: [], fieldErrors: { name: ["Use letters"] } },
    });
    const state = await requestAccessAction(IDLE_STATE, post({ name: "<b>" }));
    expect(state).toMatchObject({
      status: "invalid",
      fieldErrors: { name: "Use letters" },
      values: { name: "<b>", consent: true },
      startedAt: "1700000000000",
    });
  });

  it("our outage, or an unexpected throw, is unavailable and never logs the form", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.submit.mockResolvedValueOnce({ ok: false, unavailable: true });
    expect(await requestAccessAction(IDLE_STATE, post())).toMatchObject({
      status: "unavailable",
      message: ACCESS_REQUEST_UNAVAILABLE,
    });
    mocks.submit.mockRejectedValueOnce(new TypeError(SECRET_MESSAGE));
    expect(await requestAccessAction(IDLE_STATE, post())).toMatchObject({
      status: "unavailable",
    });
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain(SECRET_MESSAGE);
    expect(logged).not.toContain("ada@example.com");
  });

  it("refuses an over-long post before the service", async () => {
    const state = await requestAccessAction(
      IDLE_STATE,
      post({ message: "x".repeat(20_001) }),
    );
    expect(state).toMatchObject({ status: "invalid", formError: FORM_REFUSED });
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
