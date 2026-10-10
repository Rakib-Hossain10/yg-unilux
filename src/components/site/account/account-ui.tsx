// Shared pieces of the account pages (/login, /change-password,
// /forgot-password, /reset-password, /my-downloads): the centred page frame,
// form fields and the button and link styles, so every page looks and reads
// the same (ADR 0028 shell: black, white, warm greys; Cormorant + Inter).
// Hook-free: usable from Server and Client Components.

import type { ComponentPropsWithoutRef, ReactNode } from "react";

export const inputClass =
  "mt-1.5 block h-11 w-full border border-grey-300 bg-paper px-3 text-base outline-offset-0 transition-colors duration-(--duration-quick) focus:border-ink aria-invalid:border-danger md:text-sm";

export const labelClass = "text-xs tracking-[0.14em] uppercase";

export const primaryButton =
  "inline-flex h-11 w-full items-center justify-center bg-ink px-6 text-xs tracking-[0.16em] text-paper uppercase transition-opacity duration-(--duration-quick) hover:opacity-90 disabled:opacity-60";

export const secondaryButton =
  "inline-flex h-11 items-center justify-center border border-ink px-6 text-xs tracking-[0.16em] uppercase transition-colors duration-(--duration-quick) hover:bg-ink hover:text-paper disabled:opacity-60";

export const textLink =
  "inline-flex min-h-11 items-center text-ink underline decoration-grey-400 underline-offset-4 transition-colors duration-(--duration-quick) hover:decoration-ink";

/**
 * A link (or link-styled button) inside running text: it keeps the line's
 * flow and leading, and py-3 -my-3 still gives it a 44 px tall hit area.
 */
export const inlineTextLink =
  "inline -my-3 py-3 text-ink underline decoration-grey-400 underline-offset-4 transition-colors duration-(--duration-quick) hover:decoration-ink";

/**
 * The narrow, centred column every password page uses: one display heading,
 * one sentence, then the form or message.
 */
export function AccountFrame({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-h-[60svh] flex-1 items-start justify-center px-4 py-16 md:items-center md:py-24">
      <div className="w-full max-w-sm">
        <h1 className="text-center font-display text-4xl font-light text-balance">
          {title}
        </h1>
        {intro ? (
          <p className="mt-3 text-center text-sm text-pretty text-grey-600">
            {intro}
          </p>
        ) : null}
        {children}
      </div>
    </section>
  );
}

/**
 * One labelled input with its hint and error, wired with aria-describedby.
 * `inputProps` carries React Hook Form's register() result.
 */
export function FormField({
  id,
  label,
  hint,
  error,
  inputProps,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  inputProps: ComponentPropsWithoutRef<"input">;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={inputClass}
        {...inputProps}
      />
      {hint ? (
        <p id={hintId} className="mt-1.5 text-sm text-grey-600">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="mt-1.5 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The form-level message line. Always rendered (reserved height, no layout
 * shift) and announced when its text appears.
 */
export function FormAlert({ children }: { children?: ReactNode }) {
  return (
    <div role="alert" className="mb-2 min-h-5 text-sm text-danger">
      {children}
    </div>
  );
}

/**
 * The end of an account form: the message line and the submit button as ONE
 * block, so the form's field rhythm (space-y-5) runs once above it and the
 * reserved message line sits tight on the button instead of adding a gap.
 * -mt-2 pulls the block into the 20 px rhythm gap: last field to button is
 * 12 + 20 (reserved line) + 8 = 40 px, one clear step before the action.
 */
export function FormActions({
  alert,
  children,
}: {
  /** The form-level message, or nothing. */
  alert?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="-mt-2">
      <FormAlert>{alert}</FormAlert>
      {children}
    </div>
  );
}
