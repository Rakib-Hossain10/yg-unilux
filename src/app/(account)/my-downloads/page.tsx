// /my-downloads (plan Q8): the signed-in user's datasheet access and their own
// download history, newest first, 20 per page, with Change password and Sign
// out. Customers and the admin (their own history) may open it. Rendered per
// request; the guard runs first, with no loading.tsx around it. The history
// comes from src/lib/download-history.ts for the session's own user id only.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  type AccessStatus,
  accessStatus,
  formatDay,
} from "@/components/site/account/access-status";
import {
  secondaryButton,
  textLink,
} from "@/components/site/account/account-ui";
import { DownloadHistory } from "@/components/site/account/download-history";
import { SignOutButton } from "@/components/site/account/sign-out-button";
import {
  CHANGE_PASSWORD_PAGE,
  MY_DOWNLOADS_PAGE,
  changePasswordPathFor,
  singleParam,
} from "@/lib/account-destination";
import { getDownloadHistory, historyPageSchema } from "@/lib/download-history";
import { needsPasswordChange, requireSignedIn } from "@/lib/permissions";

export const metadata: Metadata = {
  title: "My downloads",
  robots: { index: false, follow: false },
};

/* Renewal goes through the request form (plan Q6), which arrives in P6. */
const RENEW_PATH = "/request-access?renew=1";

function AccessLine({ status }: { status: AccessStatus }) {
  const renew = (
    <Link href={RENEW_PATH} prefetch={false} className={textLink}>
      Renew access
    </Link>
  );
  switch (status.kind) {
    case "admin":
      return (
        <>
          <p className="font-display text-3xl font-light md:text-4xl">
            Full access
          </p>
          <p className="mt-2 text-sm text-grey-600">
            As the site administrator you can download every datasheet.
          </p>
        </>
      );
    case "active":
      return (
        <>
          <p className="font-display text-3xl font-light md:text-4xl">
            Active until{" "}
            <time dateTime={status.until.toISOString()}>
              {formatDay(status.until)}
            </time>
          </p>
          <p className="mt-2 text-sm text-grey-600">
            You can download the datasheet on any product page. We will email
            you a week before access ends.
          </p>
        </>
      );
    case "open":
      return (
        <>
          <p className="font-display text-3xl font-light md:text-4xl">
            Active, with no end date
          </p>
          <p className="mt-2 text-sm text-grey-600">
            You can download the datasheet on any product page.
          </p>
        </>
      );
    case "expired":
      return (
        <>
          <p className="font-display text-3xl font-light md:text-4xl">
            {status.since ? (
              <>
                Ended on{" "}
                <time dateTime={status.since.toISOString()}>
                  {formatDay(status.since)}
                </time>
              </>
            ) : (
              "Access has ended"
            )}
          </p>
          <p className="mt-2 text-sm text-grey-600">
            Your history stays here. Ask us to renew your access to download
            datasheets again.
          </p>
          <p className="mt-1">{renew}</p>
        </>
      );
    case "paused":
      return (
        <>
          <p className="font-display text-3xl font-light md:text-4xl">
            Access paused
          </p>
          <p className="mt-2 text-sm text-grey-600">
            Downloads are switched off for this account. Please contact us.
          </p>
        </>
      );
    case "password":
    case "none":
      return (
        <>
          <p className="font-display text-3xl font-light md:text-4xl">
            No datasheet access
          </p>
          <p className="mt-2 text-sm text-grey-600">
            This account cannot download datasheets.
          </p>
        </>
      );
  }
}

export default async function MyDownloadsPage({
  searchParams,
}: PageProps<"/my-downloads">) {
  const viewer = await requireSignedIn(MY_DOWNLOADS_PAGE);
  // A temporary password unlocks nothing: change it first, then come back.
  if (needsPasswordChange(viewer.user)) {
    redirect(changePasswordPathFor(MY_DOWNLOADS_PAGE));
  }
  const params = await searchParams;
  const requested = historyPageSchema.parse(singleParam(params.page));
  const status = accessStatus(viewer.user, new Date());
  const history = await getDownloadHistory(viewer.user.id, requested);
  const canDownload =
    status.kind === "admin" ||
    status.kind === "active" ||
    status.kind === "open";

  return (
    <div className="mx-auto w-full max-w-(--container-site) px-4 py-14 md:px-8 md:py-20">
      <header className="flex flex-col gap-8 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="font-display text-4xl font-light md:text-5xl">
            My downloads
          </h1>
          <p className="mt-3 text-sm break-all text-grey-600">
            Signed in as {viewer.user.email}
          </p>
        </div>
        <div className="grid gap-3 min-[400px]:grid-cols-2 md:flex md:items-start">
          {/* Plain <a>: a full page load, like every move between account
              pages (ADR 0027). */}
          <a href={CHANGE_PASSWORD_PAGE} className={secondaryButton}>
            Change password
          </a>
          <SignOutButton />
        </div>
      </header>

      <section
        aria-labelledby="access-heading"
        className="mt-12 border-y border-grey-200 py-8 md:mt-16 md:py-10"
      >
        <h2
          id="access-heading"
          className="mb-3 text-xs tracking-[0.14em] text-grey-600 uppercase"
        >
          Datasheet access
        </h2>
        <AccessLine status={status} />
      </section>

      <DownloadHistory history={history} canDownload={canDownload} />
    </div>
  );
}
