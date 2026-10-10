"use client";

// The sign-in form: React Hook Form + Zod in the browser for quick feedback,
// then a JSON POST to Better Auth's /api/auth/sign-in/email, where the real
// checks run (Zod again in our hook, rate limits, argon2id — ADR 0022/0023).
// Afterwards the shared destination rule (plan Q7) picks the next page.

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { destinationAfterSignIn } from "@/lib/account-destination";

import {
  FormActions,
  FormField,
  primaryButton,
  textLink,
} from "./account/account-ui";

/* The same limits as the server's sign-in schema (email 254, password 1–128). */
const loginSchema = z.object({
  email: z.email("Enter a valid email address.").max(254),
  password: z
    .string()
    .min(1, "Enter your password.")
    .max(128, "Passwords are at most 128 characters."),
  // Off by default for every role (user decision 2026-10-05).
  rememberMe: z.boolean(),
});
type LoginValues = z.infer<typeof loginSchema>;

/*
 * One message per answer class. None says whether the email exists: a wrong
 * email and a wrong password both get the 401 text.
 */
function messageFor(status: number): string {
  switch (status) {
    case 401:
    case 400:
      return "Email or password is incorrect.";
    case 403:
      return "This account is disabled. Please contact us for help.";
    case 429:
      return "Too many attempts. Please wait a few minutes and try again.";
    default:
      return "Sign-in is temporarily unavailable. Please try again later.";
  }
}

/* The fields of the returned user that the destination rule reads. */
function signedInUser(body: unknown): {
  role?: unknown;
  mustChangePassword?: unknown;
} {
  if (typeof body !== "object" || body === null || !("user" in body)) {
    return {};
  }
  const user = (body as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) return {};
  const { role, mustChangePassword } = user as Record<string, unknown>;
  return { role, mustChangePassword };
}

export function LoginForm({ next }: { next: string | null }) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "", rememberMe: false },
  });

  async function onSubmit(values: LoginValues) {
    setFormError(null);
    let response: Response;
    try {
      response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: values.email,
          password: values.password,
          // false: a browser-session cookie, and Better Auth ends the
          // session after 24 hours without refreshing it. true: 7 days.
          rememberMe: values.rememberMe,
        }),
        credentials: "same-origin",
      });
    } catch {
      setFormError(messageFor(0));
      return;
    }
    if (!response.ok) {
      setFormError(messageFor(response.status));
      return;
    }
    const body: unknown = await response.json().catch(() => null);
    // A full page load, not router.replace: CSP is fixed per document, so a
    // client-side move would keep /login's connect-src 'self' and the admin
    // panel's direct uploads would be blocked (ADR 0045). The load also
    // renders everything again for the new session cookie. The rule checks
    // `next` again (same-origin, not an auth page) and fails closed: a
    // missing mustChangePassword goes to /change-password.
    window.location.assign(destinationAfterSignIn(signedInUser(body), next));
  }

  return (
    // method="post": a submit before hydration (or without JavaScript) must
    // never fall back to GET, which would put the password in the URL,
    // history and access logs. handleSubmit prevents the native submit once
    // the page is hydrated.
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

      <div>
        <FormField
          id="password"
          label="Password"
          error={errors.password?.message}
          inputProps={{
            type: "password",
            autoComplete: "current-password",
            ...register("password"),
          }}
        />
        {/* One row under the password: the choice that belongs to this
            sign-in on the left, the way out on the right (wraps at 320 px). */}
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-6">
          <label
            htmlFor="remember-me"
            className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm"
          >
            <input
              id="remember-me"
              type="checkbox"
              className="size-4 cursor-pointer accent-ink"
              {...register("rememberMe")}
            />
            Keep me signed in
          </label>
          <a href="/forgot-password" className={`${textLink} text-sm`}>
            Forgot your password?
          </a>
        </div>
      </div>

      {/* The message line is announced to screen readers when it appears. */}
      <FormActions alert={formError}>
        <button type="submit" disabled={isSubmitting} className={primaryButton}>
          {isSubmitting ? "Signing in…" : "Sign in"}
        </button>
      </FormActions>
    </form>
  );
}
