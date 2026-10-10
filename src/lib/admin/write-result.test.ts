// Tests for the two "finish a write" helpers in write-result.ts: the normal
// auditAndFinish (a failed audit write becomes an error, tags kept) and
// auditKeepingData (ADR 0070: a one-time credential is never dropped).

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditInput } from "@/lib/audit";

import {
  AUDIT_FAILED_MESSAGE,
  auditAndFinish,
  auditKeepingData,
} from "./write-result";

const audit = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/audit", () => ({
  recordAudit: vi.fn(async () => {
    if (audit.fail) throw new Error("audit store down");
    return { id: "a".repeat(24) };
  }),
}));

const ENTRY: AuditInput = {
  actorId: "b".repeat(24),
  action: "customer.password.temp",
  target: { type: "customer", id: "c".repeat(24) },
};

beforeEach(() => {
  audit.fail = false;
  vi.restoreAllMocks();
});

describe("auditKeepingData", () => {
  it("returns the data with auditFailed false when the audit is written", async () => {
    expect(await auditKeepingData(ENTRY, { password: "x" }, [])).toEqual({
      ok: true,
      data: { password: "x", auditFailed: false },
      tags: [],
    });
  });

  it("keeps the data (flagged) when the audit write fails, logging no value", async () => {
    audit.fail = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "one-time-secret-value";
    expect(await auditKeepingData(ENTRY, { password: secret }, [])).toEqual({
      ok: true,
      data: { password: secret, auditFailed: true },
      tags: [],
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
  });
});

describe("auditAndFinish", () => {
  it("turns a failed audit write into the admin error, keeping the tags", async () => {
    audit.fail = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await auditAndFinish(ENTRY, { userId: "x" }, ["products"])).toEqual({
      ok: false,
      errors: { formErrors: [AUDIT_FAILED_MESSAGE], fieldErrors: {} },
      tags: ["products"],
    });
  });
});
