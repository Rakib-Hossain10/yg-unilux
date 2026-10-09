// The neutral "link has expired" view of /reset-password (ADR 0068): shown for
// an expired, used, unknown or malformed reset or invite link. It never says
// whether an account exists. Ways on: WhatsApp (when a number is set in the
// admin settings), the request-access form, and for resets a new link.

import Link from "next/link";

import { AccountFrame, secondaryButton, textLink } from "./account-ui";

export function ResetExpired({
  whatsappHref,
  invite,
}: {
  /** https://wa.me/<digits>, or null to hide the WhatsApp link. */
  whatsappHref: string | null;
  invite: boolean;
}) {
  return (
    <AccountFrame
      title="This link has expired"
      intro="Links to set a password work for a limited time and only once. Ask us for a new one."
    >
      <div className="mt-10 flex flex-col items-stretch gap-3">
        {whatsappHref ? (
          <a
            href={whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            className={secondaryButton}
          >
            Message us on WhatsApp
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : null}
        {/* /request-access arrives in Phase 5 P6; not prefetched until then.
            rel=noreferrer: this page's URL may hold a token. */}
        <Link
          href="/request-access"
          prefetch={false}
          rel="noreferrer"
          className={secondaryButton}
        >
          Request access
        </Link>
      </div>
      {invite ? null : (
        <p className="mt-6 text-center text-sm">
          <a href="/forgot-password" rel="noreferrer" className={textLink}>
            Send me a new reset link
          </a>
        </p>
      )}
    </AccountFrame>
  );
}
