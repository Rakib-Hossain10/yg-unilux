"use client";

// Signs the current user out through Better Auth's /api/auth/sign-out (which
// deletes the session in the database), then a full page load to the home
// page (ADR 0027: no client-side move across documents). Leaves the page only
// once the server confirms, so nobody walks away from a shared computer
// believing they are signed out when they are not (same rule as the admin's
// button, src/components/admin/sign-out-button.tsx).

import { useState } from "react";

import { inlineTextLink, secondaryButton } from "./account-ui";

/* The shared sign-out request and its busy / failed state. */
function useSignOut() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setBusy(true);
    setFailed(false);
    let ok = false;
    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        credentials: "same-origin",
      });
      ok = response.ok;
    } catch {
      ok = false;
    }
    if (!ok) {
      setFailed(true);
      setBusy(false);
      return;
    }
    window.location.replace("/");
  }

  return { busy, failed, signOut };
}

/* Always in the DOM (empty = no height), so its text is announced. */
function SignOutAlert({ failed }: { failed: boolean }) {
  return (
    <p role="alert" className="text-sm text-danger [&:not(:empty)]:mt-2">
      {failed ? "Sign-out failed. Please try again." : null}
    </p>
  );
}

/** The full-width outlined button (/my-downloads). */
export function SignOutButton({ className = "" }: { className?: string }) {
  const { busy, failed, signOut } = useSignOut();
  return (
    <div className={className}>
      <button
        type="button"
        onClick={signOut}
        disabled={busy}
        className={`${secondaryButton} w-full`}
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
      <SignOutAlert failed={failed} />
    </div>
  );
}

/**
 * A quiet text-link version, for pages where signing out is a way out rather
 * than the page's purpose (the forced /change-password).
 */
export function SignOutTextButton({ className = "" }: { className?: string }) {
  const { busy, failed, signOut } = useSignOut();
  return (
    <div className={className}>
      <button
        type="button"
        onClick={signOut}
        disabled={busy}
        className={`${inlineTextLink} cursor-pointer disabled:cursor-default disabled:opacity-60 disabled:hover:decoration-grey-400`}
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
      <SignOutAlert failed={failed} />
    </div>
  );
}
