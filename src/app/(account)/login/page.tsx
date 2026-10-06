// /login: sign-in for the admin and approved customers. There is no sign-up
// (accounts are created by the admin, rule 4). The form posts straight to
// Better Auth's /api/auth route, never through a Server Action (QA L3, task 5).

import type { Metadata } from "next";

import { LoginForm } from "@/components/site/login-form";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <section className="flex flex-1 items-center justify-center px-4 py-20">
      <div className="w-full max-w-sm">
        <h1 className="text-center font-display text-4xl font-light">
          Sign in
        </h1>
        <p className="mt-3 text-center text-sm text-grey-600">
          For customers with datasheet access and the site administrator.
        </p>
        <LoginForm />
      </div>
    </section>
  );
}
