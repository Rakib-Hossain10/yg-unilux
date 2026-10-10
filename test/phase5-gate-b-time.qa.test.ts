// QA gate B (Phase 5, ADR 0076): China time across modules.
//
// 1. Zone-day math holds as an invariant for every day of two years, in the
//    app zone and in DST zones (incl. one that skips midnight), so the
//    "change the two constants" promise of src/lib/time-zone.ts holds.
// 2. The picker preview (client) and the stored value (server) are the same
//    function call, and a picked day is stored as the end of that China day.
// 3. Reminders: for EVERY picked day of a year, the 08:00Z cron sends on
//    the run exactly 7 China days before and not on the run 8 days before;
//    a late run before 16:00Z is still the same China day.
// 4. The admin "expiring" filter and the list's per-row state use the same
//    boundary (30 China days), checked at 15:59:59.999Z and 16:00Z.
// 5. "Expired?" stays an instant comparison (not a day comparison).

import { ObjectId } from "mongodb";
import { beforeAll, describe, expect, it } from "vitest";

import { previewAccessEnd } from "@/components/admin/access-requests/expiry-picker";
import { computeAccessExpiry } from "@/lib/access-expiry";
import { customerStatusFilter, listCustomers } from "@/lib/admin/customers";
import type { AdminActor } from "@/lib/admin/actor";
import { getDb } from "@/lib/db";
import { dueFilter } from "@/lib/expiry-reminders";
import { checkDatasheetAccess } from "@/lib/permissions";
import {
  addDaysToDayKey,
  endOfZonedDay,
  endOfZonedDayIn,
  formatDate,
  startOfZonedDayIn,
  zonedDayKey,
  zonedDayKeyIn,
} from "@/lib/time-zone";

import { setupAuthHarness, signedInAdmin } from "./helpers/auth-harness";

const harness = setupAuthHarness("yg_phase5_gate_b_time");
const DAY = 86_400_000;

/* Every "YYYY-MM-DD" from `from` for `count` days. */
function days(from: string, count: number): string[] {
  const out: string[] = [];
  let key: string | null = from;
  for (let i = 0; i < count && key !== null; i++) {
    out.push(key);
    key = addDaysToDayKey(key, 1);
  }
  return out;
}

describe("zone-day invariants (any IANA zone)", () => {
  const ZONES = [
    "Asia/Shanghai",
    "Europe/London",
    "America/New_York",
    "Asia/Beirut", // DST starts at 00:00: midnight does not exist
    "America/Santiago",
    "Australia/Lord_Howe", // 30-minute DST shift
    "Pacific/Apia",
  ];
  const ALL = days("2026-01-01", 731);

  it.each(ZONES)(
    "%s: start/end of each day read as that day, ±1 ms as the neighbours",
    (zone) => {
      for (const key of ALL) {
        const start = startOfZonedDayIn(key, zone);
        const end = endOfZonedDayIn(key, zone);
        if (!start || !end) throw new Error(`${zone} ${key}: null`);
        expect(zonedDayKeyIn(start, zone), `${zone} start ${key}`).toBe(key);
        expect(zonedDayKeyIn(end, zone), `${zone} end ${key}`).toBe(key);
        expect(zonedDayKeyIn(start.getTime() - 1, zone)).toBe(
          addDaysToDayKey(key, -1),
        );
        expect(zonedDayKeyIn(end.getTime() + 1, zone)).toBe(
          addDaysToDayKey(key, 1),
        );
      }
    },
  );
});

describe("the 16:00Z boundary (Asia/Shanghai)", () => {
  it("15:59:59.999Z is still the UTC date in China; 16:00Z is the next day", () => {
    expect(zonedDayKey("2026-12-31T15:59:59.999Z")).toBe("2026-12-31");
    expect(zonedDayKey("2026-12-31T16:00:00.000Z")).toBe("2027-01-01");
    expect(endOfZonedDay("2026-12-31")?.toISOString()).toBe(
      "2026-12-31T15:59:59.999Z",
    );
  });

  it("a picked day is stored as the end of that China day, and the preview equals it", () => {
    for (const key of days("2026-01-01", 400)) {
      const now = new Date("2026-01-01T03:00:00Z");
      const stored = computeAccessExpiry(
        { kind: "date", date: key },
        { now, current: null },
      );
      expect(stored?.toISOString()).toBe(endOfZonedDay(key)?.toISOString());
      expect(
        previewAccessEnd({ kind: "date", date: ` ${key} ` }, now, null),
      ).toEqual(stored);
      // Shown back to the admin (and the customer) as the same day.
      const [y, m, d] = key.split("-").map(Number) as [number, number, number];
      expect(formatDate(stored as Date)).toBe(
        `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`,
      );
    }
  });

  it("a month preset counts from the China day of 'now' (late evening UTC is tomorrow in China)", () => {
    const before = computeAccessExpiry(
      { kind: "months", months: 3 },
      { now: new Date("2026-10-10T15:59:59.999Z"), current: null },
    );
    const after = computeAccessExpiry(
      { kind: "months", months: 3 },
      { now: new Date("2026-10-10T16:00:00.000Z"), current: null },
    );
    expect(before?.toISOString()).toBe("2027-01-10T15:59:59.999Z");
    expect(after?.toISOString()).toBe("2027-01-11T15:59:59.999Z");
  });

  it("'expired?' is an instant comparison: valid through the last ms of the China day", () => {
    const end = endOfZonedDay("2026-12-31") as Date;
    const customer = (accessExpiresAt: Date) => ({
      id: "000000000000000000000001",
      role: "customer",
      banned: false,
      mustChangePassword: false,
      accessExpiresAt,
    });
    expect(
      checkDatasheetAccess(customer(end), new Date(end.getTime() - 1)).ok,
    ).toBe(true);
    expect(
      checkDatasheetAccess(customer(end), new Date(end.getTime() + 1)),
    ).toMatchObject({ ok: false, reason: "expired" });
    // 08:00Z on the picked day is still that day in China: still allowed.
    expect(
      checkDatasheetAccess(customer(end), new Date("2026-12-31T08:00:00Z")).ok,
    ).toBe(true);
  });
});

describe("with the database", () => {
  let actor: AdminActor;

  beforeAll(async () => {
    actor = await signedInAdmin(harness, "gate-b-time-admin@example.com");
  }, 120_000);

  it("the 08:00Z cron reminds each picked day exactly 7 China days before, never 8", async () => {
    const users = getDb().collection("users");
    const picked = days("2027-01-01", 366);
    const ids = new Map<string, string>();
    const docs = picked.map((key) => {
      const _id = new ObjectId();
      ids.set(_id.toHexString(), key);
      return {
        _id,
        email: `remind-${key}@gate-b.test`,
        name: `R ${key}`,
        role: "customer",
        banned: false,
        mustChangePassword: false,
        emailVerified: false,
        // Through the same function the admin's custom date uses.
        accessExpiresAt: computeAccessExpiry(
          { kind: "date", date: key },
          { now: new Date("2026-12-01T00:00:00Z"), current: null },
        ),
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      };
    });
    await users.insertMany(docs);
    try {
      const firstDue = new Map<string, string>();
      // Every 08:00Z run from 2026-12-20 to 2027-12-31.
      for (const run of days("2026-12-20", 377)) {
        const now = new Date(`${run}T08:00:00.000Z`);
        const due = await users
          .find(
            { $and: [{ email: /@gate-b\.test$/ }, dueFilter(now)] },
            { projection: { _id: 1 } },
          )
          .toArray();
        for (const doc of due) {
          const id = doc._id.toHexString();
          if (!firstDue.has(id)) firstDue.set(id, run);
        }
      }
      const wrong: string[] = [];
      for (const [id, key] of ids) {
        const expected = addDaysToDayKey(key, -7);
        if (firstDue.get(id) !== expected) {
          wrong.push(`${key}: first due ${firstDue.get(id)}, want ${expected}`);
        }
      }
      expect(wrong).toEqual([]);

      // A late run (15:59Z) is the same China day as 08:00Z; 16:00Z is not.
      const key = "2027-06-15";
      const find = (iso: string) =>
        users.countDocuments({
          $and: [
            { email: `remind-${key}@gate-b.test` },
            dueFilter(new Date(iso)),
          ],
        });
      expect(await find("2027-06-07T15:59:59.999Z")).toBe(0);
      expect(await find("2027-06-07T16:00:00.000Z")).toBe(1);
      expect(await find("2027-06-08T08:00:00.000Z")).toBe(1);
    } finally {
      await users.deleteMany({ email: /@gate-b\.test$/ });
    }
  }, 120_000);

  it("the 'expiring' filter and the per-row state agree at 15:59:59.999Z and at 16:00Z", async () => {
    const users = getDb().collection("users");
    // Ends at the end of the China day 30 / 31 days after 2026-10-10 (China).
    const day30 = endOfZonedDay("2026-11-09") as Date;
    const day31 = endOfZonedDay("2026-11-10") as Date;
    const base = {
      role: "customer",
      banned: false,
      mustChangePassword: false,
      emailVerified: false,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    };
    await users.insertMany([
      {
        ...base,
        email: "exp30@gate-b-exp.test",
        name: "Exp30zz",
        accessExpiresAt: day30,
      },
      {
        ...base,
        email: "exp31@gate-b-exp.test",
        name: "Exp31zz",
        accessExpiresAt: day31,
      },
    ]);
    try {
      const cases: [string, string[]][] = [
        // Still 10 Oct in China: day 30 is in, day 31 out.
        ["2026-10-10T15:59:59.999Z", ["exp30@gate-b-exp.test"]],
        // Now 11 Oct in China: both in.
        [
          "2026-10-10T16:00:00.000Z",
          ["exp30@gate-b-exp.test", "exp31@gate-b-exp.test"],
        ],
      ];
      for (const [iso, expected] of cases) {
        const now = new Date(iso);
        const filtered = await users
          .find({
            $and: [
              { email: /@gate-b-exp\.test$/ },
              customerStatusFilter("expiring", now),
            ],
          })
          .toArray();
        expect(filtered.map((u) => u.email).sort(), iso).toEqual(expected);

        const list = await listCustomers(
          actor,
          { q: "gate-b-exp.test", status: "", sort: "created", page: 1 },
          { now },
        );
        const expiringRows = list.rows
          .filter((row) => row.access === "expiring")
          .map((row) => row.email)
          .sort();
        expect(expiringRows, `rows at ${iso}`).toEqual(expected);

        const viaFilter = await listCustomers(
          actor,
          {
            q: "gate-b-exp.test",
            status: "expiring",
            sort: "created",
            page: 1,
          },
          { now },
        );
        expect(viaFilter.rows.map((row) => row.email).sort()).toEqual(expected);
      }
      // Sanity: 31 days is more than 30*24 h from 10 Oct 15:59Z, yet the
      // window is counted in China days, not hours.
      expect(
        day31.getTime() - Date.parse("2026-10-10T16:00:00Z"),
      ).toBeGreaterThan(30 * DAY);
    } finally {
      await users.deleteMany({ email: /@gate-b-exp\.test$/ });
    }
  });
});
