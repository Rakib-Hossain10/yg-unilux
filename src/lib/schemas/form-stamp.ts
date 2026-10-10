// The shape of a signed form stamp (ADR 0069 anti-spam, QA gate B L-1):
// "<issued ms>.<HMAC-SHA256 base64url>". Pure Zod (no server-only import),
// so the request form's reader and the server-only verifier share it. The
// shape says nothing about authenticity: src/lib/form-stamp.ts checks the MAC.

import { z } from "zod";

/* Up to 15 digits of ms since epoch (year 33658), then a 32-byte MAC. */
export const FORM_STAMP_PATTERN = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/;
/* 15 + 1 + 43. */
export const MAX_FORM_STAMP_LENGTH = 59;

export const formStampSchema = z
  .string()
  .max(MAX_FORM_STAMP_LENGTH)
  .regex(FORM_STAMP_PATTERN);
