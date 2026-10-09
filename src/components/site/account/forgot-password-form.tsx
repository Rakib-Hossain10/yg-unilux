"use client";

// The forgot-password form: one email field, a JSON POST to Better Auth's
// /api/auth/request-password-reset with redirectTo "/reset-password" (the
// email's link lands there with ?token=). Every accepted request, for a known
// or unknown address, ends in the same neutral confirmation (no enumeration).

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { RESET_PASSWORD_PAGE } from "@/lib/account-destination";

import { FormAlert, FormField, primaryButton, textLink } from "./account-ui";
import { MESSAGES, forgotPasswordOutcome } from "./auth-messages";

const schema = z.object({
  email: z.email(MESSAGES.invalidEmail).max(254),
});
type Values = z.infer<typeof schema>;

export function ForgotPasswordForm() {
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: "" },
  });

  async function onSubmit(values: Values) {
    setFormError(null);
    let status = 0;
    try {
      const response = await fetch("/api/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: values.email,
          redirectTo: RESET_PASSWORD_PAGE,
        }),
        credentials: "same-origin",
      });
      status = response.status;
    } catch {
      status = 0;
    }
    const outcome = forgotPasswordOutcome(status);
    if (outcome.kind === "form") {
      setFormError(outcome.message);
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <div className="mt-10 space-y-6 text-center">
        {/* Focus moves to the confirmation when it appears, so keyboard and
            screen-reader users land on the answer, not on a form that has
            gone. */}
        <p
          ref={(node) => node?.focus()}
          tabIndex={-1}
          role="status"
          className="border-l-2 border-ink bg-grey-50 px-4 py-3 text-left text-sm outline-none"
        >
          {MESSAGES.resetSent}
        </p>
        <p className="text-sm text-grey-600">
          Nothing arrived? Check your spam folder, or{" "}
          <button
            type="button"
            onClick={() => setSent(false)}
            className={`${textLink} min-h-0 cursor-pointer`}
          >
            try another address
          </button>
          .
        </p>
        <a href="/login" className={textLink}>
          Back to sign in
        </a>
      </div>
    );
  }

  return (
    // method="post": a submit before hydration never puts the address in
    // the URL (ADR 0029).
    <form
      method="post"
      onSubmit={handleSubmit(onSubmit)}
      noValidate
      className="mt-10 space-y-5"
    >
      <FormField
        id="email"
        label="Email"
        error={errors.email?.message}
        inputProps={{
          type: "email",
          autoComplete: "username",
          inputMode: "email",
          spellCheck: false,
          ...register("email"),
        }}
      />

      <FormAlert>{formError}</FormAlert>

      <button type="submit" disabled={isSubmitting} className={primaryButton}>
        {isSubmitting ? "Sending…" : "Send reset link"}
      </button>

      <p className="text-center text-sm">
        <a href="/login" className={textLink}>
          Back to sign in
        </a>
      </p>
    </form>
  );
}
