// End-to-end test of `npm run db:indexes` (scripts/sync-indexes.ts): runs the
// exact command from package.json against an in-memory MongoDB. It runs in a
// throwaway folder with its own fake .env.local, so the real one is never read.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import packageJson from "../package.json";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DB_NAME = "yg_cli_test";
// Starting tsx and compiling the models takes a few seconds per run.
const RUN_TIMEOUT_MS = 60_000;
const SERVER_START_TIMEOUT_MS = 600_000;

const COLLECTIONS = [
  "products",
  "categories",
  "areas",
  "accessRequests",
  "downloadLogs",
  "datasheets",
  "leaders",
  "siteContent",
  "whistleblowerCases",
  "auditLog",
  "loginAttempts",
];

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/*
 * The npm script's node arguments, with the script path made absolute so the
 * command can run from another folder. Node and tsx still find tsconfig.json
 * and node_modules by walking up from that folder (it is inside the repo).
 */
function commandArgs(): string[] {
  const [program, ...args] = packageJson.scripts["db:indexes"].split(" ");
  if (program !== "node") throw new Error("db:indexes must start with node");
  return args.map((arg) =>
    arg.endsWith(".ts") ? path.join(REPO_ROOT, arg) : arg,
  );
}

/* Runs node with the given args in `cwd`, never with the caller's MONGODB_URI. */
function runNode(args: string[], cwd: string): Promise<RunResult> {
  const env = { ...process.env };
  delete env.MONGODB_URI;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let server: MongoMemoryServer;
let workDir: string;
let emptyDir: string;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  // Inside the repo (so node_modules and tsconfig.json are found) but
  // gitignored, and away from the real .env.local at the repo root.
  const cacheDir = path.join(REPO_ROOT, "node_modules", ".cache");
  workDir = await mkdtemp(path.join(cacheDir, "sync-indexes-"));
  emptyDir = await mkdtemp(path.join(cacheDir, "sync-indexes-empty-"));
  await writeFile(
    path.join(workDir, ".env.local"),
    `MONGODB_URI=${server.getUri(DB_NAME)}\n`,
  );
}, SERVER_START_TIMEOUT_MS);

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
  await rm(emptyDir, { recursive: true, force: true });
  await server.stop();
});

describe("npm run db:indexes", () => {
  it("is the documented command", () => {
    expect(packageJson.scripts["db:indexes"]).toBe(
      "node --conditions=react-server --env-file-if-exists=.env.local --import tsx scripts/sync-indexes.ts",
    );
  });

  it(
    "reads MONGODB_URI from .env.local and builds every collection's indexes",
    async () => {
      const result = await runNode(commandArgs(), workDir);

      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        `Building indexes in database "${DB_NAME}"`,
      );
      for (const collection of COLLECTIONS) {
        expect(result.stdout).toMatch(new RegExp(`ok\\s+${collection}\\s`));
      }
      expect(result.stdout).toContain("Done: 11 of 11 collections ok.");

      // The indexes really exist in the in-memory database.
      const client = await MongoClient.connect(server.getUri());
      try {
        const indexes = await client
          .db(DB_NAME)
          .collection("products")
          .indexes();
        expect(indexes.map((index) => index.name)).toEqual(
          expect.arrayContaining(["slug_1", "variants.modelNo_1"]),
        );
      } finally {
        await client.close();
      }
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "needs --conditions=react-server, because db.ts imports server-only",
    async () => {
      const args = commandArgs().filter(
        (arg) => arg !== "--conditions=react-server",
      );
      const result = await runNode(args, workDir);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("server-only");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "fails clearly, without printing any URI, when MONGODB_URI is not configured",
    async () => {
      const result = await runNode(commandArgs(), emptyDir);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("MONGODB_URI: missing");
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/mongodb:\/\//);
    },
    RUN_TIMEOUT_MS,
  );
});
