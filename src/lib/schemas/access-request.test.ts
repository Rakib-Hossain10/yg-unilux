// Tests for the access-request and customer schemas: the plain character
// sets for name / company / country (no links, addresses or markup),
// email normalising, the consent box, and the expiry picker.

import { describe, expect, it } from "vitest";

import {
  accessChoiceSchema,
  companySchema,
  countrySchema,
  personNameSchema,
  publicAccessRequestSchema,
} from "./access-request";
import { listCustomersSchema } from "./customer";

const base = {
  name: "Jane Doe",
  email: "Jane@Example.com ",
  company: "Acme Lighting",
  country: "Hong Kong",
  consent: "on",
};

describe("plain character sets", () => {
  it.each(["Jane Doe", "Zoë O'Neil-Smith", "陈大文", "J. R. Doe"])(
    "accepts the name %j",
    (name) => {
      expect(personNameSchema.safeParse(name).success).toBe(true);
    },
  );

  it.each([
    "http://evil.example",
    "jane@example.com",
    "<script>",
    "Jane\nBcc",
    "Agent 007",
    " ",
    "a".repeat(101),
  ])("refuses the name %j", (name) => {
    expect(personNameSchema.safeParse(name).success).toBe(false);
  });

  it("company allows digits and & ( ) / + but no ':' '@' '<'", () => {
    expect(companySchema.safeParse("A&B (HK) 2000 / Lighting+").success).toBe(
      true,
    );
    for (const bad of ["evil:x", "a@b", "<b>", "Co\tLtd"]) {
      expect(companySchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("country is letters and simple punctuation", () => {
    expect(countrySchema.safeParse("Côte d'Ivoire").success).toBe(true);
    expect(countrySchema.safeParse("X").success).toBe(false);
    expect(countrySchema.safeParse("HK1").success).toBe(false);
  });

  it("collapses runs of spaces", () => {
    expect(personNameSchema.parse("  Jane    Doe ")).toBe("Jane Doe");
  });
});

describe("publicAccessRequestSchema", () => {
  it("normalises the email and defaults kind to new", () => {
    const parsed = publicAccessRequestSchema.parse(base);
    expect(parsed).toMatchObject({
      email: "jane@example.com",
      kind: "new",
      consent: true,
      phone: null,
      message: null,
      product: null,
    });
  });

  it("requires consent", () => {
    expect(
      publicAccessRequestSchema.safeParse({ ...base, consent: undefined })
        .success,
    ).toBe(false);
    expect(
      publicAccessRequestSchema.safeParse({ ...base, consent: "off" }).success,
    ).toBe(false);
  });

  it("drops a malformed product id instead of failing", () => {
    expect(
      publicAccessRequestSchema.parse({ ...base, product: { $gt: "" } })
        .product,
    ).toBeNull();
    expect(
      publicAccessRequestSchema.parse({ ...base, product: "A".repeat(24) })
        .product,
    ).toBe("a".repeat(24));
  });

  it("messages keep line breaks but no other control characters", () => {
    expect(
      publicAccessRequestSchema.parse({ ...base, message: "a\r\nb" }).message,
    ).toBe("a\nb");
    expect(
      publicAccessRequestSchema.safeParse({ ...base, message: "a\u0000b" })
        .success,
    ).toBe(false);
  });
});

describe("accessChoiceSchema", () => {
  it("takes 3/6/12 months, a real day, or none", () => {
    for (const ok of [
      { kind: "months", months: 3 },
      { kind: "months", months: 12 },
      { kind: "date", date: "2028-02-29" },
      { kind: "none" },
    ]) {
      expect(accessChoiceSchema.safeParse(ok).success, JSON.stringify(ok)).toBe(
        true,
      );
    }
    for (const bad of [
      { kind: "months", months: 5 },
      { kind: "date", date: "2026-02-30" },
      { kind: "forever" },
    ]) {
      expect(
        accessChoiceSchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
});

describe("listCustomersSchema", () => {
  it("defaults and caps the search", () => {
    expect(listCustomersSchema.parse({})).toEqual({
      q: null,
      status: null,
      sort: "created",
      page: 1,
    });
    expect(listCustomersSchema.safeParse({ q: "a".repeat(101) }).success).toBe(
      false,
    );
  });
});
