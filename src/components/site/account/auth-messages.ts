// What the account forms say for each answer from /api/auth/* (ADR 0029 style:
// one fixed message per answer class, none reveals whether an email has an
// account). Pure, so every mapping is unit-tested.

/** At least this many characters (Better Auth `minPasswordLength`). */
export const MIN_PASSWORD_LENGTH = 12;
/** Better Auth's default `maxPasswordLength`. */
export const MAX_PASSWORD_LENGTH = 128;

export const MESSAGES = {
  tooShort: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  tooLong: `Passwords are at most ${MAX_PASSWORD_LENGTH} characters.`,
  wrongCurrent: "Your current password is incorrect.",
  // One text for every 429: the per-network and per-user limits (ADR 0031)
  // answer with the same body, so the form can't (and needn't) tell them apart.
  tooMany:
    "Too many attempts. For your security, please wait 15 minutes and try again.",
  signedOut: "Your session has ended. Sign in again to continue.",
  unavailable: "This is temporarily unavailable. Please try again later.",
  invalidEmail: "Enter a valid email address.",
  resetSent:
    "If an account uses that address, we have sent it a link to choose a new password. The link works for one hour.",
} as const;

/** Better Auth's error `code` from a JSON body, or null. */
export function errorCodeOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : null;
}

export type FormOutcome =
  | { kind: "field"; field: "currentPassword" | "newPassword"; message: string }
  | { kind: "form"; message: string }
  | { kind: "signed-out"; message: string }
  | { kind: "expired" };

/* The new-password answers shared by change and reset. */
function newPasswordProblem(code: string | null): FormOutcome | null {
  if (code === "PASSWORD_TOO_SHORT") {
    return { kind: "field", field: "newPassword", message: MESSAGES.tooShort };
  }
  if (code === "PASSWORD_TOO_LONG") {
    return { kind: "field", field: "newPassword", message: MESSAGES.tooLong };
  }
  return null;
}

/** A failed POST /api/auth/change-password. */
export function changePasswordOutcome(
  status: number,
  code: string | null,
): FormOutcome {
  if (status === 429) return { kind: "form", message: MESSAGES.tooMany };
  if (status === 401)
    return { kind: "signed-out", message: MESSAGES.signedOut };
  if (status === 400) {
    if (code === "INVALID_PASSWORD") {
      return {
        kind: "field",
        field: "currentPassword",
        message: MESSAGES.wrongCurrent,
      };
    }
    const problem = newPasswordProblem(code);
    if (problem) return problem;
  }
  return { kind: "form", message: MESSAGES.unavailable };
}

/**
 * A failed POST /api/auth/reset-password. An expired, used or unknown token
 * is one answer (400 INVALID_TOKEN, ADR 0068) and shows the expired view.
 */
export function resetPasswordOutcome(
  status: number,
  code: string | null,
): FormOutcome {
  if (status === 429) return { kind: "form", message: MESSAGES.tooMany };
  if (status === 400) {
    if (code === "INVALID_TOKEN" || code === "USER_NOT_FOUND") {
      return { kind: "expired" };
    }
    const problem = newPasswordProblem(code);
    if (problem) return problem;
  }
  return { kind: "form", message: MESSAGES.unavailable };
}

/**
 * POST /api/auth/request-password-reset. Every non-error answer, for a known
 * or unknown email alike, is the same neutral confirmation.
 */
export function forgotPasswordOutcome(
  status: number,
): { kind: "sent" } | { kind: "form"; message: string } {
  if (status >= 200 && status < 300) return { kind: "sent" };
  if (status === 429) return { kind: "form", message: MESSAGES.tooMany };
  // Only a malformed address gets a 400 (our hook's Zod check), never an
  // unknown one.
  if (status === 400) return { kind: "form", message: MESSAGES.invalidEmail };
  return { kind: "form", message: MESSAGES.unavailable };
}
