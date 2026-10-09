"use client";

// The change-password form: React Hook Form + Zod for quick feedback, then a
// JSON POST to Better Auth's /api/auth/change-password (never a Server
// Action, task-5 QA L3). revokeOtherSessions: true ends every other session;
// the server's after-hook clears the temporary-password flag and keeps the
// 24 h cap of a "don't remember" session (ADR 0068). On success: a full page
// load to the destination the server computed (ADR 0027).

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { FormAlert, FormField, primaryButton, textLink } from "./account-ui";
import {
  MAX_PASSWORD_LENGTH,
  MESSAGES,
  MIN_PASSWORD_LENGTH,
  changePasswordOutcome,
  errorCodeOf,
  type FormOutcome,
} from "./auth-messages";

const schema = z
  .object({
    currentPassword: z
      .string()
      .min(1, "Enter your current password.")
      .max(MAX_PASSWORD_LENGTH, MESSAGES.tooLong),
    newPassword: z
      .string()
      .min(MIN_PASSWORD_LENGTH, MESSAGES.tooShort)
      .max(MAX_PASSWORD_LENGTH, MESSAGES.tooLong),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ["newPassword"],
    message: "Choose a password different from your current one.",
  })
  .refine((v) => v.confirmPassword === v.newPassword, {
    path: ["confirmPassword"],
    message: "The two passwords don't match.",
  });
type Values = z.infer<typeof schema>;

export function ChangePasswordForm({
  destination,
  submitLabel,
}: {
  /** Where to go afterwards (destinationAfterPasswordChange, on the server). */
  destination: string;
  submitLabel: string;
}) {
  const [problem, setProblem] = useState<FormOutcome | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    },
  });

  async function onSubmit(values: Values) {
    setProblem(null);
    let response: Response;
    try {
      response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
          revokeOtherSessions: true,
        }),
        credentials: "same-origin",
      });
    } catch {
      setProblem({ kind: "form", message: MESSAGES.unavailable });
      return;
    }
    if (response.ok) {
      // Full page load: the new session cookie is in place, and an admin
      // must reach /admin as its own document (CSP, ADR 0027).
      window.location.assign(destination);
      return;
    }
    const body: unknown = await response.json().catch(() => null);
    const outcome = changePasswordOutcome(response.status, errorCodeOf(body));
    if (outcome.kind === "field") {
      setError(
        outcome.field,
        { message: outcome.message },
        { shouldFocus: true },
      );
      return;
    }
    setProblem(outcome);
  }

  return (
    // method="post": a submit before hydration must never become a GET with
    // the passwords in the URL (ADR 0029).
    <form
      method="post"
      onSubmit={handleSubmit(onSubmit)}
      noValidate
      className="mt-10 space-y-5"
    >
      <FormField
        id="current-password"
        label="Current password"
        error={errors.currentPassword?.message}
        inputProps={{
          type: "password",
          autoComplete: "current-password",
          ...register("currentPassword"),
        }}
      />
      <FormField
        id="new-password"
        label="New password"
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
        label="Repeat new password"
        error={errors.confirmPassword?.message}
        inputProps={{
          type: "password",
          autoComplete: "new-password",
          ...register("confirmPassword"),
        }}
      />

      <FormAlert>
        {problem?.kind === "form" ? problem.message : null}
        {problem?.kind === "signed-out" ? (
          <>
            {problem.message}{" "}
            <a href="/login" className={textLink}>
              Sign in
            </a>
          </>
        ) : null}
      </FormAlert>

      <button type="submit" disabled={isSubmitting} className={primaryButton}>
        {isSubmitting ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
