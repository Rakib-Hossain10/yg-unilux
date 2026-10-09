// Tests for the accessRequests model (ADR 0069) on a real in-memory MongoDB:
// the one-pending-request-per-email index, the kind enum and its default,
// and the reject-reason cap.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setupMemoryDb } from "../../test/helpers/memory-db";

import { AccessRequestModel, MAX_REJECT_REASON_LENGTH } from "./access-request";

setupMemoryDb("yg_access_request_model_test");

beforeAll(async () => {
  await AccessRequestModel.createIndexes();
});

beforeEach(async () => {
  await AccessRequestModel.deleteMany({});
});

const request = (
  fields: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name: "Jane Doe",
  email: "jane@example.com",
  source: "form",
  ...fields,
});

const codeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;

describe("accessRequests", () => {
  it("allows only ONE pending request per email", async () => {
    await AccessRequestModel.create(request());
    const second = await AccessRequestModel.create(request()).catch(
      (error: unknown) => error,
    );
    expect(codeOf(second)).toBe(11000);
  });

  it("keeps any number of handled requests next to one pending", async () => {
    await AccessRequestModel.create(request({ status: "approved" }));
    await AccessRequestModel.create(request({ status: "approved" }));
    await AccessRequestModel.create(request({ status: "rejected" }));
    await AccessRequestModel.create(request());
    expect(await AccessRequestModel.countDocuments({})).toBe(4);
  });

  it("emails are compared lowercased", async () => {
    await AccessRequestModel.create(request());
    const second = await AccessRequestModel.create(
      request({ email: "JANE@Example.com" }),
    ).catch((error: unknown) => error);
    expect(codeOf(second)).toBe(11000);
  });

  it("kind defaults to new and only takes new | renewal", async () => {
    const doc = await AccessRequestModel.create(request());
    expect(doc.kind).toBe("new");
    await expect(
      AccessRequestModel.create(
        request({ email: "b@example.com", kind: "upgrade" }),
      ),
    ).rejects.toThrow(/kind/);
    const renewal = await AccessRequestModel.create(
      request({ email: "c@example.com", kind: "renewal" }),
    );
    expect(renewal.kind).toBe("renewal");
  });

  it("caps the reject reason", async () => {
    await expect(
      AccessRequestModel.create(
        request({
          status: "rejected",
          rejectReason: "x".repeat(MAX_REJECT_REASON_LENGTH + 1),
        }),
      ),
    ).rejects.toThrow(/rejectReason/);
  });
});
