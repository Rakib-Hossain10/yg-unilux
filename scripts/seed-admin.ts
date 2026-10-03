// CLI: creates the admin account or resets its password from the command line,
// so the single admin can never be locked out (CLAUDE.md "Roles", ADR 0025).
// The password is never a command-line argument; it is typed at a hidden prompt.

/*
 * Usage (see the `seed:admin` npm script for the node flags, which are the
 * same as `db:indexes`, explained in scripts/sync-indexes.ts):
 *   npm run seed:admin -- --email admin@example.com --name "YG Admin"   create
 *   npm run seed:admin -- --email admin@example.com --reset             new password
 * The password is read from a hidden prompt (typed twice). Where there is no
 * terminal (CI, Git Bash without winpty), set SEED_ADMIN_PASSWORD for that
 * one command instead; it is never echoed or logged.
 */

import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";

import { createAuth } from "@/lib/auth";
import { DbConnectionError, connectDb, disconnectDb } from "@/lib/db";
import { EnvError } from "@/lib/env";
import { RateLimitUnavailableError } from "@/lib/rate-limit";
import {
  type SeedAdminInput,
  SeedAdminError,
  emailSchema,
  nameSchema,
  seedAdmin,
  seedAdminInput,
} from "@/lib/seed-admin";

const USAGE = `Usage:
  npm run seed:admin -- --email <email> --name "<name>"   create the admin
  npm run seed:admin -- --email <email> --reset           set a new admin password
The password is asked for at a hidden prompt (or read from SEED_ADMIN_PASSWORD).`;

/** Parsed command line. Exported for tests. */
export interface CliOptions {
  email: string;
  name?: string;
  reset: boolean;
}

/**
 * Reads the arguments. A password flag is refused on purpose: arguments end
 * up in shell history and process lists.
 */
export function parseCli(
  argv: string[],
): CliOptions | { error: string } | { help: true } {
  if (argv.some((arg) => /^--?(password|pass|pw)(=|$)/i.test(arg))) {
    return {
      error:
        "Never pass the password as an argument. It will be asked for at a hidden prompt.",
    };
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        email: { type: "string" },
        name: { type: "string" },
        reset: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    // parseArgs quotes the offending argument, which may be a mistyped
    // password (QA L-1, task 7), so the message never repeats it.
    return {
      error: `Unrecognised argument (not shown, in case it was a password).\n${USAGE}`,
    };
  }
  if (values.help) return { help: true };
  if (!values.email) return { error: `--email is required.\n${USAGE}` };
  if (values.reset && values.name !== undefined) {
    return { error: "--name is only used when creating the admin." };
  }
  if (!values.reset && values.name === undefined) {
    return { error: `--name is required to create the admin.\n${USAGE}` };
  }
  return { email: values.email, name: values.name, reset: values.reset };
}

/*
 * Reads one line from the terminal without echoing it (raw mode). Ctrl+C
 * aborts; Backspace deletes. Only used when stdin is a TTY.
 */
function promptHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  return new Promise((resolve, reject) => {
    let value = "";
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") return finish(new SeedAdminError("Cancelled."));
        // Arrow/Home/Delete keys send escape sequences whose tail would
        // silently join the password (QA L-2), so refuse instead.
        if (char === "\u001b") {
          return finish(
            new SeedAdminError(
              "Arrow and other special keys aren't supported at this prompt. Run the command again and type only the password.",
            ),
          );
        }
        if (char === "\u007f" || char === "\b") {
          // Whole characters, so an emoji isn't cut in half.
          value = Array.from(value).slice(0, -1).join("");
        } else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * True when an env file text sets SEED_ADMIN_PASSWORD to a value. The npm
 * script loads .env.local, so a password saved there would sit on disk
 * indefinitely; it may only come from the shell for one command.
 */
export function envFileHasPassword(text: string): boolean {
  return /^[ \t]*(export[ \t]+)?SEED_ADMIN_PASSWORD[ \t]*=[ \t]*\S/m.test(text);
}

/* The new password: SEED_ADMIN_PASSWORD, else typed twice at a hidden prompt. */
async function readPassword(): Promise<string> {
  if (
    existsSync(".env.local") &&
    envFileHasPassword(readFileSync(".env.local", "utf8"))
  ) {
    throw new SeedAdminError(
      "Remove SEED_ADMIN_PASSWORD from .env.local. Passwords must not be stored in files; use the prompt.",
    );
  }
  const fromEnv = process.env.SEED_ADMIN_PASSWORD;
  // Read once, then dropped, so nothing later in the process can see it.
  delete process.env.SEED_ADMIN_PASSWORD;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (!process.stdin.isTTY) {
    throw new SeedAdminError(
      "No terminal for a hidden prompt. Set SEED_ADMIN_PASSWORD for this one command, or run it from PowerShell/cmd (Git Bash: prefix with winpty).",
    );
  }
  const first = await promptHidden("New admin password (12+ characters): ");
  const second = await promptHidden("Repeat the password: ");
  if (first !== second) throw new SeedAdminError("The passwords don't match.");
  return first;
}

/*
 * Prints a fatal error without leaking data: our own error types carry safe
 * messages; anything else shows only its type (driver and Better Auth
 * messages can quote emails).
 */
function reportFatal(error: unknown): void {
  const safe =
    error instanceof SeedAdminError ||
    error instanceof EnvError ||
    error instanceof DbConnectionError ||
    error instanceof RateLimitUnavailableError
      ? error.message
      : `${error instanceof Error ? error.name : "Unknown error"} (details withheld)`;
  console.error(`seed:admin failed.\n${safe}`);
}

async function main(): Promise<number> {
  const options = parseCli(process.argv.slice(2));
  if ("help" in options) {
    console.log(USAGE);
    return 0;
  }
  if ("error" in options) {
    console.error(options.error);
    return 1;
  }
  // Email and name are checked before the password is asked for, so a typo
  // there doesn't cost two password entries.
  const early = [
    emailSchema.safeParse(options.email),
    options.reset ? null : nameSchema.safeParse(options.name ?? ""),
  ].flatMap((result) => (result && !result.success ? result.error.issues : []));
  if (early.length > 0) {
    console.error(early.map((issue) => issue.message).join("\n"));
    return 1;
  }
  const input: SeedAdminInput = options.reset
    ? { mode: "reset", email: options.email, password: await readPassword() }
    : {
        mode: "create",
        email: options.email,
        name: options.name ?? "",
        password: await readPassword(),
      };
  // Check the input before connecting, so a short password or a bad email
  // fails at once instead of after a database round trip.
  const checked = seedAdminInput.safeParse(input);
  if (!checked.success) {
    console.error(
      checked.error.issues.map((issue) => issue.message).join("\n"),
    );
    return 1;
  }
  try {
    await connectDb();
    // No request context in a CLI: background work just runs, errors dropped
    // (none of the calls used here schedules any).
    const auth = createAuth({
      runInBackground: (task) => void task.catch(() => {}),
    });
    const result = await seedAdmin(auth, input);
    if (result.mode === "create") {
      console.log(`Admin created: ${result.email}. You can sign in now.`);
    } else {
      console.log(
        `Admin password reset: ${result.email}. All sessions were signed out and login limits cleared.` +
          (result.unbanned
            ? " The account was banned and is now unblocked."
            : ""),
      );
    }
    return 0;
  } finally {
    await disconnectDb();
  }
}

// Run only as a CLI, not when a test imports parseCli.
if (process.argv[1] && /seed-admin\.ts$/.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      reportFatal(error);
      process.exitCode = 1;
    },
  );
}
