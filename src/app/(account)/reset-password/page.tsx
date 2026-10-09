// /reset-password: where reset emails and invite links land (ADR 0068).
// ?token=<t> shows the password form ("Set your password" when ?invite=1);
// ?error=INVALID_TOKEN (Better Auth's redirect for a dead link) or a missing
// or malformed token shows the neutral expired view. Better Auth decides
// whether a token is valid when the form posts; a dead one gives the same
// expired view. Rendered per request (it reads the query).
//
// The URL holds a live token, so this page sends no Referer anywhere
// (meta referrer no-referrer, plus rel=noreferrer on its links) and the token
// is never logged.

import type { Metadata } from "next";

import { ResetExpired } from "@/components/site/account/reset-expired";
import { ResetPasswordForm } from "@/components/site/account/reset-password-form";
import { resetPageState } from "@/components/site/account/reset-state";
import { getWhatsappNumber, whatsappLink } from "@/lib/contact-settings";

export const metadata: Metadata = {
  title: "Choose a password",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ResetPasswordPage({
  searchParams,
}: PageProps<"/reset-password">) {
  const state = resetPageState(await searchParams);
  const digits = await getWhatsappNumber();
  const expiredView = (
    <ResetExpired
      whatsappHref={digits ? whatsappLink(digits) : null}
      invite={state.invite}
    />
  );

  if (state.view === "expired") return expiredView;
  return (
    <ResetPasswordForm
      token={state.token}
      invite={state.invite}
      expiredView={expiredView}
    />
  );
}
