// Tests for the public WhatsApp-number reader: digits when set, null when
// unset or malformed, and the wa.me link only for a well-formed number.

import { beforeEach, describe, expect, it } from "vitest";

import { setupMemoryDb } from "../../test/helpers/memory-db";
import { SETTINGS_KEYS } from "@/lib/schemas/settings";
import { SiteContentModel } from "@/models";

import { getWhatsappNumber, whatsappLink } from "./contact-settings";

setupMemoryDb("contact-settings");

beforeEach(async () => {
  await SiteContentModel.collection.deleteMany({});
});

describe("getWhatsappNumber", () => {
  it("is null when never set", async () => {
    expect(await getWhatsappNumber()).toBeNull();
  });

  it("returns the stored digits", async () => {
    await SiteContentModel.collection.insertOne({
      key: SETTINGS_KEYS.whatsappNumber,
      value: "85291234567",
    });
    expect(await getWhatsappNumber()).toBe("85291234567");
  });

  it("is null for a malformed stored value", async () => {
    await SiteContentModel.collection.insertOne({
      key: SETTINGS_KEYS.whatsappNumber,
      value: "javascript:alert(1)",
    });
    expect(await getWhatsappNumber()).toBeNull();
  });
});

describe("whatsappLink", () => {
  it("builds a wa.me link from digits only", () => {
    expect(whatsappLink("85291234567")).toBe("https://wa.me/85291234567");
    expect(whatsappLink("+85291234567")).toBeNull();
    expect(whatsappLink("123")).toBeNull();
    expect(whatsappLink("852/../evil")).toBeNull();
  });
});
