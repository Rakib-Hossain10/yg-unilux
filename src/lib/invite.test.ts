// Tests for inviteStatus() in src/lib/invite.ts: the pure status the admin
// screens show, at its boundaries (71 h 59 m pending, 72 h expired) and with
// missing or unreadable fields (fail closed).

import { describe, expect, it } from "vitest";

import { INVITE_TOKEN_TTL_SECONDS } from "./email";
import { inviteStatus } from "./invite";

const HOUR = 3_600_000;
const invitedAt = new Date("2026-10-09T08:00:00.000Z");
const inviteExpiresAt = new Date(
  invitedAt.getTime() + INVITE_TOKEN_TTL_SECONDS * 1000,
);
const at = (ms: number) => new Date(invitedAt.getTime() + ms);

describe("inviteStatus", () => {
  it("the link lives 72 hours", () => {
    expect(INVITE_TOKEN_TTL_SECONDS).toBe(72 * 3600);
  });

  it("none when never invited", () => {
    expect(inviteStatus({}, at(0))).toEqual({ state: "none" });
    expect(
      inviteStatus({ invitedAt: null, passwordSetAt: at(0) }, at(0)),
    ).toEqual({ state: "none" });
  });

  it("pending until the expiry, still at 71 h 59 m 59.999 s", () => {
    const user = { invitedAt, inviteExpiresAt };
    expect(inviteStatus(user, at(0))).toEqual({
      state: "pending",
      until: inviteExpiresAt,
    });
    expect(inviteStatus(user, at(72 * HOUR - 60_000))).toMatchObject({
      state: "pending",
    });
    expect(inviteStatus(user, at(72 * HOUR - 1))).toMatchObject({
      state: "pending",
    });
  });

  it("expired from exactly 72 h on", () => {
    const user = { invitedAt, inviteExpiresAt };
    expect(inviteStatus(user, at(72 * HOUR))).toEqual({
      state: "expired",
      expiredAt: inviteExpiresAt,
    });
    expect(inviteStatus(user, at(400 * HOUR))).toMatchObject({
      state: "expired",
    });
  });

  it("accepted once a password is set at or after the invite, even after expiry", () => {
    expect(
      inviteStatus(
        { invitedAt, inviteExpiresAt, passwordSetAt: at(HOUR) },
        at(500 * HOUR),
      ),
    ).toEqual({ state: "accepted" });
    expect(
      inviteStatus({ invitedAt, inviteExpiresAt, passwordSetAt: at(0) }, at(1)),
    ).toEqual({ state: "accepted" });
  });

  it("a password set BEFORE a newer invite does not count (re-invited)", () => {
    expect(
      inviteStatus(
        { invitedAt, inviteExpiresAt, passwordSetAt: at(-HOUR) },
        at(HOUR),
      ),
    ).toMatchObject({ state: "pending" });
  });

  it("reads ISO strings as well as Dates", () => {
    expect(
      inviteStatus(
        {
          invitedAt: invitedAt.toISOString(),
          inviteExpiresAt: inviteExpiresAt.toISOString(),
        },
        at(HOUR),
      ),
    ).toEqual({ state: "pending", until: inviteExpiresAt });
  });

  it("fails closed: a missing or unreadable expiry is expired", () => {
    expect(inviteStatus({ invitedAt }, at(0))).toEqual({
      state: "expired",
      expiredAt: null,
    });
    expect(
      inviteStatus({ invitedAt, inviteExpiresAt: "garbage" }, at(0)),
    ).toEqual({ state: "expired", expiredAt: null });
  });
});
