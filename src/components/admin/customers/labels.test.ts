// The customer page's access line and audit-trail labels: a picked end date
// reads "at the end of" its China day, an "End access now" end shows the
// moment, and every customer / access-request audit action has a label.

import { describe, expect, it } from "vitest";

import { endOfZonedDay } from "@/lib/time-zone";
import { ADMIN_AUDIT_ACTIONS } from "@/models/audit-actions";

import { accessSentence, auditLabel } from "./labels";

describe("accessSentence", () => {
  it("a picked end that has passed reads 'at the end of' its China day", () => {
    const end = endOfZonedDay("2026-01-31")?.toISOString() ?? "";
    expect(accessSentence("expired", end)).toBe(
      "Ended at the end of 31 Jan 2026 (China time). Downloads are locked.",
    );
  });

  it("an end set by 'End access now' shows the moment in China time", () => {
    expect(accessSentence("expired", "2026-10-10T06:30:00.000Z")).toBe(
      "Ended on 10 Oct 2026, 14:30 (China time). Downloads are locked.",
    );
  });

  it("running access and no expiry are unchanged", () => {
    const end = endOfZonedDay("2027-03-31")?.toISOString() ?? "";
    expect(accessSentence("active", end)).toBe(
      "Access until the end of 31 Mar 2027 (China time).",
    );
    expect(accessSentence("no_expiry", null)).toBe(
      "No expiry: datasheets stay unlocked.",
    );
  });
});

describe("auditLabel", () => {
  it("labels ending access", () => {
    expect(auditLabel("customer.access.end")).toBe("Access ended");
  });

  it("labels every customer and access-request action", () => {
    for (const action of ADMIN_AUDIT_ACTIONS.filter((a) =>
      /^(customer|access_request)\./.test(a),
    )) {
      expect(auditLabel(action)).not.toBe(action);
    }
  });

  it("passes unknown actions and prototype keys through", () => {
    expect(auditLabel("product.create")).toBe("product.create");
    expect(auditLabel("toString")).toBe("toString");
  });
});
