// /forgot-password: asks for an email and sends a reset link through Better
// Auth (rate-limited per email and per network, ADR 0020/0022). The answer is
// the same whether or not the address has an account. The admin uses this
// page too. Holds nothing per visitor, so it is a static page.

import type { Metadata } from "next";

import { AccountFrame } from "@/components/site/account/account-ui";
import { ForgotPasswordForm } from "@/components/site/account/forgot-password-form";

export const metadata: Metadata = {
  title: "Forgot your password",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <AccountFrame
      title="Forgot your password?"
      intro="Enter the email address you sign in with. We will send you a link to choose a new password."
    >
      <ForgotPasswordForm />
    </AccountFrame>
  );
}
