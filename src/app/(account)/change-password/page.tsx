// /change-password: any signed-in user changes their password here. A user on
// a temporary password (mustChangePassword) is sent here by /login and by
// requireAdmin(), and sees the "choose your own password" wording; their
// datasheet access stays locked until it is done (permissions.ts). The form
// posts to Better Auth's /api/auth/change-password (ADR 0068). Rendered per
// request; the guard runs before anything else, with no loading.tsx around it.

import type { Metadata } from "next";

import { AccountFrame, textLink } from "@/components/site/account/account-ui";
import { ChangePasswordForm } from "@/components/site/account/change-password-form";
import { SignOutTextButton } from "@/components/site/account/sign-out-button";
import {
  ADMIN_HOME,
  MY_DOWNLOADS_PAGE,
  destinationAfterPasswordChange,
  singleParam,
} from "@/lib/account-destination";
import { hasRole } from "@/lib/auth";
import { needsPasswordChange, requireSignedIn } from "@/lib/permissions";

export const metadata: Metadata = {
  title: "Change password",
  robots: { index: false, follow: false },
};

export default async function ChangePasswordPage({
  searchParams,
}: PageProps<"/change-password">) {
  // Signed out → /login (rule 3 style: on the server, before rendering).
  const viewer = await requireSignedIn();
  const params = await searchParams;
  const forced = needsPasswordChange(viewer.user);
  // `next` is checked again by the rule (same-origin, not an auth page).
  const destination = destinationAfterPasswordChange(
    viewer.user,
    singleParam(params.next),
  );
  const home = hasRole(viewer.user, "admin") ? ADMIN_HOME : MY_DOWNLOADS_PAGE;

  return (
    <AccountFrame
      title={forced ? "Choose your own password" : "Change password"}
      intro={
        forced
          ? "You signed in with a temporary password. Choose your own to continue."
          : "Changing your password signs you out on every other device."
      }
    >
      <ChangePasswordForm
        destination={destination}
        submitLabel={forced ? "Save and continue" : "Change password"}
      />
      {forced ? (
        // A way out for someone who signed in on the wrong account or does
        // not want to choose a password now (full page load, ADR 0027).
        <SignOutTextButton className="mt-6 text-center text-sm" />
      ) : (
        <p className="mt-6 text-center text-sm">
          {/* Plain <a>: the admin home is its own document (CSP, ADR 0027). */}
          <a href={home} className={textLink}>
            {home === ADMIN_HOME
              ? "Back to the admin panel"
              : "Back to my downloads"}
          </a>
        </p>
      )}
    </AccountFrame>
  );
}
