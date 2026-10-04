"use client";

// Signs the current user out through Better Auth's /api/auth/sign-out (which
// deletes the session in the database) and returns to the home page.

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        credentials: "same-origin",
      });
    } finally {
      // Even if the request failed, leave the admin area; a still-valid
      // session would simply be asked to sign out again.
      router.replace("/");
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="h-9 border border-grey-300 px-4 text-xs tracking-[0.14em] uppercase transition-colors duration-(--duration-quick) hover:border-ink disabled:opacity-60"
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
