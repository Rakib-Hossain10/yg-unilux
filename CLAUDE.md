# YG UniLUX — Catalog Website

Premium lighting-product catalog for YG UniLUX (commercial lighting manufacturer).
500+ products, public catalog + admin panel + restricted Excel datasheets.
Visitors from mainland China are blocked (Hong Kong, Macau, Taiwan are allowed).
English only — no i18n library, no language switcher, no `[locale]` routes.

## Stack
- Next.js (App Router) + TypeScript, Tailwind CSS, shadcn/ui (admin)
- Motion: GSAP + ScrollTrigger, Lenis smooth scroll, Motion (Framer Motion)
- MongoDB Atlas + Mongoose
- Auth.js — credentials only, role stored in session, NO public sign-up
- Cloudinary — public product images
- Private files (.xlsx datasheets, whistleblower attachments): Cloudinary `authenticated` raw OR Cloudflare R2 private bucket
- Resend (email), MongoDB Atlas Search, React Hook Form + Zod
- Vercel Cron for the daily access-expiry reminder job
- Hosting: Vercel (+ Vercel Firewall for geo-block)

## Folder structure
```
src/
  app/
    (site)/          home, products, areas, product/[slug], services, oem-odm, rnd, about, contact, legal
    (account)/       login, change-password, my-downloads
    whistleblower/   report form, inbox
    admin/           dashboard + admin modules
    api/             datasheet download, uploads, auth, import, cron
    blocked/         page shown to mainland China
  components/        ui/ (shadcn), site/, admin/, motion/
  lib/               db, auth, cloudinary, storage, email, geo, permissions
  models/            one Mongoose schema per collection
  middleware.ts      geo-block + admin guard (named proxy.ts on Next.js 16+)
```

## Domain model
- Two independent browse dimensions:
  - **Categories** = product type. Tree (`parent` null = main category). ~10 main categories.
  - **Areas** = application (7): Residential, Retail, Hospitality, Office, Healthcare, Education, Exhibition.
- Product has `mainCategory`, `extraCategories[]` (same product can appear under e.g. Spot Lights→Recessed AND Recessed Lights→Spot), and `areas[]`.
- Category tree lives in the DB and is edited in the admin panel (7 main categories known now, 3 more coming — never hard-code the list).
- Magnetic Track subcategories: 5mm, 10mm, 20mm, GOBO, Linear, Decorative. Products there also carry `trackSize` (5 | 10 | 20) used as a listing filter.
- Product data follows the client's spec sheet (33 columns, headers "English\nChinese"). Three levels:
  - **Family** = `Model Name` (e.g. "Arc") → "More from Arc" strip + family filter.
  - **Product** = one `NO.` (e.g. 76) → ONE product page. A row with an empty `NO.` belongs to the product above it.
  - **Variant** = each row / `Model No.` (e.g. AR-013A1 lens, AR-013A2 reflector) → optic switch on the page (updates model no., lumen, efficacy).
  - Slug = family + base model code, e.g. `/product/arc-ar-013a`. Every variant's model no. is searchable.
- Sheet columns: NO., Model Name, Model Type, Model No., Batch No., Image, Housing Material, Housing Color/Finish, Reflector Color, Lens, Reflector, Diffuser, Cut-out Size, Dimensions, Rotating Angle, Chip Type, Holder, Chip Efficiency, CCT, CRI, Beam Angle, UGR, Driver, Voltage Input, Wattage, Lumen Output, Lumen Efficiency, Power Factor, SDCM, Dimmable, Lifespan, IP Rating, Warranty Period.
- Column visibility is an admin setting (public / restricted). Default restricted: Batch No., Chip Type, Holder, Chip Efficiency, Driver. Restricted values are stripped on the server for anyone who is not an active, unexpired customer or the admin — never sent to the browser and hidden with CSS.
- Filters: CCT, CRI, Beam Angle, UGR, Wattage, IP Rating (+ trackSize for Magnetic Track). Store parsed numeric values alongside display strings for filtering.
- Extra product info outside the sheet goes in `extraSpecs: {group, label, value}[]`.

### Bulk import rules (admin uploads the client's sheet as-is)
- English only: keep text before the first blank line in a cell; strip CJK characters from mixed cells ("Lifud 莱福德" → "Lifud").
- Multi-line cells → option arrays (CCT "3000K\n4000K", beam "20°\n30°\n40°\n60°", finish "White/Black").
- Values equal across a product's rows → product-level specs; values that differ → variant fields.
- "-" and blank = not applicable → hidden.
- Extract embedded images by row anchor (xl/drawings) and upload to Cloudinary; admin adds more images later.
- Category and areas are not in the sheet → optional extra template columns, else assigned after import.
- Always a preview step with per-row warnings (missing specs, no image, duplicate model no.) before saving. Re-import upserts by model no.; never duplicates.
- Restricted .xlsx download: one uploaded file can be attached to several products (e.g. a whole family sheet).
- All text is plain English strings.
- Datasheet: admin uploads one .xlsx per product (`product.datasheet` = storage key, file name, size, updatedAt). Same file for every approved customer. Accept .xlsx only (check file signature, not just extension), max 10 MB. No datasheet → show "Datasheet coming soon".
- Customer access: one approval unlocks ALL datasheets. `user.accessExpiresAt` is set by the admin at account creation/approval (3/6/12 months, custom date, or null = no expiry) and can be extended later. Expired → login works but downloads are locked with "Access expired — contact us". Daily cron emails customers 7 days before expiry.
- Collections: products, categories, areas, users, accessRequests, downloadLogs, leaders, siteContent, whistleblowerCases, auditLog.

## Roles
Only two: `admin` and `customer` (keep the `role` field so a second admin can be added later without code changes).
- **admin** — ONE account for the client, created by a seed script (`npm run seed:admin`). Full access to everything in `/admin`, including whistleblower cases. No staff-user management screen.
- **customer** — created by the admin; front-end login + datasheet download only, no admin access.
- Single admin must never get locked out: provide an email password-reset link AND let the seed script reset the admin password from the CLI.

## Security rules — never break these
1. A datasheet .xlsx is NEVER in `/public` and NEVER behind a public URL.
2. Datasheets are served only via `/api/datasheet/[productId]`: check session → role=customer or admin → status active → not expired → return a short-lived (~60 s) signed URL → write a downloadLogs entry.
3. Every admin page AND every admin API route checks the role on the server. Hiding a button is not access control.
4. No self-registration. Accounts are created by the admin (manually or by approving an access request).
5. Passwords hashed (bcrypt/argon2); login rate-limited; new accounts have `mustChangePassword: true`.
6. Geo-block: `x-vercel-ip-country === 'CN'` → rewrite to `/blocked` (403), toggled by `GEO_BLOCK_ENABLED`. Block ONLY `CN` — never HK, MO or TW. Applies to the whole site including `/admin` (client team uses a VPN) unless told otherwise. Local dev has no country header, so it does not block locally.
7. Whistleblower: named reports = mailto the company email (`COMPANY_EMAIL` env / admin setting). Anonymous reports: never store IP, no analytics on those pages, strip EXIF from uploads, encrypt report text + messages at rest; alert email to the company email contains no report content.
8. Validate every form and API input with Zod on the server.

## Design
- Palette from the logo: black, white, warm greys; photography carries colour.
- Header: logo left · Product, Services, OEM/ODM, R&D, About us centred · search + account icons right (no language icon).
- References: HBA (nav, transitions, leadership carousel, closing page), Arelux (hero), Viabizzuno (7-area horizontal scroll), Delta Light (cookie banner, capabilities collage), KC Lighting (category icon strip in mega-menu).
- Respect `prefers-reduced-motion`. Horizontal-scroll sections become swipe carousels on mobile. Animations must not block first paint.
- Product, leader and factory photos are always real client photos — never AI-generated.

## Working conventions
- Start every session by reading `doc/tasks.md` (current phase + open tasks) and `doc/decisions/README.md` (ADR index). Decisions there override older text in this file until it is updated.
- End every session by ticking `doc/tasks.md`, adding a session-log line, and writing a new ADR in `doc/decisions/` for any design decision made.
- Build one phase at a time; plan first, then implement.
- Server Components by default; `"use client"` only where interaction/animation needs it.
- Keep admin UI plain and fast (shadcn); keep motion work in `components/motion/`.
