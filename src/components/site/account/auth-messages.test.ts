// Tests for the account forms' answer → message mapping: wrong current
// password, too short/long, the one 429 text, session ended, expired token,
// and the neutral forgot-password answer.

import { describe, expect, it } from "vitest";

import {
  MESSAGES,
  changePasswordOutcome,
  errorCodeOf,
  forgotPasswordOutcome,
  resetPasswordOutcome,
} from "./auth-messages";

describe("errorCodeOf", () => {
  it("reads Better Auth's code and ignores anything else", () => {
    expect(errorCodeOf({ code: "INVALID_TOKEN", message: "x" })).toBe(
      "INVALID_TOKEN",
    );
    for (const body of [null, "x", {}, { code: 1 }, { code: "<b>" }]) {
      expect(errorCodeOf(body)).toBeNull();
    }
  });
});

describe("changePasswordOutcome", () => {
  it("maps each answer", () => {
    expect(changePasswordOutcome(400, "INVALID_PASSWORD")).toEqual({
      kind: "field",
      field: "currentPassword",
      message: MESSAGES.wrongCurrent,
    });
    expect(changePasswordOutcome(400, "PASSWORD_TOO_SHORT")).toEqual({
      kind: "field",
      field: "newPassword",
      message: MESSAGES.tooShort,
    });
    expect(changePasswordOutcome(400, "PASSWORD_TOO_LONG")).toMatchObject({
      field: "newPassword",
    });
    expect(changePasswordOutcome(429, null)).toEqual({
      kind: "form",
      message: MESSAGES.tooMany,
    });
    expect(changePasswordOutcome(401, null)).toMatchObject({
      kind: "signed-out",
    });
    for (const status of [400, 403, 500, 503, 0]) {
      expect(changePasswordOutcome(status, "SOMETHING")).toEqual({
        kind: "form",
        message: MESSAGES.unavailable,
      });
    }
  });

  it("says 12 characters", () => {
    expect(MESSAGES.tooShort).toContain("12");
  });
});

describe("resetPasswordOutcome", () => {
  it("an invalid, used or expired token is the expired view", () => {
    expect(resetPasswordOutcome(400, "INVALID_TOKEN")).toEqual({
      kind: "expired",
    });
  });

  it("maps the other answers", () => {
    expect(resetPasswordOutcome(400, "PASSWORD_TOO_SHORT")).toMatchObject({
      field: "newPassword",
      message: MESSAGES.tooShort,
    });
    expect(resetPasswordOutcome(429, null)).toEqual({
      kind: "form",
      message: MESSAGES.tooMany,
    });
    expect(resetPasswordOutcome(500, null)).toEqual({
      kind: "form",
      message: MESSAGES.unavailable,
    });
  });
});

describe("forgotPasswordOutcome", () => {
  it("is the same neutral answer for every success", () => {
    expect(forgotPasswordOutcome(200)).toEqual({ kind: "sent" });
    expect(MESSAGES.resetSent).not.toMatch(/not found|no account|unknown/i);
  });

  it("maps errors without naming the account", () => {
    expect(forgotPasswordOutcome(429)).toEqual({
      kind: "form",
      message: MESSAGES.tooMany,
    });
    expect(forgotPasswordOutcome(400)).toEqual({
      kind: "form",
      message: MESSAGES.invalidEmail,
    });
    expect(forgotPasswordOutcome(503)).toEqual({
      kind: "form",
      message: MESSAGES.unavailable,
    });
  });
});
