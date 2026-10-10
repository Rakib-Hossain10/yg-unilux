// Better Auth (ADR 0017): email + password only, no sign-up, admin plugin with
// the roles admin/customer, argon2id, reset emails via Resend, and our own
// rate limits and known-device cookie wired in through hooks (ADR 0022).

import "server-only";

import { mongodbAdapter } from "better-auth/adapters/mongodb";
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { nextCookies } from "better-auth/next-js";
import { createAccessControl } from "better-auth/plugins/access";
import { admin } from "better-auth/plugins/admin";
import { defaultStatements } from "better-auth/plugins/admin/access";
import { after } from "next/server";
import { z } from "zod";

import { AuditLogModel } from "@/models/audit-log";

import {
  bumpDeviceEpoch,
  epochOf,
  recordPasswordSet,
  revokePasswordLinks,
} from "./account-writes";
import { connectDb, getDb, getMongoClient } from "./db";
import { DEVICE_COOKIE, issueDeviceToken } from "./device-token";
import {
  EmailSendError,
  PASSWORD_RESET_TOKEN_TTL_SECONDS,
  sendPasswordResetEmail,
} from "./email";
import { EnvError, env } from "./env";
import { hashPassword, verifyPassword } from "./password-hash";
import { AUTH_COOKIE_PREFIX } from "./session-cookie";
import { RateLimitUnavailableError, clearAllForEmail } from "./rate-limit";
import {
  type AuthLimitAudit,
  type SignInPath,
  authLimiterStorage,
  clearSignIn,
  consumePasswordChange,
  consumeResetRequest,
  consumeSignIn,
} from "./sign-in-limit";

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/*
 * Two roles (CLAUDE.md "Roles"). The admin gets Better Auth's admin
 * statements except impersonation, which this site has no use for; a
 * customer gets no admin permission at all.
 * Statements: better-auth/dist/plugins/admin/access/statement.mjs:5.
 */
const accessControl = createAccessControl(defaultStatements);

export const ROLES = {
  admin: accessControl.newRole({
    user: [
      "create",
      "list",
      "set-role",
      "ban",
      "delete",
      "set-password",
      "set-email",
      "get",
      "update",
    ],
    session: ["list", "revoke", "delete"],
  }),
  customer: accessControl.newRole({ user: [], session: [] }),
};

export type RoleName = keyof typeof ROLES;

/**
 * True when the user holds `role`. The admin plugin stores several roles as
 * one comma-joined string ("admin,customer"; better-auth
 * dist/plugins/admin/has-permission.mjs:6 splits on ","), so an exact string
 * comparison would be wrong. Missing role = no role.
 */
export function hasRole(
  user: { role?: string | null } | null | undefined,
  role: RoleName,
): boolean {
  const roles = user?.role;
  if (typeof roles !== "string") return false;
  return roles
    .split(",")
    .map((part) => part.trim())
    .includes(role);
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/*
 * The one body for every rate-limit refusal. It is byte-for-byte the body of
 * Better Auth's own 429 (dist/api/rate-limiter/index.mjs:65), so no refusal
 * tells which limit tripped or whether the account exists.
 */
export const TOO_MANY_REQUESTS_BODY = {
  message: "Too many requests. Please try again later.",
} as const;

const UNAVAILABLE_BODY = {
  message: "Sign-in is temporarily unavailable. Please try again later.",
} as const;

function tooManyRequests(retryAfterSeconds: number): APIError {
  return new APIError(
    "TOO_MANY_REQUESTS",
    { ...TOO_MANY_REQUESTS_BODY },
    { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  );
}

/*
 * Runs a limiter call and turns its failures into generic answers: the
 * database being down is a 503 "try again later" (fail closed, ADR 0020),
 * missing configuration is a 500. Messages never name an account.
 */
async function runLimiter<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof RateLimitUnavailableError) {
      logAuthProblem("rate limiter unavailable", error);
      throw new APIError(
        "SERVICE_UNAVAILABLE",
        { ...UNAVAILABLE_BODY },
        { "Retry-After": "30" },
      );
    }
    if (error instanceof EnvError) {
      logAuthProblem("auth is not configured", error);
      throw new APIError("INTERNAL_SERVER_ERROR", { ...UNAVAILABLE_BODY });
    }
    throw error;
  }
}

/*
 * The only logging in auth code. EnvError and our limiter errors carry safe
 * messages (variable names, operation names); for anything else only the
 * error's type is printed, because driver and provider errors can quote
 * emails, tokens or URLs.
 */
export function logAuthProblem(what: string, error: unknown): void {
  const safe =
    error instanceof EnvError || error instanceof RateLimitUnavailableError
      ? error.message
      : error instanceof Error
        ? error.name
        : "unknown error";
  console.error(`[auth] ${what}: ${safe}`);
}

// ---------------------------------------------------------------------------
// Hook helpers
// ---------------------------------------------------------------------------

/* Same address rule as Better Auth's own sign-in (zod z.email()). */
const emailBody = z.object({ email: z.email().max(254) });

/*
 * Our own validation of the email (rule 8). If it fails we refuse with
 * Better Auth's own "Invalid email" answer, instead of letting the request
 * through unlimited.
 */
function parseEmail(body: unknown): string {
  const parsed = emailBody.safeParse(body);
  if (!parsed.success) {
    throw new APIError("BAD_REQUEST", {
      message: "Invalid email",
      code: "INVALID_EMAIL",
    });
  }
  return parsed.data.email;
}

/*
 * Data handed from a before hook to the matching after hook of the same
 * request. Better Auth merges `{ context: {...} }` returned by a before hook
 * into the endpoint context (dist/api/dispatch.mjs:94-101, 211-220), and
 * after hooks receive that same context (dispatch.mjs:245). It holds no
 * secret beyond what the request itself carried.
 */
const STASH_KEY = "ygAuthGate";

const stashSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sign-in"),
    email: z.string(),
    path: z.enum(["device", "network"]),
    deviceToken: z.string().optional(),
    deviceEpoch: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("reset"),
    userId: z.string(),
    email: z.string(),
  }),
]);
type Stash = z.infer<typeof stashSchema>;

function stash(value: Stash): { context: Record<string, Stash> } {
  return { context: { [STASH_KEY]: value } };
}

function readStash<K extends Stash["kind"]>(
  ctx: object,
  kind: K,
): Extract<Stash, { kind: K }> | null {
  const parsed = stashSchema.safeParse(Reflect.get(ctx, STASH_KEY));
  if (!parsed.success || parsed.data.kind !== kind) return null;
  return parsed.data as Extract<Stash, { kind: K }>;
}

/*
 * Writes a lockout to the audit log with only { namespace, reason } (ADR
 * 0020 f, 0022): no email, no IP, no key. A failed write is logged but never
 * turns the generic 429 into something else.
 */
async function auditRefusal(audit: AuthLimitAudit): Promise<void> {
  try {
    await AuditLogModel.create({
      action: "auth.rate_limited",
      meta: { namespace: audit.namespace, reason: audit.reason },
    });
  } catch (error) {
    logAuthProblem("audit entry for a rate limit not written", error);
  }
}

/*
 * ADR 0032: a session made without "Keep me signed in" ends within 24 hours.
 * Better Auth's /change-password with revokeOtherSessions creates the
 * replacement session WITHOUT the don't-remember flag (dist/api/routes/
 * update-user.mjs:176), so it would be stored for 7 days while its cookie
 * stays session-only. When the signed dont_remember cookie came with the
 * request and a new session was issued (setSessionCookie calls
 * setNewSession, dist/cookies/index.mjs:167-179), cap it back to 24 h.
 */
const DONT_REMEMBER_SESSION_MS = 24 * 60 * 60 * 1000;

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

async function capDontRememberSession(ctx: HookContext): Promise<void> {
  const fresh = ctx.context.newSession;
  if (!fresh) return;
  const dontRemember = await ctx.getSignedCookie(
    ctx.context.authCookies.dontRememberToken.name,
    ctx.context.secret,
  );
  if (!dontRemember) return;
  await ctx.context.internalAdapter.updateSession(fresh.session.token, {
    expiresAt: new Date(Date.now() + DONT_REMEMBER_SESSION_MS),
  });
}

const userIdBody = z.object({ userId: z.coerce.string().min(1) });
const bannedUpdateBody = userIdBody.extend({
  data: z.object({ banned: z.unknown() }).loose(),
});
const resetTokenSchema = z.string().min(1).max(200);

/* One field of a parsed body or query object, without trusting its shape. */
function readField(source: unknown, key: string): unknown {
  return typeof source === "object" && source !== null
    ? Reflect.get(source, key)
    : undefined;
}

/* The cookie options for the device token (DEVICE_COOKIE, no Domain). */
function deviceCookieOptions() {
  return {
    ...DEVICE_COOKIE.attributes,
    maxAge: DEVICE_COOKIE.maxAgeSeconds,
  };
}

// ---------------------------------------------------------------------------
// Password-reset email
// ---------------------------------------------------------------------------

/*
 * Sends the reset email and never rejects. A failure is logged with only
 * Resend's reason, HTTP status and error code: never the address, the URL or
 * the token (ADR 0021). Better Auth only calls this for existing users, so
 * it runs in the background (advanced.backgroundTasks) to keep the response
 * time the same for unknown emails.
 */
async function sendResetEmailSafely(
  user: {
    email: string;
    name: string;
  },
  url: string,
): Promise<void> {
  try {
    await sendPasswordResetEmail({ to: user.email, name: user.name, url });
  } catch (error) {
    if (error instanceof EmailSendError) {
      console.error(
        `[auth] password-reset email not sent: reason=${error.reason} status=${error.statusCode ?? "-"} code=${error.providerCode ?? "-"}`,
      );
      return;
    }
    logAuthProblem("password-reset email not sent", error);
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** What createAuth() needs from its surroundings (injectable for tests). */
export interface AuthDependencies {
  /**
   * Keeps work alive after the response is sent. In the app this is Next's
   * `after()`, which on Vercel extends the function until the promise settles
   * (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md).
   */
  runInBackground: (task: Promise<unknown>) => void;
}

/*
 * Better Auth's own limiter, per network (its key is IP + path), on top of
 * our per-email limits: it caps one network across ALL emails (credential
 * stuffing). Counters live in loginAttempts with HMAC'd keys
 * (authLimiterStorage), never Better Auth's raw "ip|path" rows. Windows stay
 * within 15 minutes. /get-session is excluded: it is read-only, called on
 * every page that checks the session, and needs a valid cookie anyway.
 */
const RATE_LIMIT_RULES = {
  "/sign-in/email": { window: 60, max: 20 },
  // A signed-in user's password check (wrong current password = 400).
  "/change-password": { window: 15 * 60, max: 10 },
  "/request-password-reset": { window: 15 * 60, max: 10 },
  "/reset-password": { window: 15 * 60, max: 10 },
  "/get-session": false,
} as const;

/*
 * Endpoints this site doesn't use, refused with 404 by Better Auth's router
 * (`disabledPaths`, @better-auth/core/dist/types/init-options.d.mts:1528;
 * matched exactly in dist/api/index.mjs:166-168). Server code can still call
 * them through auth.api, which never goes through the router.
 * - /verify-password is declared `scope: "server"`, but nothing reads that
 *   (better-call only drops SERVER_ONLY routes), so over HTTP it would be a
 *   password oracle for anyone holding a session (QA M1).
 * - Sign-up, social/OAuth account routes, account deletion, email change and
 *   verification: no such features (accounts are made by the admin).
 * - /update-user: no profile editing is planned; our fields are input: false
 *   anyway (QA L3).
 * - Impersonation: the admin role has no such permission; closed twice.
 * Still open: sign-in/email, sign-out, get-session, change-password,
 * request-password-reset, reset-password(/:token), list/revoke sessions and
 * the admin endpoints.
 */
export const DISABLED_PATHS = [
  "/verify-password",
  "/sign-up/email",
  "/sign-in/social",
  "/link-social",
  "/unlink-account",
  "/refresh-token",
  "/get-access-token",
  "/account-info",
  "/delete-user",
  "/delete-user/callback",
  "/change-email",
  "/send-verification-email",
  "/verify-email",
  "/update-user",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
] as const;

/**
 * Builds the Better Auth instance. Reads env (AUTH_SECRET, AUTH_URL,
 * MONGODB_URI) at call time, so it must not run at import: use getAuth().
 * Every option below was checked in better-auth 1.7.7's installed types
 * (@better-auth/core/dist/types/init-options.d.mts) and sources.
 */
export function createAuth(deps: AuthDependencies) {
  const { secret, url } = env.auth();

  return betterAuth({
    appName: "YG UniLUX",
    secret,
    baseURL: url,
    database: mongodbAdapter(getDb(), { client: getMongoClient() }),
    telemetry: { enabled: false },
    disabledPaths: [...DISABLED_PATHS],
    // Better Auth warns "User not found" vs "Invalid password" on failed
    // sign-ins (dist/api/routes/sign-in.mjs:82-96), which would tell anyone
    // reading the logs which emails have accounts. Errors only.
    logger: { level: "error" },

    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: false,
      minPasswordLength: 12,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: PASSWORD_RESET_TOKEN_TTL_SECONDS,
      password: { hash: hashPassword, verify: verifyPassword },
      sendResetPassword: ({ user, url: link }) =>
        sendResetEmailSafely(user, link),
    },

    user: {
      modelName: "users",
      additionalFields: {
        mustChangePassword: {
          type: "boolean",
          required: false,
          defaultValue: true,
          input: false,
        },
        accessExpiresAt: { type: "date", required: false, input: false },
        company: { type: "string", required: false, input: false },
        country: { type: "string", required: false, input: false },
        deviceEpoch: {
          type: "number",
          required: false,
          defaultValue: 0,
          input: false,
          returned: false,
        },
        // Phase 5 (ADR 0068), written only by src/lib/account-writes.ts.
        // Better Auth's adapter drops undeclared keys on write, so each one
        // must be declared here. The browser needs none: returned: false.
        /** The accessExpiresAt value the last 7-day reminder was sent for. */
        expiryReminderFor: {
          type: "date",
          required: false,
          input: false,
          returned: false,
        },
        /** When the latest invite link was made (null = never invited). */
        invitedAt: {
          type: "date",
          required: false,
          input: false,
          returned: false,
        },
        /** When that invite link stops working. */
        inviteExpiresAt: {
          type: "date",
          required: false,
          input: false,
          returned: false,
        },
        /** When the user last chose their own password. */
        passwordSetAt: {
          type: "date",
          required: false,
          input: false,
          returned: false,
        },
      },
    },
    // Sessions live in the database only. The cookie cache stays off (its
    // default), so every getSession reads the sessions collection and a ban
    // or password reset takes effect on the next request.
    session: { modelName: "sessions" },
    account: { modelName: "accounts" },
    // Reset tokens are stored as SHA-256 hashes, so a database leak does not
    // hand out live reset links.
    verification: { modelName: "verifications", storeIdentifier: "hashed" },

    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: RATE_LIMIT_RULES,
      customStorage: authLimiterStorage,
    },

    advanced: {
      // The only header Vercel guarantees (ADR 0022); IPv6 grouped by /64.
      ipAddress: {
        ipAddressHeaders: ["x-vercel-forwarded-for"],
        ipv6Subnet: 64,
      },
      // Cookie names: __Secure-yg.session_token and __Secure-yg.dont_remember
      // over https (better-auth dist/cookies/index.mjs:20-46).
      cookiePrefix: AUTH_COOKIE_PREFIX,
      useSecureCookies: env.isProduction() ? true : undefined,
      // Explicit, because Better Auth turns the origin check off by default
      // when NODE_ENV is "test" (dist/context/create-context.mjs:211); tests
      // then run with the same CSRF protection as production.
      disableCSRFCheck: false,
      disableOriginCheck: false,
      backgroundTasks: { handler: deps.runInBackground },
    },

    // Non-API errors are thrown to our route handler, which answers a
    // generic 500 and logs only the error's type (src/lib/auth-handler.ts),
    // instead of Better Auth / better-call printing the whole error.
    onAPIError: { throw: true },

    databaseHooks: {
      session: {
        create: {
          // Better Auth stores the client IP on every session
          // (dist/db/internal-adapter.mjs:263). We keep none (ADR 0022).
          before: async () => ({ data: { ipAddress: "" } }),
        },
      },
    },

    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        switch (ctx.path) {
          // Sign-in gate (ADR 0022): validate the email, look up the user's
          // device epoch (unknown email: 0), then count the attempt. Every
          // refusal is the same 429, logged with namespace and reason only.
          case "/sign-in/email": {
            const email = parseEmail(ctx.body);
            const found =
              await ctx.context.internalAdapter.findUserByEmail(email);
            const deviceEpoch = epochOf(found?.user);
            const deviceToken = ctx.getCookie(DEVICE_COOKIE.name) ?? undefined;
            const gate = await runLimiter(() =>
              consumeSignIn({
                email,
                headers: ctx.headers ?? new Headers(),
                deviceToken,
                deviceEpoch,
              }),
            );
            if (!gate.allowed) {
              await auditRefusal(gate.audit);
              throw tooManyRequests(gate.retryAfterSeconds);
            }
            return stash({
              kind: "sign-in",
              email,
              path: gate.path,
              deviceToken,
              deviceEpoch,
            });
          }
          // Reset-request gate: unknown emails are counted the same way.
          case "/request-password-reset": {
            const email = parseEmail(ctx.body);
            const gate = await runLimiter(() =>
              consumeResetRequest({
                email,
                headers: ctx.headers ?? new Headers(),
              }),
            );
            if (!gate.allowed) {
              await auditRefusal(gate.audit);
              throw tooManyRequests(gate.retryAfterSeconds);
            }
            return;
          }
          // Password change by a signed-in user (task-5 QA L1): count the
          // attempt per user BEFORE Better Auth checks the current password.
          // The session is read from the database, and the endpoint's own
          // sensitiveSessionMiddleware reads it again: two reads on purpose,
          // so never hand this one through. No session: the endpoint
          // answers its own 401.
          case "/change-password": {
            const session = await getAuthoritativeSessionFromCtx(ctx);
            if (!session?.user.id) return;
            const userId = session.user.id;
            const gate = await runLimiter(() => consumePasswordChange(userId));
            if (!gate.allowed) {
              await auditRefusal(gate.audit);
              throw tooManyRequests(gate.retryAfterSeconds);
            }
            return;
          }
          // Completing a reset: find whose token this is BEFORE Better Auth
          // consumes it, so the after hook knows which account to recover.
          // Better Auth takes the token from the body first, then from
          // ?token= (dist/api/routes/password.mjs:149); read it the same way.
          case "/reset-password": {
            const token = resetTokenSchema.safeParse(
              readField(ctx.body, "token") || readField(ctx.query, "token"),
            );
            if (!token.success) return;
            const verification =
              await ctx.context.internalAdapter.findVerificationValue(
                `reset-password:${token.data}`,
              );
            if (!verification || verification.expiresAt < new Date()) return;
            const user = await ctx.context.internalAdapter.findUserById(
              verification.value,
            );
            if (!user) return;
            return stash({ kind: "reset", userId: user.id, email: user.email });
          }
          default:
            return;
        }
      }),

      after: createAuthMiddleware(async (ctx) => {
        if (isAPIError(ctx.context.returned)) return;
        switch (ctx.path) {
          // Successful sign-in: clear only the counter of the path that let
          // it through (QA L2), then issue or refresh the device token.
          case "/sign-in/email": {
            const signedIn = ctx.context.newSession;
            const gate = readStash(ctx, "sign-in");
            if (!signedIn || !gate) return;
            const path: SignInPath = gate.path;
            try {
              await clearSignIn(
                {
                  email: gate.email,
                  headers: ctx.headers ?? new Headers(),
                  deviceToken: gate.deviceToken,
                  deviceEpoch: gate.deviceEpoch,
                },
                path,
              );
            } catch (error) {
              // The user is signed in; a counter that stays only costs them
              // one attempt of their own budget.
              logAuthProblem("sign-in counter not cleared", error);
            }
            const token = issueDeviceToken(
              signedIn.user.email,
              epochOf(signedIn.user),
            );
            ctx.setCookie(
              DEVICE_COOKIE.name,
              token.value,
              deviceCookieOptions(),
            );
            return;
          }
          // Successful reset or invite (QA M1, ADR 0068): it proves control
          // of the mailbox, so every other reset/invite link of the user
          // dies, the temporary-password flag is cleared and old device
          // tokens are revoked (one write), counters are cleared and this
          // browser gets a fresh device token.
          case "/reset-password": {
            const target = readStash(ctx, "reset");
            if (!target) return;
            // Sessions were already revoked by Better Auth
            // (revokeSessionsOnPasswordReset). Failures are thrown (a 500):
            // the link is spent, but the user is told it failed and can ask
            // for a new one, never left believing it worked while the flag
            // is still set. The links go first, the flag write last.
            await revokePasswordLinks(ctx.context, target.userId);
            const epoch = await recordPasswordSet(ctx.context, target.userId);
            if (epoch === null) return;
            try {
              await clearAllForEmail(target.email);
            } catch (error) {
              logAuthProblem("counters not cleared after reset", error);
            }
            const token = issueDeviceToken(target.email, epoch);
            ctx.setCookie(
              DEVICE_COOKIE.name,
              token.value,
              deviceCookieOptions(),
            );
            return;
          }
          // A user changed their own password (QA L2). Better Auth ends the
          // other sessions only when the request sends
          // `revokeOtherSessions: true` (dist/api/routes/update-user.mjs:174);
          // the Phase 5 change-password UI MUST send it. Order (ADR 0068):
          // 1. cap the new session at 24 h if "keep me signed in" was off;
          // 2. kill any outstanding reset/invite link of the user;
          // 3. ONE write: mustChangePassword false + passwordSetAt + epoch
          //    bump (old device tokens die);
          // 4. a fresh device token for this browser.
          // Any failure is thrown (a 500, never swallowed). The password has
          // changed by then, but the flag is still set, so the user is sent
          // back to /change-password and retries with the new password.
          case "/change-password": {
            const user = ctx.context.session?.user;
            if (!user) return;
            await capDontRememberSession(ctx);
            await revokePasswordLinks(ctx.context, user.id);
            const epoch = await recordPasswordSet(ctx.context, user.id);
            if (epoch === null) return;
            const token = issueDeviceToken(user.email, epoch);
            ctx.setCookie(
              DEVICE_COOKIE.name,
              token.value,
              deviceCookieOptions(),
            );
            return;
          }
          // Admin set a new password: old sessions and device tokens die.
          // Better Auth doesn't end sessions here (plugins/admin/routes.mjs
          // :820-841), so the sessions go FIRST: if that or the epoch bump
          // fails, the error is thrown (a 500 / rejected auth.api call) and
          // the admin retries, never a silent "done" with old sessions alive.
          case "/admin/set-user-password": {
            const body = userIdBody.safeParse(ctx.body);
            if (!body.success) return;
            await ctx.context.internalAdapter.deleteUserSessions(
              body.data.userId,
            );
            await bumpDeviceEpoch(ctx.context, body.data.userId);
            return;
          }
          // Ban: Better Auth already revoked the sessions; kill the tokens.
          // A failed bump is thrown, not swallowed.
          case "/admin/ban-user": {
            const body = userIdBody.safeParse(ctx.body);
            if (!body.success) return;
            await bumpDeviceEpoch(ctx.context, body.data.userId);
            return;
          }
          // A ban through update-user (banned: true) also deletes sessions
          // in Better Auth (plugins/admin/routes.mjs:305); kill the tokens too.
          case "/admin/update-user": {
            const body = bannedUpdateBody.safeParse(ctx.body);
            if (!body.success || body.data.data.banned !== true) return;
            await bumpDeviceEpoch(ctx.context, body.data.userId);
            return;
          }
          default:
            return;
        }
      }),
    },

    plugins: [
      admin({
        ac: accessControl,
        roles: ROLES,
        defaultRole: "customer",
        adminRoles: ["admin"],
        // Shown only after a correct password, and says nothing more.
        bannedUserMessage:
          "This account is disabled. Please contact us for help.",
      }),
      // Must stay last: copies Set-Cookie headers (including our device
      // cookie) into Next's cookie store for Server Actions
      // (dist/integrations/cookie-plugin-guard.mjs).
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/*
 * Lazily built, once per server instance (cached on globalThis so dev hot
 * reload doesn't build a second one). Building reads env, so importing this
 * module never does: `next build` runs with no secrets.
 */
const AUTH_CACHE_KEY = "__ygUniluxAuth";

/**
 * Better Auth's internal context (adapter, internalAdapter, password) for
 * server code outside a request hook: invite links, the P3 customer
 * services and the cron. Connects to MongoDB first.
 */
export async function getAuthContext(): Promise<Awaited<Auth["$context"]>> {
  await connectDb();
  return getAuth().$context;
}

/** The app's Better Auth instance. Call only at request time. */
export function getAuth(): Auth {
  const store = globalThis as typeof globalThis & {
    [AUTH_CACHE_KEY]?: Auth;
  };
  store[AUTH_CACHE_KEY] ??= createAuth({
    runInBackground: (task) => after(task),
  });
  return store[AUTH_CACHE_KEY];
}

/**
 * Runs server-side Better Auth calls (`auth.api.*`) after the shared MongoDB
 * client has connected (ADR 0018: Better Auth needs connectDb() awaited, and
 * Mongoose code in our hooks does too).
 */
export async function withAuth<T>(run: (auth: Auth) => Promise<T>): Promise<T> {
  await connectDb();
  return run(getAuth());
}

/**
 * The current session, always read from the database (cookie cache
 * bypassed with `disableCookieCache`, better-auth
 * dist/api/routes/session.mjs:48). For requireAdmin() and the datasheet
 * route. Null when signed out or the session has ended.
 */
export function getSessionFromDb(headers: Headers) {
  return withAuth((auth) =>
    auth.api.getSession({ headers, query: { disableCookieCache: true } }),
  );
}
