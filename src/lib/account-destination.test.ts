// Tests for the post-sign-in destination rule (plan Q7, ADR 0068): temporary
// password first, then admin, then a safe `next`, else /my-downloads; unsafe
// and auth-page `next` values are dropped.

import { describe, expect, it } from "vitest";

import {
  accountNextPath,
  changePasswordPathFor,
  destinationAfterPasswordChange,
  destinationAfterSignIn,
  singleParam,
} from "./account-destination";

const customer = { role: "customer", mustChangePassword: false };
const admin = { role: "admin", mustChangePassword: false };

describe("destinationAfterSignIn", () => {
  it("sends a temporary password to /change-password, keeping a safe next", () => {
    expect(
      destinationAfterSignIn({ role: "customer", mustChangePassword: true }),
    ).toBe("/change-password");
    expect(
      destinationAfterSignIn(
        { role: "customer", mustChangePassword: true },
        "/product/arc-ar-013a",
      ),
    ).toBe("/change-password?next=%2Fproduct%2Farc-ar-013a");
  });

  it("fails closed: a missing or odd flag counts as a temporary password", () => {
    for (const flag of [undefined, null, "false", 0, true]) {
      expect(
        destinationAfterSignIn({ role: "customer", mustChangePassword: flag }),
      ).toBe("/change-password");
    }
  });

  it("sends an admin on a temporary password to /change-password too", () => {
    expect(
      destinationAfterSignIn({ role: "admin", mustChangePassword: true }),
    ).toBe("/change-password");
  });

  it("sends the admin to /admin, whatever next says", () => {
    expect(destinationAfterSignIn(admin)).toBe("/admin");
    expect(destinationAfterSignIn(admin, "/product/arc")).toBe("/admin");
    expect(destinationAfterSignIn({ ...admin, role: "customer,admin" })).toBe(
      "/admin",
    );
  });

  it("sends a customer to a safe next, else /my-downloads", () => {
    expect(destinationAfterSignIn(customer)).toBe("/my-downloads");
    expect(destinationAfterSignIn(customer, "/product/arc?model=AR-1")).toBe(
      "/product/arc?model=AR-1",
    );
    expect(destinationAfterSignIn({ mustChangePassword: false })).toBe(
      "/my-downloads",
    );
  });

  it("drops an unsafe next", () => {
    for (const next of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example/x",
      "javascript:alert(1)",
      "/%2F%2Fevil.example",
      "product",
      "",
      ["/product/a", "/product/b"],
      42,
    ]) {
      expect(destinationAfterSignIn(customer, next)).toBe("/my-downloads");
    }
  });

  it("drops a next that points at an auth page or an API route", () => {
    for (const next of [
      "/login",
      "/login?next=/x",
      "/change-password",
      "/forgot-password",
      "/reset-password?token=abc",
      "/api/datasheet/1",
      "/api",
    ]) {
      expect(destinationAfterSignIn(customer, next)).toBe("/my-downloads");
    }
    // Only exact segments: a product whose slug starts with "login" is fine.
    expect(destinationAfterSignIn(customer, "/loginx")).toBe("/loginx");
    expect(destinationAfterSignIn(customer, "/apis")).toBe("/apis");
  });
});

describe("destinationAfterPasswordChange", () => {
  it("applies the rule with the flag cleared", () => {
    expect(destinationAfterPasswordChange({ role: "customer" })).toBe(
      "/my-downloads",
    );
    expect(
      destinationAfterPasswordChange({ role: "customer" }, "/product/arc"),
    ).toBe("/product/arc");
    expect(destinationAfterPasswordChange({ role: "admin" }, "/x")).toBe(
      "/admin",
    );
    expect(
      destinationAfterPasswordChange({ role: "customer" }, "//evil.example"),
    ).toBe("/my-downloads");
  });
});

describe("helpers", () => {
  it("changePasswordPathFor encodes next", () => {
    expect(changePasswordPathFor(null)).toBe("/change-password");
    expect(changePasswordPathFor("/a?b=1&c=2")).toBe(
      "/change-password?next=%2Fa%3Fb%3D1%26c%3D2",
    );
  });

  it("accountNextPath keeps query strings of allowed pages", () => {
    expect(accountNextPath("/products/spot?cct=3000")).toBe(
      "/products/spot?cct=3000",
    );
    expect(accountNextPath("/my-downloads?page=2")).toBe(
      "/my-downloads?page=2",
    );
  });

  it("singleParam refuses repeated parameters", () => {
    expect(singleParam("a")).toBe("a");
    expect(singleParam(undefined)).toBeUndefined();
    expect(singleParam(["a", "b"])).toBeUndefined();
  });
});
