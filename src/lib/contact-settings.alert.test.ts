// Tests for getCompanyAlertEmail(): the admin setting wins over
// COMPANY_EMAIL, a missing/malformed setting or a database failure falls
// back to the env value, and neither gives null without logging an address.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SETTINGS_KEYS } from "@/lib/schemas/settings";
import { SiteContentModel } from "@/models";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import { getCompanyAlertEmail } from "./contact-settings";

setupMemoryDb("contact-settings-alert");

const STORED = "sales@yg.example";
const FROM_ENV = "office@yg.example";

beforeEach(async () => {
  await SiteContentModel.collection.deleteMany({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const store = (value: unknown) =>
  SiteContentModel.collection.insertOne({
    key: SETTINGS_KEYS.companyEmail,
    value,
  });

describe("getCompanyAlertEmail", () => {
  it("the stored setting wins over the env value", async () => {
    vi.stubEnv("COMPANY_EMAIL", FROM_ENV);
    await store(STORED);
    expect(await getCompanyAlertEmail()).toBe(STORED);
  });

  it.each([
    ["no setting", undefined],
    ["a stored null", null],
    ["a malformed value", "not-an-address"],
  ])("falls back to COMPANY_EMAIL on %s", async (_label, value) => {
    vi.stubEnv("COMPANY_EMAIL", FROM_ENV);
    if (value !== undefined) await store(value);
    expect(await getCompanyAlertEmail()).toBe(FROM_ENV);
  });

  it("falls back to COMPANY_EMAIL when the database read fails", async () => {
    vi.stubEnv("COMPANY_EMAIL", FROM_ENV);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(SiteContentModel, "findOne").mockImplementation(() => {
      throw new Error("db down");
    });
    expect(await getCompanyAlertEmail()).toBe(FROM_ENV);
    expect(error).toHaveBeenCalled();
  });

  it("null when neither is set, and no address is logged", async () => {
    vi.stubEnv("COMPANY_EMAIL", "");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getCompanyAlertEmail()).toBeNull();
    expect(JSON.stringify(error.mock.calls)).not.toContain("@");
  });
});
