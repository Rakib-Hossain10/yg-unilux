# 0076 — Dates shown in China time; expiry days and reminder windows counted in China-time days
- Status: Accepted (user decision, 2026-10-10)
- Date: 2026-10-10
- Supersedes: ADR 0075 §6 (UTC display). Amends ADR 0070 (end of UTC day → end of China-time day) and ADR 0072 (window and digest key in China-time days).

## Context
ADR 0075 §6 showed admin dates in UTC and stored an expiry as the end of the UTC day, so "expires 31 Dec" ended at 08:00 on 1 Jan in China. The client team works in China time. Customers are mostly in the UAE and Europe.

## Decision
1. **One setting.** `APP_TIME_ZONE = "Asia/Shanghai"` and `APP_TIME_ZONE_LABEL = "China time"` in `src/lib/time-zone.ts` are the only place the zone lives. They are code constants, not env, because the module is client-safe (no `server-only`) and server and browser must print identical text. Changing the two constants changes the zone everywhere.
2. **Storage stays UTC.** Only display and day boundaries use the zone.
3. **Display.** `formatDateTime` → "10 Oct 2026, 14:30 (China time)" (24 h); `formatDate` → "10 Oct 2026", with `{label: true}` → "10 Oct 2026 (China time)". Built from numeric Intl parts and our own month names, so Node and browsers give the same ASCII.
4. **End-of-day rule.** A day the admin picks ends at the last millisecond of that day in the zone (31 Dec → `2026-12-31T15:59:59.999Z`). Month presets add calendar months to the zone day of the later of now and the current end (clamped at month end), then take the end of that zone day. Offsets come from Intl (no hard-coded +8), DST-correct for any IANA zone.
5. **Windows.** The reminder is due when access ends after now and no later than the end of the zone day 7 days after today's zone day; the admin "expiring" filter is the same rule with 30 days. "Expired?" stays an instant comparison (`accessExpiresAt > now`). The digest idempotency key uses the zone day.
6. **Cron stays at 08:00 UTC** (user decision): customers are mostly in the UAE (12:00) and Europe (morning); 01:00 UTC would arrive at night. 08:00 UTC is 16:00 the same calendar day in China, so each run falls on one China date and the reminder goes out on the run exactly 7 China days before the picked day. A test sets expiry through `computeAccessExpiry` (custom date and month preset) and checks the 8-days-before run sends nothing and the 7-days-before run sends it.
7. **Customer-facing dates** (emails, `/my-downloads` access line, download history) use the same module, so customer and admin see the same end date.
8. **No migration before launch.** Dev values stored as `…T23:59:59.999Z` now show one day later; re-save or reseed. If real customers ever exist under the old rule, a one-off script maps each value to `endOfZonedDay(<UTC day of the old value>)` through `account-writes`.

## Consequences
- The three UTC formatters (P7 `format.ts`, `format-date.ts`, datasheet/products copies) are gone; all admin dates go through `@/lib/time-zone`.
- The expiry picker says access ends at the end of the chosen day, China time.
