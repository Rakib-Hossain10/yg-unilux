"use client";

// The set/reset password form for /reset-password (also used by invite links,
// ADR 0068): React Hook Form + Zod, then a JSON POST of {token, newPassword}
// to Better Auth's /api/auth/reset-password (never a Server Action). 200 →
// /login?reset=1 (every session was revoked). 400 INVALID_TOKEN (expired,
// used or unknown, one answer) → the expired view. The token is held in a
// prop only: never logged, never put in another URL.

import { zodResolver } from "@hookform/resolvers/zod";
import { type ReactNode, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import {
  AccountFrame,
  FormAlert,
  FormField,
  primaryButton,
} from "./account-ui";
import {
  MAX_PASSWORD_LENGTH,
  MESSAGES,
  MIN_PASSWORD_LENGTH,
  errorCodeOf,
  resetPasswordOutcome,
} from "./auth-messages";
import { resetCopy } from "./reset-state";

const schema = z
  .object({
    newPassword: z
      .string()
      .min(MIN_PASSWORD_LENGTH, MESSAGES.tooShort)
      .max(MAX_PASSWORD_LENGTH, MESSAGES.tooLong),
    confirmPassword: z.string(),
  })
  .refine((v) => v.confirmPassword === v.newPassword, {
    path: ["confirmPassword"],
    message: "The two passwords don't match.",
  });
type Values = z.infer<typeof schema>;

export function ResetPasswordForm({
  token,
  invite,
  expiredView,
}: {
  token: string;
  invite: boolean;
  /** Rendered instead of the form once the server says the link is dead. */
  expiredView: ReactNode;
}) {
  const copy = resetCopy(invite);
  const [expired, setExpired] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { newPassword: "", confirmPassword: "" },
  });

  async function onSubmit(values: Values) {
    setFormError(null);
    let response: Response;
    try {
      response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: values.newPassword }),
        credentials: "same-origin",
        // The page URL holds the token; never send it as a Referer.
        referrerPolicy: "no-referrer",
      });
    } catch {
      setFormError(MESSAGES.unavailable);
      return;
    }
    if (response.ok) {
      // Every session was revoked; sign in with the new password. replace:
      // the token page should not stay in this tab's history.
      window.location.replace("/login?reset=1");
      return;
    }
    const body: unknown = await response.json().catch(() => null);
    const outcome = resetPasswordOutcome(response.status, errorCodeOf(body));
    if (outcome.kind === "expired") {
      setExpired(true);
      return;
    }
    if (outcome.kind === "field") {
      setError(
        "newPassword",
        { message: outcome.message },
        { shouldFocus: true },
      );
      return;
    }
    if (outcome.kind === "form" || outcome.kind === "signed-out") {
      setFormError(outcome.message);
    }
  }

  if (expired) {
    // Focus moves to the new view, so keyboard and screen-reader users hear
    // what happened instead of losing their place on a vanished form.
    return (
      <div
        ref={(node) => node?.focus()}
        tabIndex={-1}
        className="flex flex-1 flex-col outline-none"
      >
        {expiredView}
      </div>
    );
  }

  return (
    <AccountFrame title={copy.title} intro={copy.intro}>
      {/* method="post": a submit before hydration never puts the password
          in the URL (ADR 0029). */}
      <form
        method="post"
        onSubmit={handleSubmit(onSubmit)}
        noValidate
        className="mt-10 space-y-5"
      >
        <FormField
          id="new-password"
          label={invite ? "Password" : "New password"}
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. A short sentence is easy to remember.`}
          error={errors.newPassword?.message}
          inputProps={{
            type: "password",
            autoComplete: "new-password",
            ...register("newPassword"),
          }}
        />
        <FormField
          id="confirm-password"
          label={invite ? "Repeat password" : "Repeat new password"}
          error={errors.confirmPassword?.message}
          inputProps={{
            type: "password",
            autoComplete: "new-password",
            ...register("confirmPassword"),
          }}
        />

        <FormAlert>{formError}</FormAlert>

        <button type="submit" disabled={isSubmitting} className={primaryButton}>
          {isSubmitting ? copy.busy : copy.submit}
        </button>
      </form>
    </AccountFrame>
  );
}
