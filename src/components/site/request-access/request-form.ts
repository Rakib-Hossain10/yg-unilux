// Pure rules of the /request-access form (Phase 5 P6, plan Q2/Q3, ADR 0069):
// reading the posted FormData into the plain object the service expects,
// turning the service's answer into the form's state, the page's query
// parameters and the WhatsApp link. No React, no server-only import, so the
// Server Action, the page, the client form and the unit tests share it.

import { z } from "zod";

import { objectIdSchema } from "@/lib/schemas/common";
import { formStampSchema } from "@/lib/schemas/form-stamp";

/** The visible text fields, in form order. */
export const REQUEST_TEXT_FIELDS = [
  "name",
  "email",
  "company",
  "country",
  "phone",
  "message",
] as const;
export type RequestTextField = (typeof REQUEST_TEXT_FIELDS)[number];
export type RequestErrorField = RequestTextField | "consent";

/*
 * The anti-spam field names. They must equal HONEYPOT_FIELD and
 * STARTED_AT_FIELD of src/lib/access-requests.ts (server-only, so not
 * importable here); request-form.test.ts checks the two stay equal.
 */
export const HONEYPOT_NAME = "website";
export const STARTED_AT_NAME = "startedAt";

/** What the visitor typed, echoed back after an error so nothing is lost. */
export type RequestFormValues = Partial<Record<RequestTextField, string>> & {
  consent?: boolean;
};

export type RequestFormState =
  | { status: "idle" }
  /** Every accepted, merged, limited or spam submission alike. */
  | { status: "sent"; message: string }
  | {
      status: "invalid";
      fieldErrors: Partial<Record<RequestErrorField, string>>;
      formError: string | null;
      values: RequestFormValues;
      /**
       * The first render's signed stamp, re-sent unchanged so a fix is not
       * "too fast" (never a new one: the fill time counts from first render).
       */
      startedAt: string | null;
    }
  | {
      status: "unavailable";
      message: string;
      values: RequestFormValues;
      startedAt: string | null;
    };

export const IDLE_STATE: RequestFormState = { status: "idle" };

/** Shown above the fields when they hold errors. */
export const FIELD_ERRORS_SUMMARY =
  "Some details need another look. They are marked below.";
/** Shown when a hidden field (kind, product) or the whole post is refused. */
export const FORM_REFUSED =
  "This form could not be read. Reload the page and try again.";

/*
 * The raw post, shape only: each known field is a string or absent, and no
 * field may be absurdly long (the service's schema enforces the real
 * limits with readable messages). Files and unknown keys are dropped.
 */
const MAX_RAW_LENGTH = 20_000;
const rawText = z.string().max(MAX_RAW_LENGTH).optional();
/*
 * The signed stamp: over the raw cap it is refused like any field; under it,
 * anything not shaped like a stamp (bounded length, digits "." base64url) is
 * dropped, not refused, so the service treats it as missing and gives the
 * same answer as every other automated post (no enumeration).
 */
const stampText = rawText.transform((value) =>
  value !== undefined && formStampSchema.safeParse(value).success
    ? value
    : undefined,
);
const postedShape = z.object({
  name: rawText,
  email: rawText,
  company: rawText,
  country: rawText,
  phone: rawText,
  message: rawText,
  product: rawText,
  kind: rawText,
  consent: rawText,
  [HONEYPOT_NAME]: rawText,
  [STARTED_AT_NAME]: stampText,
});
export type PostedRequest = z.infer<typeof postedShape>;

const POSTED_KEYS = Object.keys(postedShape.shape) as (keyof PostedRequest)[];

/**
 * The posted form as a plain object, or null when its shape is refused
 * (an over-long field). A file in a text field is dropped; a file in the
 * honeypot still counts as filled.
 */
export function readRequestForm(formData: FormData): PostedRequest | null {
  // A required field the browser did not send (an untouched select) is
  // "", so the schema answers with its own message, not a type error.
  const raw: Record<string, string | undefined> = {
    name: "",
    email: "",
    company: "",
    country: "",
  };
  for (const key of POSTED_KEYS) {
    const value = formData.get(key);
    if (typeof value === "string") raw[key] = value;
    else if (value !== null && key === HONEYPOT_NAME) raw[key] = "file";
  }
  const parsed = postedShape.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The values to put back into the fields after an error. */
export function echoValues(posted: PostedRequest | null): RequestFormValues {
  if (!posted) return {};
  const values: RequestFormValues = {};
  for (const field of REQUEST_TEXT_FIELDS) {
    const value = posted[field];
    if (value !== undefined) values[field] = value;
  }
  // The values the service's consent schema accepts from a form post.
  values.consent = posted.consent === "on" || posted.consent === "true";
  return values;
}

/** The service's answer, structurally (src/lib/access-requests.ts). */
export type ServiceAnswer =
  | { ok: true }
  | {
      ok: false;
      errors: { formErrors: string[]; fieldErrors: Record<string, string[]> };
    }
  | { ok: false; unavailable: true };

const ERROR_FIELDS: ReadonlySet<string> = new Set<RequestErrorField>([
  ...REQUEST_TEXT_FIELDS,
  "consent",
]);

/*
 * The schema's messages are shared with the admin screens, which show them
 * as short labels; on this public page every field error is a sentence and
 * ends with a full stop, like /login's.
 */
function asSentence(message: string): string {
  const text = message.trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * The form state for one answer. `messages` are the service's own texts
 * (ACCESS_REQUEST_THANKS / _UNAVAILABLE), passed in by the Server Action.
 */
export function stateForAnswer(
  answer: ServiceAnswer,
  posted: PostedRequest | null,
  messages: { thanks: string; unavailable: string },
): RequestFormState {
  if (answer.ok) return { status: "sent", message: messages.thanks };
  const values = echoValues(posted);
  const startedAt = posted?.[STARTED_AT_NAME] ?? null;
  if ("unavailable" in answer) {
    return {
      status: "unavailable",
      message: messages.unavailable,
      values,
      startedAt,
    };
  }
  // Errors on the hidden fields (kind, product) or the whole form have no
  // field to sit under: without a visible one, the form says to reload.
  const fieldErrors: Partial<Record<RequestErrorField, string>> = {};
  for (const [field, list] of Object.entries(answer.errors.fieldErrors)) {
    const first = list[0];
    if (first && ERROR_FIELDS.has(field)) {
      fieldErrors[field as RequestErrorField] = asSentence(first);
    }
  }
  const visible = Object.keys(fieldErrors).length > 0;
  return {
    status: "invalid",
    fieldErrors,
    formError: visible ? FIELD_ERRORS_SUMMARY : FORM_REFUSED,
    values,
    startedAt,
  };
}

/** The state for a post whose shape was refused before the service ran. */
export function refusedState(): RequestFormState {
  return {
    status: "invalid",
    fieldErrors: {},
    formError: FORM_REFUSED,
    values: {},
    startedAt: null,
  };
}

/** `?renew=1` and `?product=<id>`, each accepted only when given once. */
export interface RequestPageParams {
  renew: boolean;
  productId: string | null;
}

export function requestPageParams(params: {
  renew?: string | string[];
  product?: string | string[];
}): RequestPageParams {
  const renew = params.renew === "1";
  const product = objectIdSchema.safeParse(params.product);
  return { renew, productId: product.success ? product.data : null };
}

/**
 * The WhatsApp chat link with a first message, or null without a number.
 * `base` is whatsappLink()'s https://wa.me/<digits>.
 */
export function whatsappRequestHref(
  base: string | null,
  options: { renew: boolean; product: string | null },
): string | null {
  if (!base) return null;
  const what = options.renew
    ? "renew my datasheet access"
    : "request datasheet access";
  const text = options.product
    ? `Hello, I would like to ${what} for ${options.product}.`
    : `Hello, I would like to ${what}.`;
  return `${base}?text=${encodeURIComponent(text)}`;
}
