// What an admin Server Action hands back to its client form when it does not
// redirect, and callAction(), which turns a thrown failure (network, server
// crash) into the same shape while letting Next's redirects through.

import { unstable_rethrow } from "next/navigation";

import type { ServiceErrors } from "@/lib/admin/write-result";

export type { ServiceErrors };

/*
 * `saved` on a failure:
 * - false: nothing was written; the admin can fix the input and retry;
 * - true: the write happened but a later step failed (the audit entry, ADR
 *   0035 point 5);
 * - "unknown": the action threw, so it may or may not have been written.
 * Unless it is false, the form must not offer to submit the same values
 * again, or a create could make a second copy. Cache tags stay on the server.
 */
export interface ActionFailure {
  ok: false;
  errors: ServiceErrors;
  saved: boolean | "unknown";
}
export type ActionResult = { ok: true } | ActionFailure;

/**
 * An action that hands data back on success, e.g. a signed upload. Failures
 * have the same shape as ActionResult's.
 */
export type ActionData<T> = { ok: true; data: T } | ActionFailure;

/** Shown when the action threw instead of answering. */
export const ACTION_FAILED_MESSAGE =
  "Something went wrong, so the change may or may not have been saved. Reload the page to check, then try again.";

/**
 * Calls a Server Action from a client event. When the action redirects, the
 * client rejects with Next's redirect error; unstable_rethrow passes that
 * (and a 403 or 404) on, so the router still navigates. Run it inside
 * startTransition so those errors reach Next's boundaries. Anything else
 * (offline, a server error) becomes an error result the screen can show.
 * `undefined` is kept for an action that ends without a value, so callers
 * treat "no result" as "nothing to show" rather than crashing.
 */
export async function callAction<R extends ActionResult | ActionData<unknown>>(
  action: () => Promise<R>,
): Promise<R | ActionFailure | undefined> {
  try {
    return await action();
  } catch (error) {
    unstable_rethrow(error);
    return {
      ok: false,
      errors: { formErrors: [ACTION_FAILED_MESSAGE], fieldErrors: {} },
      saved: "unknown",
    };
  }
}

/**
 * Every message in the errors, form-level first and without repeats, for
 * places that have no inputs to attach field errors to (the tree's buttons).
 */
export function allMessages(errors: ServiceErrors): string[] {
  return [
    ...new Set([
      ...errors.formErrors,
      ...Object.values(errors.fieldErrors).flat(),
    ]),
  ];
}
