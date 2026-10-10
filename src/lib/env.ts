import "server-only";

import { z } from "zod";

import {
  CLOUDINARY_URL_FORMAT,
  type CloudinaryCredentials,
  parseCloudinaryUrl,
} from "./cloudinary-url";

/**
 * Server-only, lazily validated environment access (ADR 0011).
 *
 * Nothing is read at import time: each getter validates only the variables its
 * feature needs, when that feature is first used. A fresh checkout and CI can
 * therefore build and run with no secrets set.
 *
 * Error messages name the variable and the expected format but never include
 * the value, and never chain the Zod error (which could echo the input).
 */

export class EnvError extends Error {
  override readonly name = "EnvError";
  readonly variables: readonly string[];

  constructor(feature: string, problems: readonly EnvProblem[]) {
    const lines = problems.map((p) => {
      switch (p.kind) {
        case "missing":
          return `  - ${p.variable}: missing`;
        case "blank":
          return `  - ${p.variable}: missing (only whitespace)`;
        case "invalid":
          return `  - ${p.variable}: invalid, expected ${p.expected}`;
      }
    });
    super(
      `Environment is not configured for ${feature}:\n${lines.join("\n")}\n` +
        "Set these in .env.local (see .env.example) or in the Vercel project settings.",
    );
    this.variables = problems.map((p) => p.variable);
  }
}

type EnvProblem =
  | { kind: "missing"; variable: string }
  | { kind: "blank"; variable: string }
  | { kind: "invalid"; variable: string; expected: string };

interface Rule<T> {
  schema: z.ZodType<T>;
  expected: string;
  /** The schema trims its own input, so surrounding whitespace is allowed. */
  trimsInput?: boolean;
}

const rule = <T>(
  schema: z.ZodType<T>,
  expected: string,
  options: { trimsInput?: boolean } = {},
): Rule<T> => ({ schema, expected, ...options });

const httpUrl = rule(z.url({ protocol: /^https?$/ }), "an http(s) URL");

/*
 * A bare origin such as "https://www.example.com" or "http://localhost:3000":
 * no path, query, fragment or credentials. Better Auth treats a URL with a
 * path as already including its "/api/auth" base path, so a stray path would
 * silently move every auth route.
 */
const originUrl = rule(
  z.url({ protocol: /^https?$/ }).refine((value) => {
    // Zod still runs this refinement after z.url() failed, and `new URL()`
    // would throw a TypeError that quotes the value, so parse safely.
    const url = URL.parse(value);
    if (!url) return false;
    return (
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === "" &&
      !value.endsWith("/")
    );
  }),
  'an http(s) origin without a path or trailing slash, e.g. "https://www.example.com"',
);
const email = rule(z.email(), "an email address");
const nonEmpty = rule(z.string().min(1), "a non-empty string");
const longSecret = rule(
  z.string().min(32),
  "a random string of at least 32 characters",
);
/*
 * Sent by Vercel Cron as `Authorization: Bearer <secret>`, so it must fit in
 * one header token: printable ASCII, no spaces (the cron route checks the
 * same character class, ADR 0072). A passphrase with a space would
 * otherwise be accepted here and refuse every cron call with a silent 401.
 */
/** "Bearer " + the secret fits the route's 512-character header cap. */
export const MAX_CRON_SECRET_LENGTH = 505;
const cronSecretRule = rule(
  z
    .string()
    .min(32)
    .max(MAX_CRON_SECRET_LENGTH)
    .regex(/^[!-~]+$/),
  `a random string of 32 to ${MAX_CRON_SECRET_LENGTH} printable ASCII characters without spaces`,
);

/** "no-reply@example.com" or "YG UniLUX <no-reply@example.com>". */
const emailFrom = rule(
  z.string().refine((value) => {
    const match = /^[^<>]+<([^<>\s]+)>$/.exec(value);
    return z.email().safeParse(match ? match[1] : value).success;
  }),
  'an email address or "Name <address>"',
);

/*
 * The URI must name its database (".../yg_unilux?..."). Atlas's "Connect"
 * dialog omits it, and the driver then silently uses a database called
 * "test", so Preview and Production on one cluster could share data.
 * Shape: scheme, hosts (no "/"), "/", a non-empty database name, optional query.
 */
const mongoUri = rule(
  z.string().regex(/^mongodb(\+srv)?:\/\/[^/\s]+\/[^/?\s]+(\?\S*)?$/),
  "a mongodb:// or mongodb+srv:// URI that names the database, e.g. …mongodb.net/yg_unilux?retryWrites=true",
);

/** Canonical base64 that decodes to exactly 32 bytes (AES-256 key, ADR 0005). */
const aes256KeyBase64 = rule(
  z.string().transform((value, ctx) => {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length !== 32 || bytes.toString("base64") !== value) {
      ctx.addIssue({ code: "custom", message: "invalid key" });
      return z.NEVER;
    }
    return bytes;
  }),
  "base64 of exactly 32 random bytes (openssl rand -base64 32)",
);

/** cloudinary://<api_key>:<api_secret>@<cloud_name>, parsed into its three parts. */
const cloudinaryUrl = rule(
  z.string().transform((value, ctx): CloudinaryCredentials => {
    const credentials = parseCloudinaryUrl(value);
    if (!credentials) {
      ctx.addIssue({ code: "custom", message: "invalid CLOUDINARY_URL" });
      return z.NEVER;
    }
    return credentials;
  }),
  CLOUDINARY_URL_FORMAT,
);

const booleanFlag = rule(
  z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(z.enum(["true", "false", "1", "0"]))
    .transform((value) => value === "true" || value === "1"),
  '"true" or "false"',
  { trimsInput: true },
);

/* Better Auth's own env variables that would override our explicit config. */
const BETTER_AUTH_OVERRIDES = {
  BETTER_AUTH_SECRET: "use AUTH_SECRET",
  BETTER_AUTH_SECRETS: "use AUTH_SECRET",
  BETTER_AUTH_URL: "use AUTH_URL",
  BETTER_AUTH_TRUSTED_ORIGINS: "only AUTH_URL is trusted",
} as const;

type Spec = Record<string, { rule: Rule<unknown>; optional?: boolean }>;
type Parsed<S extends Spec> = {
  [K in keyof S]: S[K]["rule"] extends Rule<infer T>
    ? S[K]["optional"] extends true
      ? T | undefined
      : T
    : never;
};

/** Reads and validates the given variables, collecting every problem before throwing. */
function read<S extends Spec>(feature: string, spec: S): Parsed<S> {
  const problems: EnvProblem[] = [];
  const out: Record<string, unknown> = {};

  for (const [variable, { rule: r, optional }] of Object.entries(spec)) {
    const raw = process.env[variable];
    if (raw === undefined || raw === "") {
      if (!optional) problems.push({ kind: "missing", variable });
      out[variable] = undefined;
      continue;
    }
    // Whitespace-only is a mistake, not "unset": report it even when the
    // variable is optional, so a switch never silently falls back to default.
    if (raw.trim() === "") {
      problems.push({ kind: "blank", variable });
      continue;
    }
    // A pasted secret with a stray space or newline would fail later at the
    // provider with a confusing error, so reject it here.
    if (!r.trimsInput && raw !== raw.trim()) {
      problems.push({
        kind: "invalid",
        variable,
        expected: `${r.expected}, without leading or trailing whitespace`,
      });
      continue;
    }
    const result = r.schema.safeParse(raw);
    if (result.success) out[variable] = result.data;
    else problems.push({ kind: "invalid", variable, expected: r.expected });
  }

  if (problems.length > 0) throw new EnvError(feature, problems);
  return out as Parsed<S>;
}

export const env = {
  mongo() {
    const v = read("MongoDB", { MONGODB_URI: { rule: mongoUri } });
    return { uri: v.MONGODB_URI };
  },

  /**
   * Better Auth's secret and base URL (ADR 0017). AUTH_URL is required: when
   * Better Auth's `baseURL` is unset it falls back to BETTER_AUTH_URL-style
   * variables and then to the request's own origin (better-auth 1.7.7,
   * dist/utils/url.mjs getBaseURL), so reset-email links could follow a
   * forged Host header. Passing it explicitly closes that and keeps all env
   * reading here.
   */
  auth() {
    const v = read("authentication", {
      AUTH_SECRET: { rule: longSecret },
      AUTH_URL: { rule: originUrl },
    });
    // Better Auth turns telemetry on when BETTER_AUTH_TELEMETRY is truthy,
    // whatever our `telemetry: { enabled: false }` says
    // (@better-auth/telemetry/dist/index.mjs:361; truthy = set, not "0" and
    // not "false", core/dist/env/env-impl.mjs:49). Refuse to start instead.
    const telemetry = process.env.BETTER_AUTH_TELEMETRY;
    if (
      telemetry !== undefined &&
      telemetry !== "" &&
      telemetry !== "0" &&
      telemetry.toLowerCase() !== "false"
    ) {
      throw new EnvError("authentication", [
        {
          kind: "invalid",
          variable: "BETTER_AUTH_TELEMETRY",
          expected:
            'unset (or "0"/"false"): it would switch on Better Auth telemetry',
        },
      ]);
    }
    // Better Auth also reads its own variables behind our back: secrets
    // (dist/context/create-context.mjs:70-71), the URL (dist/utils/url.mjs:71)
    // and extra trusted origins (dist/context/helpers.mjs:83). All config goes
    // through this file, so refuse to start if any is set. Only the name is
    // reported, never the value.
    for (const variable of Object.keys(
      BETTER_AUTH_OVERRIDES,
    ) as (keyof typeof BETTER_AUTH_OVERRIDES)[]) {
      const value = process.env[variable];
      if (value !== undefined && value !== "") {
        throw new EnvError("authentication", [
          {
            kind: "invalid",
            variable,
            expected: `unset: Better Auth reads it directly, bypassing src/lib/env.ts (${BETTER_AUTH_OVERRIDES[variable]})`,
          },
        ]);
      }
    }
    return { secret: v.AUTH_SECRET, url: v.AUTH_URL };
  },

  /**
   * AUTH_SECRET alone, for code that derives subkeys from it (rate-limit
   * keys, device tokens) and has no use for the URL.
   */
  authSecret(): string {
    return read("authentication", { AUTH_SECRET: { rule: longSecret } })
      .AUTH_SECRET;
  },

  /** Public product images (ADR 0009). One variable: CLOUDINARY_URL. */
  cloudinary(): CloudinaryCredentials {
    return read("Cloudinary", { CLOUDINARY_URL: { rule: cloudinaryUrl } })
      .CLOUDINARY_URL;
  },

  r2() {
    const v = read("Cloudflare R2 private storage", {
      R2_ACCOUNT_ID: { rule: nonEmpty },
      R2_ACCESS_KEY_ID: { rule: nonEmpty },
      R2_SECRET_ACCESS_KEY: { rule: nonEmpty },
      R2_BUCKET: { rule: nonEmpty },
    });
    return {
      accountId: v.R2_ACCOUNT_ID,
      accessKeyId: v.R2_ACCESS_KEY_ID,
      secretAccessKey: v.R2_SECRET_ACCESS_KEY,
      bucket: v.R2_BUCKET,
    };
  },

  email() {
    const v = read("sending email (Resend)", {
      RESEND_API_KEY: { rule: nonEmpty },
      EMAIL_FROM: { rule: emailFrom },
    });
    return { resendApiKey: v.RESEND_API_KEY, from: v.EMAIL_FROM };
  },

  companyEmail(): string {
    return read("the company email address", { COMPANY_EMAIL: { rule: email } })
      .COMPANY_EMAIL;
  },

  /** CN geo-block switch (ADR 0003). Unset or empty means off. */
  geoBlockEnabled(): boolean {
    const v = read("the geo-block switch", {
      GEO_BLOCK_ENABLED: { rule: booleanFlag, optional: true },
    });
    return v.GEO_BLOCK_ENABLED ?? false;
  },

  /** Current AES-256-GCM key for whistleblower data (ADR 0005). */
  whistleblowerKey(): Buffer {
    return read("whistleblower encryption", {
      WHISTLEBLOWER_ENC_KEY: { rule: aes256KeyBase64 },
    }).WHISTLEBLOWER_ENC_KEY;
  },

  cronSecret(): string {
    return read("cron authentication", {
      CRON_SECRET: { rule: cronSecretRule },
    }).CRON_SECRET;
  },

  /**
   * Dedicated key for scrambling client IPs in the sign-in rate limit
   * (ADR 0022). Separate from AUTH_SECRET so the session-signing secret never
   * touches IP data; rotating it only resets 15-minute counters.
   */
  ipHashSecret(): string {
    const feature = "sign-in rate limiting by network";
    const secret = read(feature, {
      IP_HASH_SECRET: { rule: longSecret },
    }).IP_HASH_SECRET;
    // Reusing AUTH_SECRET would defeat the point of a dedicated key. Only the
    // variable name goes into the error, never either value.
    if (secret === process.env.AUTH_SECRET) {
      throw new EnvError(feature, [
        {
          kind: "invalid",
          variable: "IP_HASH_SECRET",
          expected: "a secret different from AUTH_SECRET",
        },
      ]);
    }
    return secret;
  },

  /**
   * True in production builds (Vercel Production and Preview both run with
   * NODE_ENV=production). Not a secret and not validated: Next.js sets it.
   */
  isProduction(): boolean {
    return process.env.NODE_ENV === "production";
  },

  siteUrl(): URL {
    return new URL(
      read("absolute site URLs", { SITE_URL: { rule: httpUrl } }).SITE_URL,
    );
  },
};
