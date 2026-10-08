// Tests for `npm run db:search-index` (ADR 0066): the index definition holds
// public fields only, the create/update/no-op decision on a fake collection,
// the printed outcome, and the clear failure on a non-Atlas server (memory DB).

import { beforeEach, describe, expect, it } from "vitest";

import packageJson from "../package.json";
import { getDb } from "../src/lib/db";
import {
  decideSearchIndexAction,
  definitionContains,
  ensureProductSearchIndex,
  indexedPaths,
  PRODUCT_SEARCH_INDEX_DEFINITION,
  PRODUCT_SEARCH_INDEX_NAME,
  type SearchIndexCollection,
} from "../src/lib/catalog/search-index";
import { SPEC_KEYS } from "../src/models/spec-columns";
import { setupMemoryDb } from "../test/helpers/memory-db";

import { runSearchIndexSync } from "./search-index";

setupMemoryDb("yg_search_index_test");

/* A fake collection recording the calls; `listed` is what Atlas reports. */
function fakeCollection(listed: unknown[] | Error) {
  const calls: { op: string; args: unknown[] }[] = [];
  const collection: SearchIndexCollection = {
    listSearchIndexes: (name) => {
      calls.push({ op: "list", args: [name] });
      return {
        toArray: async () => {
          if (listed instanceof Error) throw listed;
          return listed;
        },
      };
    },
    createSearchIndex: async (description) => {
      calls.push({ op: "create", args: [description] });
      return description.name;
    },
    updateSearchIndex: async (name, definition) => {
      calls.push({ op: "update", args: [name, definition] });
    },
  };
  return { collection, calls };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("the index definition", () => {
  it("is the documented npm script", () => {
    expect(packageJson.scripts["db:search-index"]).toBe(
      "node --conditions=react-server --env-file-if-exists=.env.local --import tsx scripts/search-index.ts",
    );
  });

  it("indexes exactly the public search fields, dynamic off", () => {
    expect(indexedPaths()).toEqual([
      "family",
      "name",
      "status",
      "type",
      "variants.modelNo",
    ]);
    expect(PRODUCT_SEARCH_INDEX_DEFINITION.mappings.dynamic).toBe(false);
    expect(
      PRODUCT_SEARCH_INDEX_DEFINITION.mappings.fields.variants.dynamic,
    ).toBe(false);
  });

  it("holds no spec column, filter, label, datasheet or admin field", () => {
    const json = JSON.stringify(PRODUCT_SEARCH_INDEX_DEFINITION);
    for (const key of SPEC_KEYS) expect(json).not.toContain(`"${key}"`);
    expect(json).not.toMatch(
      /"(specs|filters|label|datasheetId|extraSpecs|description|featured)"/,
    );
  });

  it("maps model nos. case-insensitively as an exact string and as prefixes", () => {
    const modelNo =
      PRODUCT_SEARCH_INDEX_DEFINITION.mappings.fields.variants.fields.modelNo;
    expect(modelNo.map((field) => field.type)).toEqual([
      "string",
      "autocomplete",
    ]);
    expect(
      modelNo.every((field) => field.analyzer === "lowercaseKeyword"),
    ).toBe(true);
    expect(PRODUCT_SEARCH_INDEX_DEFINITION.analyzers).toEqual([
      {
        name: "lowercaseKeyword",
        tokenizer: { type: "keyword" },
        tokenFilters: [{ type: "lowercase" }],
      },
    ]);
  });
});

describe("decideSearchIndexAction", () => {
  const wanted = PRODUCT_SEARCH_INDEX_DEFINITION;

  it("creates when there is no index", () => {
    expect(decideSearchIndexAction(undefined, wanted)).toBe("create");
  });

  it("does nothing when the definition matches, even with Atlas defaults added", () => {
    const echoed = { ...clone(wanted), storedSource: false, numPartitions: 1 };
    expect(
      decideSearchIndexAction(
        { name: PRODUCT_SEARCH_INDEX_NAME, latestDefinition: echoed },
        wanted,
      ),
    ).toBe("noop");
  });

  it("updates when a field, analyzer or option differs or is missing", () => {
    const missingField = clone(wanted) as {
      mappings: { fields: Record<string, unknown> };
    };
    delete missingField.mappings.fields.status;
    const otherGrams = clone(wanted) as typeof missingField;
    (otherGrams.mappings.fields.name as { maxGrams?: number }[])[1]!.maxGrams =
      7;
    const dynamicOn = clone(wanted) as { mappings: { dynamic: boolean } };
    dynamicOn.mappings.dynamic = true;
    for (const latestDefinition of [
      missingField,
      otherGrams,
      dynamicOn,
      undefined,
      null,
    ]) {
      expect(
        decideSearchIndexAction(
          { name: PRODUCT_SEARCH_INDEX_NAME, latestDefinition },
          wanted,
        ),
      ).toBe("update");
    }
  });

  it("compares arrays by length and order", () => {
    expect(definitionContains([1, 2], [1, 2])).toBe(true);
    expect(definitionContains([1, 2, 3], [1, 2])).toBe(false);
    expect(definitionContains([2, 1], [1, 2])).toBe(false);
    expect(definitionContains({ a: [1] }, { a: 1 })).toBe(false);
  });
});

describe("ensureProductSearchIndex on a fake collection", () => {
  it("creates a missing index with the definition", async () => {
    const { collection, calls } = fakeCollection([]);
    expect(await ensureProductSearchIndex(collection)).toEqual({
      action: "create",
      name: PRODUCT_SEARCH_INDEX_NAME,
      status: undefined,
    });
    expect(calls).toEqual([
      { op: "list", args: [PRODUCT_SEARCH_INDEX_NAME] },
      {
        op: "create",
        args: [
          {
            name: PRODUCT_SEARCH_INDEX_NAME,
            type: "search",
            definition: PRODUCT_SEARCH_INDEX_DEFINITION,
          },
        ],
      },
    ]);
  });

  it("updates an index whose definition differs", async () => {
    const { collection, calls } = fakeCollection([
      {
        name: PRODUCT_SEARCH_INDEX_NAME,
        status: "READY",
        latestDefinition: { mappings: { dynamic: true } },
      },
    ]);
    const result = await ensureProductSearchIndex(collection);
    expect(result.action).toBe("update");
    expect(calls.map((call) => call.op)).toEqual(["list", "update"]);
    expect(calls[1]?.args).toEqual([
      PRODUCT_SEARCH_INDEX_NAME,
      PRODUCT_SEARCH_INDEX_DEFINITION,
    ]);
  });

  it("does nothing when the index is up to date", async () => {
    const { collection, calls } = fakeCollection([
      {
        name: PRODUCT_SEARCH_INDEX_NAME,
        status: "READY",
        latestDefinition: clone(PRODUCT_SEARCH_INDEX_DEFINITION),
      },
    ]);
    expect(await ensureProductSearchIndex(collection)).toEqual({
      action: "noop",
      name: PRODUCT_SEARCH_INDEX_NAME,
      status: "READY",
    });
    expect(calls.map((call) => call.op)).toEqual(["list"]);
  });

  it("ignores entries with another name", async () => {
    const { collection, calls } = fakeCollection([
      {
        name: "other",
        latestDefinition: clone(PRODUCT_SEARCH_INDEX_DEFINITION),
      },
    ]);
    expect((await ensureProductSearchIndex(collection)).action).toBe("create");
    expect(calls.map((call) => call.op)).toEqual(["list", "create"]);
  });
});

describe("runSearchIndexSync", () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
  });
  const log = (line: string) => lines.push(line);

  it("prints what it did and exits 0", async () => {
    const { collection } = fakeCollection([]);
    expect(await runSearchIndexSync(collection, log)).toBe(0);
    expect(lines.join("\n")).toMatch(/Created search index "products_search"/);
    expect(lines[0]).toContain("family, name, status, type, variants.modelNo");
  });

  it("prints 'up to date' for a no-op", async () => {
    const { collection } = fakeCollection([
      {
        name: PRODUCT_SEARCH_INDEX_NAME,
        status: "READY",
        latestDefinition: clone(PRODUCT_SEARCH_INDEX_DEFINITION),
      },
    ]);
    expect(await runSearchIndexSync(collection, log)).toBe(0);
    expect(lines.join("\n")).toMatch(/up to date \(status: READY\)/);
  });

  it("fails with a clear message on a non-Atlas server (the memory DB)", async () => {
    const collection = getDb().collection("products");
    expect(await runSearchIndexSync(collection, log)).toBe(1);
    expect(lines.join("\n")).toMatch(
      /cannot list Atlas Search indexes .*Point MONGODB_URI at an Atlas cluster/,
    );
  });

  it("withholds driver messages on other failures", async () => {
    const { collection } = fakeCollection([]);
    collection.createSearchIndex = async () => {
      throw new Error("secret detail from the server");
    };
    expect(await runSearchIndexSync(collection, log)).toBe(1);
    expect(lines.join("\n")).toMatch(/details withheld/);
    expect(lines.join("\n")).not.toContain("secret detail");
  });
});
