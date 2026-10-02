// Tests for src/models/whistleblower-case.ts (CLAUDE.md rule 7, ADR 0005): the
// schema has no field that could hold an IP, user agent or reporter identity,
// refuses unknown fields, and never loads the password hash by default.

import { describe, expect, it } from "vitest";

import type { Schema } from "mongoose";

import { mongoose } from "@/lib/db";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import {
  MAX_WB_ATTACHMENT_BYTES,
  MAX_WB_ATTACHMENTS,
  MAX_WB_CIPHERTEXT_CHARS,
  MAX_WB_MESSAGES,
  WhistleblowerCaseModel,
} from "./whistleblower-case";

interface SchemaPath {
  path: string;
  instance: string;
}

/* Every path in the schema, including those inside sub-documents and arrays. */
function allPaths(schema: Schema, prefix = ""): SchemaPath[] {
  const paths: SchemaPath[] = [];
  schema.eachPath((path, type) => {
    const full = `${prefix}${path}`;
    paths.push({ path: full, instance: type.instance });
    const sub = (type as unknown as { schema?: Schema }).schema;
    if (sub) paths.push(...allPaths(sub, `${full}.`));
  });
  return paths;
}

/* "messages.createdAt" -> ["messages", "created", "at"]. */
function words(path: string): string[] {
  return path
    .split(/[._$]+/)
    .flatMap((part) => part.split(/(?=[A-Z])/))
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

// Words that would point to a field identifying or locating the reporter.
const IDENTITY_WORDS = new Set([
  "ip",
  "ips",
  "ipaddress",
  "address",
  "agent",
  "ua",
  "user",
  "email",
  "mail",
  "phone",
  "mobile",
  "reporter",
  "identity",
  "contact",
  "country",
  "city",
  "geo",
  "location",
  "lat",
  "lng",
  "device",
  "browser",
  "fingerprint",
  "cookie",
  "session",
  "header",
  "headers",
  "referer",
  "referrer",
  // A deny-list of identity words, not a header read: the IP-header guard
  // (eslint.config.mjs) has nothing to protect here.
  // eslint-disable-next-line no-restricted-syntax
  "forwarded",
]);

// The complete list of stored paths. Adding a field must update this list,
// which forces a privacy review of the new field.
const ALLOWED_PATHS = [
  "__v",
  "_id",
  "attachments",
  "attachments.fileName",
  "attachments.mimeType",
  "attachments.size",
  "attachments.storageKey",
  "body",
  "body.ciphertext",
  "body.iv",
  "body.keyVersion",
  "body.tag",
  "caseNumber",
  "concernType",
  "createdAt",
  "messages",
  "messages.body",
  "messages.body.ciphertext",
  "messages.body.iv",
  "messages.body.keyVersion",
  "messages.body.tag",
  "messages.createdAt",
  "messages.from",
  "passwordHash",
  "relationship",
  "status",
  "updatedAt",
];

const encrypted = {
  ciphertext: "Y2lwaGVydGV4dA==",
  iv: "aXZpdml2aXZpdml2",
  tag: "dGFndGFndGFndGFndGFnZw==",
  keyVersion: 1,
};

function caseInput(overrides: Record<string, unknown> = {}) {
  return {
    caseNumber: `WB-${new mongoose.Types.ObjectId().toHexString().slice(-8)}`,
    passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
    body: encrypted,
    ...overrides,
  };
}

describe("whistleblower case privacy", () => {
  const paths = allPaths(WhistleblowerCaseModel.schema);

  it("stores exactly the reviewed fields", () => {
    // Array item placeholders ("attachments.$") are not stored fields.
    const stored = paths.map((p) => p.path).filter((p) => !p.includes("$"));
    expect([...new Set(stored)].sort()).toEqual(ALLOWED_PATHS);
  });

  it("has no path that could hold an IP, user agent or reporter identity", () => {
    const suspicious = paths.filter((p) =>
      words(p.path).some((word) => IDENTITY_WORDS.has(word)),
    );
    expect(suspicious).toEqual([]);
  });

  it("has no free-form (Mixed) field that could hold anything", () => {
    expect(paths.filter((p) => p.instance === "Mixed")).toEqual([]);
  });

  it("refuses unknown fields instead of storing them", async () => {
    expect(
      () => new WhistleblowerCaseModel(caseInput({ ip: "203.0.113.7" })),
    ).toThrow(mongoose.Error.StrictModeError);
    const withAgent = new WhistleblowerCaseModel(
      caseInput({
        messages: [
          { from: "reporter", body: encrypted, userAgent: "Mozilla/5.0" },
        ],
      }),
    );
    await expect(withAgent.validate()).rejects.toThrow(/StrictModeError/);
  });

  it("requires the encrypted body with a whole, positive key version", async () => {
    const missing = new WhistleblowerCaseModel(caseInput({ body: undefined }));
    await expect(missing.validate()).rejects.toThrow(/body/);

    const badVersion = new WhistleblowerCaseModel(
      caseInput({ body: { ...encrypted, keyVersion: 0 } }),
    );
    await expect(badVersion.validate()).rejects.toThrow(/keyVersion/);
  });

  it("only allows the received, under_review and closed statuses", async () => {
    const doc = new WhistleblowerCaseModel(caseInput({ status: "open" }));
    await expect(doc.validate()).rejects.toThrow(/status/);
    expect(new WhistleblowerCaseModel(caseInput()).status).toBe("received");
  });
});

describe("whistleblower case limits", () => {
  const attachment = {
    storageKey: "wb/3f2a9c1e-7b1d-4c55-9a77-0d6c2b8e4f10",
    fileName: "attachment-1.pdf",
    size: 1024,
    mimeType: "application/pdf",
  };

  it("accepts a neutral server-generated attachment", async () => {
    const doc = new WhistleblowerCaseModel(
      caseInput({ attachments: [attachment] }),
    );
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  // The reporter's own file name could identify them, so only
  // "attachment-<n>.<ext>" names are accepted.
  it.each(["J.Smith_expense_claims.pdf", "Scan_ACCT-LAPTOP-07.jpg", "x.pdf"])(
    "rejects the client file name %j",
    async (fileName) => {
      const doc = new WhistleblowerCaseModel(
        caseInput({ attachments: [{ ...attachment, fileName }] }),
      );
      await expect(doc.validate()).rejects.toThrow(/fileName/);
    },
  );

  it.each(["text/html", "image/svg+xml", "application/octet-stream"])(
    "rejects the attachment type %j",
    async (mimeType) => {
      const doc = new WhistleblowerCaseModel(
        caseInput({ attachments: [{ ...attachment, mimeType }] }),
      );
      await expect(doc.validate()).rejects.toThrow(/mimeType/);
    },
  );

  it("rejects an attachment over the size limit", async () => {
    const doc = new WhistleblowerCaseModel(
      caseInput({
        attachments: [{ ...attachment, size: MAX_WB_ATTACHMENT_BYTES + 1 }],
      }),
    );
    await expect(doc.validate()).rejects.toThrow(/size/);
  });

  it("caps attachments, messages and ciphertext length", async () => {
    const tooManyFiles = new WhistleblowerCaseModel(
      caseInput({
        attachments: Array.from({ length: MAX_WB_ATTACHMENTS + 1 }, (_, i) => ({
          ...attachment,
          fileName: `attachment-${i + 1}.pdf`,
        })),
      }),
    );
    await expect(tooManyFiles.validate()).rejects.toThrow(/attachments/);

    const tooManyMessages = new WhistleblowerCaseModel(
      caseInput({
        messages: Array.from({ length: MAX_WB_MESSAGES + 1 }, () => ({
          from: "reporter",
          body: encrypted,
        })),
      }),
    );
    await expect(tooManyMessages.validate()).rejects.toThrow(/messages/);

    const hugeBody = new WhistleblowerCaseModel(
      caseInput({
        body: {
          ...encrypted,
          ciphertext: "A".repeat(MAX_WB_CIPHERTEXT_CHARS + 1),
        },
      }),
    );
    await expect(hugeBody.validate()).rejects.toThrow(/ciphertext/);
  });
});

describe("whistleblower case storage", () => {
  setupMemoryDb("yg_whistleblower_test");

  it("does not load the password hash unless asked for", async () => {
    const { _id } = await WhistleblowerCaseModel.create(caseInput());

    const listed = await WhistleblowerCaseModel.findById(_id).lean();
    expect(listed).not.toHaveProperty("passwordHash");

    const withHash = await WhistleblowerCaseModel.findById(_id)
      .select("+passwordHash")
      .lean();
    expect(withHash?.passwordHash).toMatch(/^\$argon2id\$/);
  });
});
