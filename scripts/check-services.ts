// CLI: `npm run check:services`. Checks that the MongoDB, Cloudinary and R2
// values in .env.local really work, and prints only PASS/FAIL per service.
// Secret values are never printed: error text is scrubbed of every secret.

import process from "node:process";

import {
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { v2 as cloudinary } from "cloudinary";

import { connectDb, disconnectDb, getDb } from "@/lib/db";
import { env } from "@/lib/env";

/* Replaces any secret that shows up inside an error message. */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("***");
  }
  // A connection string's user:password part, in case it is quoted whole.
  return out.replace(/(\w+(?:\+\w+)?:\/\/)[^@\s/]+@/g, "$1***@");
}

function describe(error: unknown, secrets: string[]): string {
  if (error instanceof Error) {
    return scrub(`${error.name}: ${error.message}`, secrets);
  }
  return scrub(JSON.stringify(error) ?? "unknown error", secrets);
}

type Check = {
  name: string;
  run: () => Promise<string>;
  secrets: () => string[];
};

const checks: Check[] = [
  {
    name: "MongoDB",
    secrets: () => {
      const { uri } = env.mongo();
      try {
        const u = new URL(uri);
        return [decodeURIComponent(u.password), u.password, u.username];
      } catch {
        return [uri];
      }
    },
    async run() {
      await connectDb();
      try {
        const db = getDb();
        await db.command({ ping: 1 });
        return `connected, ping ok, database "${db.databaseName}"`;
      } finally {
        await disconnectDb();
      }
    },
  },
  {
    name: "Cloudinary",
    secrets: () => {
      const c = env.cloudinary();
      return [c.apiKey, c.apiSecret];
    },
    async run() {
      const c = env.cloudinary();
      cloudinary.config({
        cloud_name: c.cloudName,
        api_key: c.apiKey,
        api_secret: c.apiSecret,
        secure: true,
      });
      // The app signs uploads (the Upload API), so test that first: a tiny
      // 1x1 PNG, uploaded and deleted. Keys limited to upload permissions
      // are refused by the Admin API (usage), so that call is only a note.
      const png =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
      const upload = await cloudinary.uploader.upload(png, {
        folder: "_connection-check",
        public_id: `check-${Date.now()}`,
      });
      await cloudinary.uploader.destroy(upload.public_id);
      let admin = "Admin API (usage) ok";
      try {
        await cloudinary.api.usage();
      } catch {
        admin =
          "Admin API (usage) refused: this key lacks Admin API permissions (not needed for uploads)";
      }
      return `upload and delete ok; ${admin}`;
    },
  },
  {
    name: "R2",
    secrets: () => {
      const r = env.r2();
      return [r.accessKeyId, r.secretAccessKey, r.accountId];
    },
    async run() {
      const r = env.r2();
      const client = new S3Client({
        region: "auto",
        endpoint: `https://${r.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: r.accessKeyId,
          secretAccessKey: r.secretAccessKey,
        },
      });
      try {
        await client.send(new HeadBucketCommand({ Bucket: r.bucket }));
        // A tiny write + delete proves the token can write, not just read.
        const Key = `_connection-check/${Date.now()}.txt`;
        await client.send(
          new PutObjectCommand({ Bucket: r.bucket, Key, Body: "ok" }),
        );
        await client.send(new DeleteObjectCommand({ Bucket: r.bucket, Key }));
        return "bucket reachable, test object written and deleted";
      } finally {
        client.destroy();
      }
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const check of checks) {
    let secrets: string[] = [];
    try {
      secrets = check.secrets();
      console.log(`PASS  ${check.name}: ${await check.run()}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL  ${check.name}: ${describe(error, secrets)}`);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

void main();
