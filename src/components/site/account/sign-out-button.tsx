"use client";

// Signs the current user out through Better Auth's /api/auth/sign-out (which
// deletes the session in the database), then a full page load to the home
// page (ADR 0027: no client-side move across documents). Leaves the page only
// once the server confirms, so nobody walks away from a shared computer
// believing they are signed out when they are not (same rule as the admin's
// button, src/components/admin/sign-out-button.tsx).

import { useState } from "react";

import { secondaryButton } from "./account-ui";

export function SignOutButton({ className = "" }: { className?: string }) {
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
      {/* Always in the DOM (empty = no height), so its text is announced. */}
      <p role="alert" className="text-sm text-danger [&:not(:empty)]:mt-2">
        {failed ? "Sign-out failed. Please try again." : null}
      </p>
    </div>
  );
}
