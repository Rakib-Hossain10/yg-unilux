import "server-only";

import { z } from "zod";

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
    const lines = problems.map((p) =>
      p.kind === "missing"
        ? `  - ${p.variable}: missing`
        : `  - ${p.variable}: invalid, expected ${p.expected}`,
    );
    super(
      `Environment is not configured for ${feature}:\n${lines.join("\n")}\n` +
        "Set these in .env.local (see .env.example) or in the Vercel project settings.",
    );
    this.variables = problems.map((p) => p.variable);
  }
}

type EnvProblem =
  | { kind: "missing"; variable: string }
  | { kind: "invalid"; variable: string; expected: string };

interface Rule<T> {
  schema: z.ZodType<T>;
  expected: string;
}

const rule = <T>(schema: z.ZodType<T>, expected: string): Rule<T> => ({
  schema,
  expected,
});

const httpUrl = rule(z.url({ protocol: /^https?$/ }), "an http(s) URL");
const email = rule(z.email(), "an email address");
const nonEmpty = rule(z.string().min(1), "a non-empty string");
const longSecret = rule(
  z.string().min(32),
  "a random string of at least 32 characters",
);

/** "no-reply@example.com" or "YG UniLUX <no-reply@example.com>". */
const emailFrom = rule(
  z.string().refine((value) => {
    const match = /^[^<>]+<([^<>\s]+)>$/.exec(value.trim());
    return z.email().safeParse(match ? match[1] : value).success;
  }),
  'an email address or "Name <address>"',
);

const mongoUri = rule(
  z.string().regex(/^mongodb(\+srv)?:\/\/\S+$/),
  "a mongodb:// or mongodb+srv:// URI",
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

const booleanFlag = rule(
  z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(z.enum(["true", "false", "1", "0"]))
    .transform((value) => value === "true" || value === "1"),
  '"true" or "false"',
);

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

  auth() {
    const v = read("authentication", {
      AUTH_SECRET: { rule: longSecret },
      // Optional: Auth.js infers the URL from the request host on Vercel.
      AUTH_URL: { rule: httpUrl, optional: true },
    });
    return { secret: v.AUTH_SECRET, url: v.AUTH_URL };
  },

  cloudinary() {
    const v = read("Cloudinary", {
      CLOUDINARY_CLOUD_NAME: { rule: nonEmpty },
      CLOUDINARY_API_KEY: { rule: nonEmpty },
      CLOUDINARY_API_SECRET: { rule: nonEmpty },
    });
    return {
      cloudName: v.CLOUDINARY_CLOUD_NAME,
      apiKey: v.CLOUDINARY_API_KEY,
      apiSecret: v.CLOUDINARY_API_SECRET,
    };
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
    return read("cron authentication", { CRON_SECRET: { rule: longSecret } })
      .CRON_SECRET;
  },

  siteUrl(): URL {
    return new URL(
      read("absolute site URLs", { SITE_URL: { rule: httpUrl } }).SITE_URL,
    );
  },
};
