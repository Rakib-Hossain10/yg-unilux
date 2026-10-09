// /login: sign-in for the admin and approved customers. There is no sign-up
// (accounts are created by the admin, rule 4). The form posts straight to
// Better Auth's /api/auth route, never through a Server Action (QA L3, task 5).
// A visitor who is already signed in is sent straight on by the same rule as
// after sign-in (plan Q7). Rendered per request: it reads the session.

import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AccountFrame } from "@/components/site/account/account-ui";
import { LoginForm } from "@/components/site/login-form";
import {
  accountNextPath,
  destinationAfterSignIn,
  singleParam,
} from "@/lib/account-destination";
import { logAuthProblem } from "@/lib/auth";
import { getViewer, type Viewer } from "@/lib/permissions";
import { hasSessionCookie } from "@/lib/session-cookie";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

/*
 * The signed-in viewer, or null. Visitors without a session cookie cost no
 * database read. A failed read shows the form instead of an error page:
 * signing in again is harmless, and the redirect below stays outside any
 * try/catch.
 */
async function currentViewer(): Promise<Viewer | null> {
  if (!hasSessionCookie(await headers())) return null;
  try {
    return await getViewer();
  } catch (error) {
    logAuthProblem("session not read on /login", error);
    return null;
  }
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = accountNextPath(singleParam(params.next));
  const viewer = await currentViewer();
  // A server redirect inside a full page load (the header's Account link is a
  // plain <a>), so /admin arrives as its own document with its own CSP.
  if (viewer) redirect(destinationAfterSignIn(viewer.user, next));

  const passwordChanged = singleParam(params.reset) === "1";

  return (
    <AccountFrame
      title="Sign in"
      intro="For customers with datasheet access and the site administrator."
    >
      {passwordChanged ? (
        <p
          role="status"
          className="mt-8 border-l-2 border-ink bg-grey-50 px-4 py-3 text-sm"
        >
          Password changed. Sign in with your new password.
        </p>
      ) : null}
      <LoginForm next={next} />
    </AccountFrame>
  );
}
