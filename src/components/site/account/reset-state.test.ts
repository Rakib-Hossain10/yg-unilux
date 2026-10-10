// Tests for the /reset-password state rule: form for a well-formed token,
// "Set your password" wording only for invite=1, expired view for an error,
// a missing, repeated or malformed token.

import { describe, expect, it } from "vitest";

import { resetCopy, resetPageState } from "./reset-state";

// Built from repeats so they cannot be mistaken for real secrets (gitleaks).
const resetToken = "aB3d".repeat(6); // 24 alphanumerics
const inviteToken = "Xk_-".repeat(10) + "Xk3"; // 43, base64url

describe("resetPageState", () => {
  it("shows the form for a reset token", () => {
    expect(resetPageState({ token: resetToken })).toEqual({
      view: "form",
      token: resetToken,
      invite: false,
    });
  });

  it("shows the invite wording only for invite=1", () => {
    expect(resetPageState({ token: inviteToken, invite: "1" })).toEqual({
      view: "form",
      token: inviteToken,
      invite: true,
    });
    expect(
      resetPageState({ token: inviteToken, invite: "true" }),
    ).toMatchObject({ invite: false });
    expect(
      resetPageState({ token: inviteToken, invite: ["1", "1"] }),
    ).toMatchObject({ invite: false });
  });

  it("shows the expired view for Better Auth's error redirect", () => {
    expect(resetPageState({ error: "INVALID_TOKEN" })).toEqual({
      view: "expired",
      invite: false,
    });
    // An error wins even when a token is present.
    expect(
      resetPageState({ error: "INVALID_TOKEN", token: resetToken }),
    ).toMatchObject({ view: "expired" });
    expect(resetPageState({ error: "x", invite: "1" })).toEqual({
      view: "expired",
      invite: true,
    });
  });

  it("shows the expired view for a missing, repeated or malformed token", () => {
    for (const token of [
      undefined,
      "",
      "short",
      [resetToken, resetToken],
      `${resetToken}<script>`,
      "a".repeat(129),
      "abc def ghi jkl mno pqr",
      "%2F%2Fevil.example%2Fabcdef",
    ]) {
      expect(resetPageState({ token })).toMatchObject({ view: "expired" });
    }
  });
});

describe("resetCopy", () => {
  it("differs for invites and resets", () => {
    expect(resetCopy(true).title).toBe("Set your password");
    expect(resetCopy(false).title).toBe("Choose a new password");
    expect(resetCopy(true).submit).not.toBe(resetCopy(false).submit);
  });
});
