// CLI: runs the daily access-expiry reminder job (ADR 0072) by hand, the
// same code as GET /api/cron/access-expiry. A dry run by default.

/*
 * Usage (node flags as in `db:indexes`, explained in scripts/sync-indexes.ts):
 *   npm run cron:expiry                 dry run: counts the customers due
 *   npm run cron:expiry -- --dry-run    the same, said explicitly
 *   npm run cron:expiry -- --send       sends the reminders and the digest
 * A dry run takes no lock, sends nothing and writes nothing. Output is
 * counts only, never an address or a name.
 */

import process from "node:process";
import { parseArgs } from "node:util";

import { createAuth } from "@/lib/auth";
import { DbConnectionError, connectDb, disconnectDb } from "@/lib/db";
import { EnvError } from "@/lib/env";
import { runExpiryReminders } from "@/lib/expiry-reminders";
import { RateLimitUnavailableError } from "@/lib/rate-limit";

const USAGE = `Usage:
  npm run cron:expiry [-- --dry-run]   count the customers due (default)
  npm run cron:expiry -- --send        send the reminders and the digest`;

/** Parsed command line. Exported for tests. */
export function parseCli(
  argv: string[],
): { send: boolean } | { error: string } | { help: true } {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "dry-run": { type: "boolean", default: false },
        send: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    return { error: `Unrecognised argument.\n${USAGE}` };
  }
  if (values.help) return { help: true };
  if (values.send && values["dry-run"]) {
    return { error: `Choose either --dry-run or --send.\n${USAGE}` };
  }
  return { send: values.send };
}

/* Our own error types carry safe messages; anything else shows its type. */
function reportFatal(error: unknown): void {
  const safe =
    error instanceof EnvError ||
    error instanceof DbConnectionError ||
    error instanceof RateLimitUnavailableError
      ? error.message
      : `${error instanceof Error ? error.name : "Unknown error"} (details withheld)`;
  console.error(`cron:expiry failed.\n${safe}`);
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
  try {
    await connectDb();
    if (!options.send) {
      const summary = await runExpiryReminders({ dryRun: true });
      console.log(
        `Dry run: ${summary.due} customer(s) due a reminder. Nothing was sent or written. Run with --send to send.`,
      );
      return 0;
    }
    // No request context in a CLI: background work just runs, errors dropped
    // (the user-field write used here schedules none).
    const auth = createAuth({
      runInBackground: (task) => void task.catch(() => {}),
    });
    const summary = await runExpiryReminders({
      accountContext: await auth.$context,
    });
    if (summary.status === "busy") {
      console.error("Another run is in progress. Nothing was sent.");
      return 1;
    }
    console.log(
      [
        `Run ${summary.status}. Due: ${summary.due}`,
        `sent: ${summary.sent}`,
        `failed: ${summary.failed}`,
        `sent but not marked: ${summary.markFailed}`,
        `stopped early: ${summary.truncated ? "yes" : "no"}`,
        `digest: ${summary.digest}`,
      ].join(", "),
    );
    return summary.status === "aborted" ||
      summary.failed > 0 ||
      summary.markFailed > 0
      ? 1
      : 0;
  } finally {
    await disconnectDb();
  }
}

// Run only as a CLI, not when a test imports parseCli.
if (process.argv[1] && /cron-expiry\.ts$/.test(process.argv[1])) {
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
