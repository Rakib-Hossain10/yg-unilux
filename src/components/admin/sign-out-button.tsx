"use client";

// Signs the current user out through Better Auth's /api/auth/sign-out (which
// deletes the session in the database) and returns to the home page.
// Styled with the shadcn Button and design tokens (ADR 0034).

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

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
        <p role="alert" className="text-sm text-destructive">
          Sign-out failed. Please try again.
        </p>
      ) : null}
      <Button type="button" variant="outline" onClick={signOut} disabled={busy}>
        {busy ? "Signing out…" : "Sign out"}
      </Button>
    </div>
  );
}
