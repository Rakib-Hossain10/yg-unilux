"use client";

// Signs the current user out through Better Auth's /api/auth/sign-out (which
// deletes the session in the database) and returns to the home page.

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  /*
   * Leaves the page only when the server confirms the session is gone. On a
   * failure the admin stays here with an error, so nobody walks away from a
   * shared computer believing they are signed out.
   */
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
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      {failed ? (
        <p role="alert" className="text-sm text-red-700">
          Sign-out failed. Please try again.
        </p>
      ) : null}
      <button
        type="button"
        onClick={signOut}
        disabled={busy}
        className="h-9 border border-grey-300 px-4 text-xs tracking-[0.14em] uppercase transition-colors duration-(--duration-quick) hover:border-ink disabled:opacity-60"
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
