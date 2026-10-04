"use client";

// The sign-in form: React Hook Form + Zod in the browser for quick feedback,
// then a JSON POST to Better Auth's /api/auth/sign-in/email, where the real
// checks run (Zod again in our hook, rate limits, argon2id — ADR 0022/0023).

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

/* The same limits the server applies (email 254, password 12–128). */
const loginSchema = z.object({
  email: z.email("Enter a valid email address.").max(254),
  password: z
    .string()
    .min(1, "Enter your password.")
    .max(128, "Passwords are at most 128 characters."),
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

/* Where to go after signing in. Customer pages arrive in Phase 5. */
function destinationFor(role: unknown): string {
  const roles = typeof role === "string" ? role.split(",") : [];
  return roles.map((r) => r.trim()).includes("admin") ? "/admin" : "/";
}

const field =
  "mt-1.5 block h-11 w-full border border-grey-300 bg-paper px-3 text-sm outline-offset-0 transition-colors duration-(--duration-quick) focus:border-ink aria-invalid:border-red-700";

export function LoginForm() {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({ resolver: zodResolver(loginSchema) });

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
          rememberMe: true,
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
    const role =
      typeof body === "object" && body !== null && "user" in body
        ? (body.user as { role?: unknown } | null)?.role
        : undefined;
    // replace + refresh: the session cookie is new, so server components
    // must render again for the signed-in user.
    router.replace(destinationFor(role));
    router.refresh();
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
      <div>
        <label htmlFor="email" className="text-xs tracking-[0.14em] uppercase">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={errors.email ? "email-error" : undefined}
          className={field}
          {...register("email")}
        />
        {errors.email ? (
          <p id="email-error" className="mt-1.5 text-sm text-red-700">
            {errors.email.message}
          </p>
        ) : null}
      </div>

      <div>
        <label
          htmlFor="password"
          className="text-xs tracking-[0.14em] uppercase"
        >
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={errors.password ? true : undefined}
          aria-describedby={errors.password ? "password-error" : undefined}
          className={field}
          {...register("password")}
        />
        {errors.password ? (
          <p id="password-error" className="mt-1.5 text-sm text-red-700">
            {errors.password.message}
          </p>
        ) : null}
      </div>

      {/* Announced to screen readers when it appears. */}
      <p role="alert" className="min-h-5 text-sm text-red-700">
        {formError}
      </p>

      <button
        type="submit"
        disabled={isSubmitting}
        className="h-11 w-full bg-ink text-xs tracking-[0.16em] text-paper uppercase transition-opacity duration-(--duration-quick) hover:opacity-90 disabled:opacity-60"
      >
        {isSubmitting ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
