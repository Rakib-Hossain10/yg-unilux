// Admin dashboard figures: live counts of products, categories, areas,
// datasheets, customers, open access requests and open whistleblower cases.
// Counts only, never document content, and never cached (admin-only live view).

import "server-only";

import { connectDb } from "@/lib/db";
import {
  AccessRequestModel,
  AreaModel,
  CategoryModel,
  DatasheetModel,
  ProductModel,
  UserModel,
  WhistleblowerCaseModel,
} from "@/models";
import type { AccessRequestStatus } from "@/models/access-request";
import type { ProductStatus } from "@/models/product";
import type { CaseStatus } from "@/models/whistleblower-case";

import { assertAdminActor, type AdminActor } from "./actor";

/** The numbers shown on the admin dashboard. */
export interface DashboardCounts {
  products: { total: number; published: number; draft: number };
  /** main = top-level (`parent: null`), sub = every category with a parent. */
  categories: { main: number; sub: number };
  areas: number;
  datasheets: number;
  /** Accounts holding the `customer` role, banned or not. */
  customers: number;
  /** Access requests still waiting for the admin (`pending`). */
  openAccessRequests: number;
  /** Whistleblower cases not yet closed (`received` or `under_review`). */
  openWhistleblowerCases: number;
}

/*
 * Status values come from the models' own enums; `satisfies` makes a renamed
 * or removed value a type error here instead of a silent zero.
 */
const PUBLISHED: ProductStatus = "published";
const DRAFT: ProductStatus = "draft";
const OPEN_ACCESS_REQUEST: AccessRequestStatus = "pending";
const OPEN_CASE_STATUSES = [
  "received",
  "under_review",
] as const satisfies readonly CaseStatus[];

/*
 * Better Auth's admin plugin stores several roles as one comma-joined string
 * ("admin,customer"), so an exact match would miss those. This mirrors
 * hasRole() in src/lib/auth.ts: "customer" as one comma-separated entry,
 * surrounding spaces allowed; "customers" or "notcustomer" do not match.
 */
const CUSTOMER_ROLE = /(?:^|,)\s*customer\s*(?:,|$)/;

/**
 * Live dashboard counts, all queried in parallel. Not cached on purpose: the
 * admin expects to see a change the moment it is saved, and this data never
 * goes to a public page. Returns numbers only (no restricted specs, no
 * whistleblower content, no user details).
 *
 * Index use per count:
 * - products by status: `{ status: 1 }`;
 * - categories by parent: prefix of `{ parent: 1, slug: 1 }`;
 * - access requests by status: prefix of `{ status: 1, createdAt: -1 }`;
 * - areas, datasheets: an empty filter counts the whole (small, tens of
 *   documents) collection;
 * - customers: NOT index-backed. Better Auth owns `users` and its indexes
 *   (only `email`), and the role check is an unanchored regex. Users are
 *   admin-created, so the collection stays small (hundreds at most);
 * - whistleblower cases by status: NOT index-backed (the model only indexes
 *   `caseNumber`). Cases are rare; the scan stays inside MongoDB and returns
 *   a number only.
 */
export async function getCounts(actor: AdminActor): Promise<DashboardCounts> {
  await assertAdminActor(actor);
  await connectDb();

  const [
    published,
    draft,
    mainCategories,
    subCategories,
    areas,
    datasheets,
    customers,
    openAccessRequests,
    openWhistleblowerCases,
  ] = await Promise.all([
    ProductModel.countDocuments({ status: PUBLISHED }),
    ProductModel.countDocuments({ status: DRAFT }),
    CategoryModel.countDocuments({ parent: null }),
    CategoryModel.countDocuments({ parent: { $ne: null } }),
    AreaModel.countDocuments({}),
    DatasheetModel.countDocuments({}),
    // Read-only model: countDocuments is a read, so its write guards never
    // fire, and Better Auth stays the only writer of `users`.
    UserModel.countDocuments({ role: { $regex: CUSTOMER_ROLE } }),
    AccessRequestModel.countDocuments({ status: OPEN_ACCESS_REQUEST }),
    WhistleblowerCaseModel.countDocuments({
      status: { $in: OPEN_CASE_STATUSES },
    }),
  ]);

  return {
    // The status enum is closed (draft | published), so the total is their
    // sum; this saves a third products query and keeps the figures consistent.
    products: { total: published + draft, published, draft },
    categories: { main: mainCategories, sub: subCategories },
    areas,
    datasheets,
    customers,
    openAccessRequests,
    openWhistleblowerCases,
  };
}
