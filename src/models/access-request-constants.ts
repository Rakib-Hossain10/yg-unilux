// Plain access-request constants (sources, statuses, kinds, limits) with no
// imports, so client form schemas can use them without pulling in the
// database layer.

export const ACCESS_REQUEST_SOURCES = ["form", "whatsapp"] as const;
export type AccessRequestSource = (typeof ACCESS_REQUEST_SOURCES)[number];

export const ACCESS_REQUEST_STATUSES = [
  "pending",
  "approved",
  "rejected",
] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

/** "new" access, or a "renewal" from the "Access expired" link (plan Q2/Q6). */
export const ACCESS_REQUEST_KINDS = ["new", "renewal"] as const;
export type AccessRequestKind = (typeof ACCESS_REQUEST_KINDS)[number];

/** The longest internal reject reason the admin can type. */
export const MAX_REJECT_REASON_LENGTH = 500;
