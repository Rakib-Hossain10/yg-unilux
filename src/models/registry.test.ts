// Tests for src/models/index.ts: every model compiles, uses its exact
// collection name, and declares exactly the agreed indexes (ADR 0008,
// extended per phase). No database needed.

import { describe, expect, it } from "vitest";

import { allModels, indexedModels, UserModel, type RegisteredModel } from ".";

// model name -> collection name (CLAUDE.md: 11 collections + loginAttempts).
const EXPECTED_COLLECTIONS: Record<string, string> = {
  Product: "products",
  Category: "categories",
  Area: "areas",
  User: "users",
  AccessRequest: "accessRequests",
  DownloadLog: "downloadLogs",
  Datasheet: "datasheets",
  Leader: "leaders",
  SiteContent: "siteContent",
  WhistleblowerCase: "whistleblowerCases",
  AuditLog: "auditLog",
  LoginAttempt: "loginAttempts",
};

interface ExpectedIndex {
  key: Record<string, 1 | -1>;
  unique?: true;
  partialFilterExpression?: Record<string, unknown>;
  collation?: Record<string, unknown>;
  expireAfterSeconds?: number;
}

// The agreed index list, per model.
const EXPECTED_INDEXES: Record<string, ExpectedIndex[]> = {
  Product: [
    { key: { slug: 1 }, unique: true },
    {
      key: { "variants.modelNo": 1 },
      unique: true,
      partialFilterExpression: { "variants.modelNo": { $exists: true } },
      // Case-insensitive model nos. (ADR 0055).
      collation: { locale: "en", strength: 2 },
    },
    { key: { mainCategory: 1 } },
    { key: { extraCategories: 1 } },
    { key: { areas: 1 } },
    { key: { family: 1 } },
    { key: { status: 1 } },
    { key: { status: 1, mainCategory: 1 } },
    // Phase 2 (T2): datasheet in-use count and delete block.
    { key: { datasheetId: 1 } },
  ],
  Category: [
    { key: { parent: 1, slug: 1 }, unique: true },
    { key: { parent: 1, order: 1 } },
  ],
  Area: [{ key: { slug: 1 }, unique: true }],
  // Better Auth's indexes are created separately (task 5).
  User: [],
  AccessRequest: [{ key: { status: 1, createdAt: -1 } }],
  DownloadLog: [
    { key: { user: 1, downloadedAt: -1 } },
    { key: { product: 1, downloadedAt: -1 } },
  ],
  Datasheet: [{ key: { storageKey: 1 }, unique: true }],
  Leader: [],
  SiteContent: [{ key: { key: 1 }, unique: true }],
  WhistleblowerCase: [{ key: { caseNumber: 1 }, unique: true }],
  AuditLog: [{ key: { createdAt: -1 } }],
  LoginAttempt: [
    { key: { key: 1 }, unique: true },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ],
};

/* The schema's declared indexes, reduced to the options we care about. */
function declaredIndexes(model: RegisteredModel): ExpectedIndex[] {
  return model.schema.indexes().map(([key, options]) => {
    const index: ExpectedIndex = { key: key as ExpectedIndex["key"] };
    if (options.unique) index.unique = true;
    if (options.partialFilterExpression) {
      index.partialFilterExpression = options.partialFilterExpression as Record<
        string,
        unknown
      >;
    }
    if (options.collation) {
      index.collation = { ...options.collation } as Record<string, unknown>;
    }
    if (options.expireAfterSeconds !== undefined) {
      index.expireAfterSeconds = options.expireAfterSeconds;
    }
    return index;
  });
}

describe("model registry", () => {
  it("registers the 11 collections plus loginAttempts, each once", () => {
    const names = allModels.map((model) => model.modelName);
    expect(names.sort()).toEqual(Object.keys(EXPECTED_COLLECTIONS).sort());
  });

  it.each(Object.entries(EXPECTED_COLLECTIONS))(
    "%s uses the collection %s",
    (modelName, collection) => {
      const model = allModels.find((m) => m.modelName === modelName);
      expect(model?.collection.collectionName).toBe(collection);
    },
  );

  it.each(Object.keys(EXPECTED_INDEXES))(
    "%s declares exactly the agreed indexes",
    (modelName) => {
      const model = allModels.find((m) => m.modelName === modelName);
      if (!model) throw new Error(`no model ${modelName}`);
      expect(declaredIndexes(model)).toEqual(EXPECTED_INDEXES[modelName]);
    },
  );

  it("builds indexes for every model except the read-only users model", () => {
    expect(indexedModels).not.toContain(UserModel);
    expect(indexedModels).toHaveLength(allModels.length - 1);
  });
});
