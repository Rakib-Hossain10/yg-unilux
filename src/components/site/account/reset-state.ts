// What /reset-password shows, from its query (ADR 0068): the password form
// for a well-formed `token` (with "Set your password" wording when
// `invite=1`), or the neutral expired view for `error=…` (Better Auth's
// INVALID_TOKEN redirect), a missing or malformed token. Pure, so the rule is
// unit-tested; Better Auth still decides whether a token is valid.

import { singleParam } from "@/lib/account-destination";

/*
 * Better Auth's reset tokens are 24 alphanumerics; our invite tokens are 32
 * random bytes in base64url (43 characters). Anything outside base64url or
 * these lengths can't be a token we issued, so it gets the expired view
 * without a round trip.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export type ResetPageState =
  | { view: "form"; token: string; invite: boolean }
  | { view: "expired"; invite: boolean };

export type ResetSearchParams = Record<string, string | string[] | undefined>;

export function resetPageState(params: ResetSearchParams): ResetPageState {
  const invite = singleParam(params.invite) === "1";
  if (params.error !== undefined) return { view: "expired", invite };
  const token = singleParam(params.token);
  if (token === undefined || !TOKEN_PATTERN.test(token)) {
    return { view: "expired", invite };
  }
  return { view: "form", token, invite };
}

/** Copy for the two flows that share the page. */
export function resetCopy(invite: boolean): {
  title: string;
  intro: string;
  submit: string;
  busy: string;
} {
  return invite
    ? {
        title: "Set your password",
        intro:
          "Choose a password for your YG UniLUX account. You will use it with your email address to sign in.",
        submit: "Set password",
        busy: "Setting password…",
      }
    : {
        title: "Choose a new password",
        intro:
          "Your new password replaces the old one and signs you out everywhere.",
        submit: "Save new password",
        busy: "Saving…",
      };
}
