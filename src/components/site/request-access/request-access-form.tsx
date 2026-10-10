"use client";

// The /request-access form (Phase 5 P6, plan Q2/Q3). A plain <form> bound to
// the Server Action, so it posts and answers without JavaScript too; with
// JavaScript, useActionState keeps the page in place. All checks run on the
// server (the service's Zod), so the form has one source of error messages.
// After an error the typed values come back from the action and refill the
// fields (React resets an action form after each submit).

import { useActionState, useEffect, useRef, type ReactNode } from "react";

import { requestAccessAction } from "@/app/(site)/request-access/actions";
import {
  MAX_COMPANY_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_NAME_LENGTH,
} from "@/lib/schemas/access-request";

import { inputClass, labelClass, primaryButton } from "../account/account-ui";
import { COUNTRIES } from "./countries";
import {
  HONEYPOT_NAME,
  IDLE_STATE,
  STARTED_AT_NAME,
  type RequestErrorField,
  type RequestFormValues,
} from "./request-form";

/* A select drawn like the inputs, with a line chevron (no native arrow). */
const selectClass = `${inputClass} cursor-pointer appearance-none bg-[url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2016%2016'%20fill='none'%20stroke='%23111110'%20stroke-width='1.25'%3E%3Cpath%20d='M4%206l4%204%204-4'/%3E%3C/svg%3E")] bg-[length:1rem] bg-[right_0.75rem_center] bg-no-repeat pr-10`;

const optional = (
  <span className="ml-1.5 tracking-normal text-grey-600 normal-case">
    (optional)
  </span>
);

/** Label, control slot, hint and error with their ids, for one field. */
function Field({
  id,
  label,
  isOptional,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  isOptional?: boolean;
  hint?: string;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className={labelClass}>
        {label}
        {isOptional ? optional : null}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-grey-600">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* aria-invalid and aria-describedby for a control. */
function described(
  id: string,
  error: string | undefined,
  hint?: boolean,
): { "aria-invalid"?: true; "aria-describedby"?: string } {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");
  return {
    ...(error ? { "aria-invalid": true as const } : {}),
    ...(ids ? { "aria-describedby": ids } : {}),
  };
}

export function RequestAccessForm({
  renew,
  productId,
  startedAt,
  prefill,
  extraCountry,
  submitLabel,
  afterSent,
}: {
  renew: boolean;
  /** A published product's id, or null. */
  productId: string | null;
  /** When the server rendered the form (ms since epoch). */
  startedAt: string;
  /** From the signed-in user's DATABASE session, never from the URL. */
  prefill: RequestFormValues;
  /** The signed-in user's stored country when it is not in the list. */
  extraCountry: string | null;
  submitLabel: string;
  /** Links shown under the thanks message. */
  afterSent: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(
    requestAccessAction,
    IDLE_STATE,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const sentRef = useRef<HTMLParagraphElement>(null);

  // Move focus to what changed: the answer, or the first field to fix.
  useEffect(() => {
    if (state.status === "sent") {
      sentRef.current?.focus();
    } else if (state.status === "invalid") {
      formRef.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus();
    }
  }, [state]);

  if (state.status === "sent") {
    return (
      <div className="space-y-8">
        <p
          ref={sentRef}
          tabIndex={-1}
          role="status"
          data-request-state="sent"
          className="border-l-2 border-ink py-1 pl-5 font-display text-2xl leading-snug font-light text-pretty outline-none md:text-3xl"
        >
          {state.message}
        </p>
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          {afterSent}
        </div>
      </div>
    );
  }

  const values: RequestFormValues =
    state.status === "idle" ? prefill : state.values;
  const errors: Partial<Record<RequestErrorField, string>> =
    state.status === "invalid" ? state.fieldErrors : {};
  const formMessage =
    state.status === "invalid"
      ? state.formError
      : state.status === "unavailable"
        ? state.message
        : null;
  const firstStart =
    state.status === "idle" ? startedAt : (state.startedAt ?? startedAt);
  const countries = extraCountry ? [extraCountry, ...COUNTRIES] : COUNTRIES;

  return (
    // noValidate: the server's rules are the only rules, with its messages.
    <form ref={formRef} action={formAction} noValidate>
      {/* Always in the DOM (announced when its text appears). */}
      <div
        role="alert"
        data-request-message
        className="mb-6 text-sm text-danger empty:mb-0"
      >
        {formMessage}
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        <input type="hidden" name="kind" value={renew ? "renewal" : "new"} />
        {productId ? (
          <input type="hidden" name="product" value={productId} />
        ) : null}
        <input type="hidden" name={STARTED_AT_NAME} defaultValue={firstStart} />
        {/* The honeypot: off screen, out of the tab order and hidden from
          assistive technology. People never fill it; bots often do. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-[10000px] h-px w-px overflow-hidden"
        >
          <label htmlFor="request-website">Website</label>
          <input
            id="request-website"
            type="text"
            name={HONEYPOT_NAME}
            tabIndex={-1}
            autoComplete="off"
            defaultValue=""
          />
        </div>

        <Field id="request-name" label="Name" error={errors.name}>
          <input
            id="request-name"
            name="name"
            type="text"
            autoComplete="name"
            required
            maxLength={MAX_NAME_LENGTH}
            defaultValue={values.name ?? ""}
            className={inputClass}
            {...described("request-name", errors.name)}
          />
        </Field>

        <Field id="request-email" label="Work email" error={errors.email}>
          <input
            id="request-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            spellCheck={false}
            required
            maxLength={254}
            defaultValue={values.email ?? ""}
            className={inputClass}
            {...described("request-email", errors.email)}
          />
        </Field>

        <Field id="request-company" label="Company" error={errors.company}>
          <input
            id="request-company"
            name="company"
            type="text"
            autoComplete="organization"
            required
            maxLength={MAX_COMPANY_LENGTH}
            defaultValue={values.company ?? ""}
            className={inputClass}
            {...described("request-company", errors.company)}
          />
        </Field>

        <Field id="request-country" label="Country" error={errors.country}>
          {/* Keyed on the echoed value: React applies a select's
              defaultValue only on mount, and the form resets after each
              submit, so a new mount keeps the visitor's choice. */}
          <select
            key={values.country ?? ""}
            id="request-country"
            name="country"
            required
            defaultValue={values.country ?? ""}
            className={selectClass}
            {...described("request-country", errors.country)}
          >
            <option value="" disabled>
              Choose a country
            </option>
            {countries.map((country) => (
              <option key={country} value={country}>
                {country}
              </option>
            ))}
          </select>
        </Field>

        <Field
          id="request-phone"
          label="Phone"
          isOptional
          hint="With country code, e.g. +852 2345 6789."
          error={errors.phone}
        >
          <input
            id="request-phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            maxLength={40}
            defaultValue={values.phone ?? ""}
            className={inputClass}
            {...described("request-phone", errors.phone, true)}
          />
        </Field>

        <Field
          id="request-message"
          label="Message"
          isOptional
          hint="The project or products you are working on helps us answer sooner."
          error={errors.message}
          className="sm:col-span-2"
        >
          <textarea
            id="request-message"
            name="message"
            rows={4}
            maxLength={MAX_MESSAGE_LENGTH}
            defaultValue={values.message ?? ""}
            className={`${inputClass} h-auto min-h-28 resize-y py-2.5 leading-relaxed`}
            {...described("request-message", errors.message, true)}
          />
        </Field>

        <div className="sm:col-span-2">
          {/* The whole row is the hit area (at least 44 px tall). */}
          <label
            htmlFor="request-consent"
            className="flex min-h-11 cursor-pointer items-start gap-3 py-1 text-sm leading-relaxed text-grey-700"
          >
            <input
              id="request-consent"
              name="consent"
              type="checkbox"
              required
              defaultChecked={values.consent ?? false}
              className="mt-[3px] size-[18px] shrink-0 cursor-pointer accent-ink"
              {...described("request-consent", errors.consent)}
            />
            <span>
              {/* TODO(Phase 7): link "privacy notice" to the privacy page once
                it exists; until then it is plain text. */}
              I agree that YG UniLUX keeps these details to answer my request,
              as described in our privacy notice.
            </span>
          </label>
          {errors.consent ? (
            <p
              id="request-consent-error"
              className="mt-1 pl-[30px] text-sm text-danger"
            >
              {errors.consent}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-4 sm:col-span-2 sm:flex-row sm:items-center">
          <button
            type="submit"
            disabled={pending}
            className={`${primaryButton} whitespace-nowrap sm:w-auto sm:min-w-56`}
          >
            {pending ? "Sending…" : submitLabel}
          </button>
          <p className="text-sm text-grey-600">
            We reply by email. No account is made until we approve it.
          </p>
        </div>
      </div>
    </form>
  );
}
