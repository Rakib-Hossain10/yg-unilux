"use server";

// The /request-access Server Action (Phase 5 P6, ADR 0069). It reads the
// posted FormData into the plain shape (no other rules), takes the signed-in
// viewer from the DATABASE session (never from the form) and hands both to
// submitAccessRequest, which owns anti-spam, limits, Zod and storage. Works
// without JavaScript (a plain POST) and with useActionState. Never logs the
// form; no IP limit of its own beyond the service's.

import { headers } from "next/headers";

import {
  refusedState,
  readRequestForm,
  stateForAnswer,
  type RequestFormState,
} from "@/components/site/request-access/request-form";
import {
  ACCESS_REQUEST_THANKS,
  ACCESS_REQUEST_UNAVAILABLE,
  submitAccessRequest,
} from "@/lib/access-requests";
import { logAuthProblem } from "@/lib/auth";
import { getViewer } from "@/lib/permissions";
import { hasSessionCookie } from "@/lib/session-cookie";

/*
 * The viewer the service may link the request to, or null. No session
 * cookie costs no read. A failed read only means "not linked": the request
 * is still stored like a visitor's and gets the same answer.
 */
async function sessionViewer(
  requestHeaders: Awaited<ReturnType<typeof headers>>,
) {
  if (!hasSessionCookie(requestHeaders)) return null;
  try {
    const viewer = await getViewer();
    if (!viewer) return null;
    return {
      userId: viewer.user.id,
      email: viewer.user.email,
      role: viewer.user.role ?? null,
    };
  } catch (error) {
    logAuthProblem("session not read on /request-access", error);
    return null;
  }
}

export async function requestAccessAction(
  _previous: RequestFormState,
  formData: FormData,
): Promise<RequestFormState> {
  const posted = readRequestForm(formData);
  if (!posted) return refusedState();
  const messages = {
    thanks: ACCESS_REQUEST_THANKS,
    unavailable: ACCESS_REQUEST_UNAVAILABLE,
  };
  const requestHeaders = await headers();
  try {
    const answer = await submitAccessRequest(posted, {
      headers: requestHeaders,
      viewer: await sessionViewer(requestHeaders),
    });
    return stateForAnswer(answer, posted, messages);
  } catch (error) {
    // Anything the service did not turn into an answer: our own outage.
    // The error type only, never the form.
    console.error(
      `[request-access] submission failed: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    return stateForAnswer({ ok: false, unavailable: true }, posted, messages);
  }
}
