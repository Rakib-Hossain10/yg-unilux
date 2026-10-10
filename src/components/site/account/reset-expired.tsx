// The neutral "link has expired" view of /reset-password (ADR 0068): shown for
// an expired, used, unknown or malformed reset or invite link. It never says
// whether an account exists. Ways on: WhatsApp (when a number is set in the
// admin settings), the request-access form, and for resets a new link.

import Link from "next/link";

import {
  AccountFrame,
  primaryButton,
  secondaryButton,
  textLink,
} from "./account-ui";

/*
 * rel=noreferrer on every way on: this page's URL may hold a token.
 * A reset link (no invite): the user already has an account, so a new reset
 * link is the main way on and "Request access" the quiet one. An invite: no
 * password was ever set, so asking us (WhatsApp, the form) comes first.
 */
export function ResetExpired({
  whatsappHref,
  invite,
}: {
  /** https://wa.me/<digits>, or null to hide the WhatsApp link. */
  whatsappHref: string | null;
  invite: boolean;
}) {
  const whatsapp = whatsappHref ? (
    <a
      href={whatsappHref}
      target="_blank"
      rel="noopener noreferrer"
      className={secondaryButton}
    >
      Message us on WhatsApp
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  ) : null;

  if (!invite) {
    return (
      <AccountFrame
        title="This link has expired"
        intro="Links to set a password work for a limited time and only once. Send yourself a new one."
      >
        <div className="mt-10 flex flex-col items-stretch gap-3">
          <a href="/forgot-password" rel="noreferrer" className={primaryButton}>
            Send me a new reset link
          </a>
          {whatsapp}
        </div>
        <p className="mt-6 text-center text-sm">
          <Link
            href="/request-access"
            prefetch={false}
            rel="noreferrer"
            className={textLink}
          >
            Request access
          </Link>
        </p>
      </AccountFrame>
    );
  }

  return (
    <AccountFrame
      title="This link has expired"
      intro="Links to set a password work for a limited time and only once. Ask us for a new one."
    >
      <div className="mt-10 flex flex-col items-stretch gap-3">
        {whatsapp}
        <Link
          href="/request-access"
          prefetch={false}
          rel="noreferrer"
          className={secondaryButton}
        >
          Request access
        </Link>
      </div>
    </AccountFrame>
  );
}
