// Tests for `npm run db:search-index` (ADR 0066): the index definition holds
// public fields only, the create/update/no-op decision on a fake collection,
// the printed outcome, and the clear failure on a non-Atlas server (memory DB).

import { beforeEach, describe, expect, it } from "vitest";

import packageJson from "../package.json";
import { getDb } from "../src/lib/db";
import {
  decideSearchIndexAction,
  definitionContains,
  describeSearchIndexStatus,
  ensureProductSearchIndex,
  indexedPaths,
  PRODUCT_SEARCH_INDEX_DEFINITION,
  PRODUCT_SEARCH_INDEX_NAME,
  searchIndexHealth,
  type SearchIndexCollection,
} from "../src/lib/catalog/search-index";
import { SPEC_KEYS } from "../src/models/spec-columns";
import { setupMemoryDb } from "../test/helpers/memory-db";

import {
  DEFAULT_WAIT_TIMEOUT_MS,
  describeSearchIndexOutcome,
  parseSearchIndexArgs,
  runSearchIndexSync,
} from "./search-index";

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

// ---------------------------------------------------------------------------
// Gate-A L-3: index status -> message and exit code
// ---------------------------------------------------------------------------

/* A fake whose listing answers come from `answers` in turn (last one repeats). */
function sequenceCollection(answers: unknown[][]) {
  let call = 0;
  const { collection } = fakeCollection([]);
  collection.listSearchIndexes = () => ({
    toArray: async () => {
      const answer = answers[Math.min(call, answers.length - 1)] ?? [];
      call += 1;
      return answer;
    },
  });
  return { collection, listings: () => call };
}

const indexWith = (status: string, extra: Record<string, unknown> = {}) => [
  {
    name: PRODUCT_SEARCH_INDEX_NAME,
    status,
    latestDefinition: clone(PRODUCT_SEARCH_INDEX_DEFINITION),
    ...extra,
  },
];

describe("search index status mapping", () => {
  it.each([
    ["READY", undefined, "ready", 0],
    ["ready", undefined, "ready", 0],
    ["FAILED", undefined, "failed", 1],
    ["failed", undefined, "failed", 1],
    ["DOES_NOT_EXIST", undefined, "failed", 1],
    ["DELETING", undefined, "failed", 1],
    ["PENDING", undefined, "building", 0],
    ["BUILDING", undefined, "building", 0],
    ["BUILDING", false, "building", 0],
    ["BUILDING", true, "serving", 0],
    ["PENDING", true, "serving", 0],
    ["STALE", true, "serving", 0],
    ["SOMETHING_NEW", undefined, "building", 0],
  ] as const)(
    "%s (queryable %s) -> %s, exit %i",
    (status, queryable, health, exitCode) => {
      const state = { status, queryable };
      expect(searchIndexHealth(state)).toBe(health);
      expect(describeSearchIndexStatus(state).exitCode).toBe(exitCode);
    },
  );

  it("a --wait that runs out exits 1 for a building AND a serving index", () => {
    for (const state of [
      { status: "BUILDING" },
      { status: "BUILDING", queryable: true },
    ]) {
      const report = describeSearchIndexStatus(state, { waitedOut: true });
      expect(report.exitCode).toBe(1);
      expect(report.message).toMatch(/^ERROR: timed out waiting; /);
    }
  });

  it("an index not listed yet (right after a create) is building, exit 0", () => {
    expect(searchIndexHealth(undefined)).toBe("building");
    const report = describeSearchIndexStatus(undefined);
    expect(report.exitCode).toBe(0);
    expect(report.message).toMatch(/not listed yet/);
  });

  it("PENDING/BUILDING warn that Atlas returns NO results (not the regex fallback)", () => {
    for (const status of ["PENDING", "BUILDING"]) {
      const { message } = describeSearchIndexStatus({ status });
      expect(message).toMatch(/^WARNING: /);
      expect(message).toContain(status);
      expect(message).toMatch(/NO results/);
      expect(message).toMatch(/--wait/);
      expect(message).not.toMatch(/uses the regex fallback until/);
    }
  });

  it("FAILED is an error with what to do next", () => {
    const { message } = describeSearchIndexStatus({ status: "FAILED" });
    expect(message).toMatch(/^ERROR: .*FAILED.*Atlas UI/);
  });

  it("a wait that runs out while building exits 1", () => {
    const report = describeSearchIndexStatus(
      { status: "BUILDING" },
      { waitedOut: true },
    );
    expect(report.exitCode).toBe(1);
    expect(report.message).toMatch(/^ERROR: timed out/);
  });

  it("the create message no longer promises the regex fallback (ADR 0066)", () => {
    const line = describeSearchIndexOutcome(
      "create",
      "products_search",
      undefined,
    );
    expect(line).not.toMatch(/regex fallback/);
    expect(line).toMatch(/returns no results/);
  });
});

describe("runSearchIndexSync status handling", () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
  });
  const log = (line: string) => lines.push(line);

  it("exits 1 when the (up-to-date) index is FAILED", async () => {
    const { collection } = fakeCollection(indexWith("FAILED"));
    expect(await runSearchIndexSync(collection, log)).toBe(1);
    expect(lines.join("\n")).toMatch(
      /ERROR: search index "products_search" is FAILED/,
    );
  });

  it("exits 0 with a warning when the index is BUILDING", async () => {
    const { collection } = fakeCollection(indexWith("BUILDING"));
    expect(await runSearchIndexSync(collection, log)).toBe(0);
    expect(lines.at(-1)).toMatch(/^WARNING: .*BUILDING.*NO results/);
  });

  it("re-reads the status after a create (pending -> warning)", async () => {
    const { collection, listings } = sequenceCollection([
      [],
      indexWith("PENDING"),
    ]);
    expect(await runSearchIndexSync(collection, log)).toBe(0);
    expect(listings()).toBe(2);
    expect(lines.at(-1)).toMatch(/PENDING/);
  });

  it("--wait polls until READY and exits 0", async () => {
    const { collection, listings } = sequenceCollection([
      [],
      indexWith("PENDING"),
      indexWith("BUILDING"),
      indexWith("READY"),
    ]);
    const sleeps: number[] = [];
    const code = await runSearchIndexSync(collection, log, {
      wait: true,
      timeoutMs: 60_000,
      intervalMs: 1000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 0,
    });
    expect(code).toBe(0);
    expect(listings()).toBe(4);
    expect(sleeps).toEqual([1000, 1000]);
    expect(lines.at(-1)).toMatch(/is READY/);
  });

  it("--wait stops at FAILED with exit 1", async () => {
    const { collection } = sequenceCollection([
      [],
      indexWith("BUILDING"),
      indexWith("FAILED"),
    ]);
    const code = await runSearchIndexSync(collection, log, {
      wait: true,
      timeoutMs: 60_000,
      intervalMs: 1,
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(code).toBe(1);
    expect(lines.at(-1)).toMatch(/FAILED/);
  });

  it("--wait times out (fake clock) with exit 1", async () => {
    const { collection } = sequenceCollection([[], indexWith("BUILDING")]);
    let clock = 0;
    const code = await runSearchIndexSync(collection, log, {
      wait: true,
      timeoutMs: 5000,
      intervalMs: 1000,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(code).toBe(1);
    expect(clock).toBe(5000);
    expect(lines.at(-1)).toMatch(/^ERROR: timed out/);
  });
});

describe("parseSearchIndexArgs", () => {
  it("reads --wait and a bounded --timeout in seconds", () => {
    expect(parseSearchIndexArgs([])).toEqual({
      wait: false,
      timeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
    });
    expect(parseSearchIndexArgs(["--wait", "--timeout=120"])).toEqual({
      wait: true,
      timeoutMs: 120_000,
    });
    for (const bad of [
      "--timeout=0",
      "--timeout=99999",
      "--timeout=-5",
      "--timeout=1e3",
    ]) {
      expect(parseSearchIndexArgs(["--wait", bad]).timeoutMs).toBe(
        DEFAULT_WAIT_TIMEOUT_MS,
      );
    }
  });
});
