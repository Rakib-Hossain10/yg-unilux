// The on-page write runner shared by the categories tree and the areas list
// (move up/down, delete): one request at a time, errors and a status line for
// screen readers, and no stale "saved" notice afterwards (gate A, L-4, L-5).

import { useRef, useState, useTransition } from "react";

import { allMessages, callAction, type ActionResult } from "./action-result";
import { useClearNotice } from "./clear-notice";

export interface SerialAction {
  pending: boolean;
  /** Messages from the last failed request, for an alert above the list. */
  errors: string[];
  /** What the last successful request did, for a polite status region. */
  status: string;
  /** Runs `action` unless one is already running; `done` is announced. */
  run: (action: () => Promise<ActionResult>, done?: string) => void;
}

export function useSerialAction(): SerialAction {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  /*
   * Set synchronously when a request starts: `pending` only turns true on a
   * later render, so two fast clicks would otherwise both pass the check and
   * send two moves (L-5). Cleared when the request settles, also when it ends
   * in a redirect (the list stays mounted on its own ?notice= URL).
   */
  const inFlight = useRef(false);
  const clearNotice = useClearNotice();

  /*
   * A delete that succeeds redirects with its own notice, so nothing comes
   * back. When a result does come back, an earlier notice ("Area created.")
   * no longer applies and is cleared from the URL and the page (L-4).
   */
  function run(action: () => Promise<ActionResult>, done?: string) {
    if (inFlight.current || pending) return;
    inFlight.current = true;
    setErrors([]);
    setStatus("");
    startTransition(async () => {
      try {
        const result = await callAction(action);
        if (!result) return;
        clearNotice();
        if (result.ok) {
          if (done) setStatus(done);
          return;
        }
        setErrors(allMessages(result.errors));
      } finally {
        inFlight.current = false;
      }
    });
  }

  return { pending, errors, status, run };
}
