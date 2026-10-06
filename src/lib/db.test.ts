// Tests for src/lib/db.ts: the one shared MongoDB client and Mongoose
// connection. Runs against a real in-memory MongoDB (mongodb-memory-server),
// which downloads a MongoDB binary the first time it runs on a machine.

import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  DbConnectionError,
  connectDb,
  disconnectDb,
  getDb,
  getMongoClient,
  mongoose,
} from "./db";
import { EnvError } from "./env";

// First run on a machine downloads the MongoDB binary (can take minutes);
// later runs start the server in about a second.
const SERVER_START_TIMEOUT_MS = 600_000;
// A failed connect waits for serverSelectionTimeoutMS (5 s) before giving up.
const FAILED_CONNECT_TIMEOUT_MS = 20_000;

const DB_NAME = "yg_db_test";
// Stands in for a real password; the tests check it never appears in errors.
const LEAK_MARKER = "leakmarker";

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
}, SERVER_START_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
});

afterEach(async () => {
  // Every test starts with no cached client and an unbound Mongoose connection.
  await disconnectDb();
  for (const name of mongoose.modelNames()) mongoose.deleteModel(name);
});

/** Points MONGODB_URI at the shared in-memory server. */
function useTestServer(): void {
  vi.stubEnv("MONGODB_URI", server.getUri(DB_NAME));
}

/** A free localhost port with nothing listening on it (a server that is "down"). */
async function unusedPort(): Promise<number> {
  const probe = await MongoMemoryServer.create();
  const port = probe.instanceInfo?.port;
  await probe.stop();
  if (port === undefined) throw new Error("probe server reported no port");
  return port;
}

describe("importing the module", () => {
  it("does not read env or open a connection", async () => {
    vi.stubEnv("MONGODB_URI", undefined);
    const connect = vi.spyOn(MongoClient.prototype, "connect");

    vi.resetModules();
    // Would throw EnvError if the module read MONGODB_URI at import time.
    await expect(import("./db")).resolves.toBeDefined();

    expect(connect).not.toHaveBeenCalled();
    expect(mongoose.connection.readyState).toBe(
      mongoose.ConnectionStates.disconnected,
    );
  });
});

describe("connectDb", () => {
  it("shares one connect across concurrent and repeated calls", async () => {
    useTestServer();
    const connect = vi.spyOn(MongoClient.prototype, "connect");

    const results = await Promise.all([connectDb(), connectDb(), connectDb()]);
    const again = await connectDb();

    expect(connect).toHaveBeenCalledTimes(1);
    for (const result of [...results, again]) expect(result).toBe(mongoose);
    expect(getMongoClient()).toBe(getMongoClient());
    expect(mongoose.connection.readyState).toBe(
      mongoose.ConnectionStates.connected,
    );
  });

  it("binds Mongoose to the same MongoClient and database as getMongoClient/getDb", async () => {
    useTestServer();
    await connectDb();

    expect(mongoose.connection.getClient()).toBe(getMongoClient());
    expect(getDb().databaseName).toBe(DB_NAME);
    expect(mongoose.connection.name).toBe(DB_NAME);

    // A write through Mongoose is visible through the raw driver Db.
    const Probe = mongoose.model(
      "SharedClientProbe",
      new mongoose.Schema({ label: String }),
    );
    await Probe.create({ label: "written by mongoose" });
    const raw = await getDb()
      .collection(Probe.collection.collectionName)
      .findOne({ label: "written by mongoose" });
    expect(raw).not.toBeNull();
  });

  it("reuses a client handed out earlier by getMongoClient (the Better Auth path)", async () => {
    useTestServer();
    const connect = vi.spyOn(MongoClient.prototype, "connect");

    // Handing out the client and Db does not touch the network.
    const client = getMongoClient();
    const db = getDb();
    expect(connect).not.toHaveBeenCalled();

    // The driver connects on its first operation...
    await db.collection("early").insertOne({ ok: true });
    // ...and connectDb then binds Mongoose to that same client.
    await connectDb();
    expect(mongoose.connection.getClient()).toBe(client);
  });

  it("refuses to open a second pool when Mongoose was connected some other way", async () => {
    useTestServer();
    // A stray mongoose.connect() opens its own MongoClient (ADR 0017 forbids it).
    await mongoose.connect(server.getUri(DB_NAME));
    try {
      await expect(connectDb()).rejects.toThrow(
        /already open on another client/,
      );
    } finally {
      await mongoose.connection.close();
    }
  });

  it("rejects with the EnvError from env.ts when MONGODB_URI is missing, then recovers", async () => {
    vi.stubEnv("MONGODB_URI", undefined);

    await expect(connectDb()).rejects.toBeInstanceOf(EnvError);
    expect(() => getMongoClient()).toThrow(EnvError);

    // The failed attempt is not cached: once configured, it connects.
    useTestServer();
    await expect(connectDb()).resolves.toBe(mongoose);
  });

  it(
    "fails fast when the server is unreachable, then retries with the same client",
    async () => {
      const port = await unusedPort();
      vi.stubEnv("MONGODB_URI", `mongodb://127.0.0.1:${port}/${DB_NAME}`);
      const client = getMongoClient();

      const started = Date.now();
      await expect(connectDb()).rejects.toBeInstanceOf(DbConnectionError);
      expect(Date.now() - started).toBeLessThan(10_000);

      // The server comes up on that port; the next call retries and succeeds.
      const revived = await MongoMemoryServer.create({ instance: { port } });
      try {
        await expect(connectDb()).resolves.toBe(mongoose);
        // Same client object, so a reference Better Auth took earlier stays valid.
        expect(getMongoClient()).toBe(client);
        expect(mongoose.connection.getClient()).toBe(client);
      } finally {
        await disconnectDb();
        await revived.stop();
      }
    },
    FAILED_CONNECT_TIMEOUT_MS + SERVER_START_TIMEOUT_MS,
  );
});

describe("errors never contain credentials", () => {
  /** Everything a logger might print for an error. */
  function printable(error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    return [error.message, error.stack ?? "", JSON.stringify(error)].join("\n");
  }

  it(
    "redacts the connection string when the connect fails",
    async () => {
      const port = await unusedPort();
      vi.stubEnv(
        "MONGODB_URI",
        `mongodb://yguser:${LEAK_MARKER}@127.0.0.1:${port}/${DB_NAME}`,
      );

      const error: unknown = await connectDb().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DbConnectionError);
      expect(printable(error)).not.toContain(LEAK_MARKER);
      expect((error as Error).cause).toBeUndefined();
    },
    FAILED_CONNECT_TIMEOUT_MS,
  );

  it("redacts connection strings and user:password pairs from any wrapped message", () => {
    const error = new DbConnectionError(
      "could not connect",
      new Error(
        `failed for mongodb+srv://yguser:${LEAK_MARKER}@cluster0.example.net/db and yguser:${LEAK_MARKER}@host`,
      ),
    );

    expect(printable(error)).not.toContain(LEAK_MARKER);
    expect(error.message).toContain("MongoDB: could not connect (Error)");
  });

  it("redacts the connection string when the driver cannot parse it", () => {
    // Passes env.ts's shape check, but the driver rejects the port.
    vi.stubEnv(
      "MONGODB_URI",
      `mongodb://yguser:${LEAK_MARKER}@db.example.com:notaport/${DB_NAME}`,
    );

    let error: unknown;
    try {
      getMongoClient();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(DbConnectionError);
    expect(printable(error)).not.toContain(LEAK_MARKER);
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("Mongoose settings applied by the module", () => {
  it("lets a model defined before connecting work after connectDb", async () => {
    // Models are compiled when their files are imported, before any request connects.
    const Item = mongoose.model(
      "EarlyModel",
      new mongoose.Schema({ slug: { type: String, unique: true } }),
    );

    useTestServer();
    await connectDb();
    await Item.create({ slug: "a" });

    // autoIndex is off: only _id exists until indexes are built explicitly.
    const before = await Item.collection.indexes();
    expect(before.map((index) => index.name)).toEqual(["_id_"]);
    await Item.createIndexes();
    const after = await Item.collection.indexes();
    expect(after.map((index) => index.name)).toContain("slug_1");
  });

  it("rejects a query on a path that is not in the schema (strictQuery: throw)", async () => {
    const Item = mongoose.model(
      "StrictModel",
      new mongoose.Schema({ slug: String }),
    );
    useTestServer();
    await connectDb();

    await expect(Item.find({ slgu: "typo" }).lean()).rejects.toThrow(
      /strictQuery/,
    );
  });

  it("compiles a model after connecting without building its indexes (autoIndex: false)", async () => {
    useTestServer();
    await connectDb();

    const Item = mongoose.model(
      "LateModel",
      new mongoose.Schema({ slug: { type: String, unique: true } }),
    );
    await Item.init();
    await Item.create({ slug: "a" });

    const indexes = await Item.collection.indexes();
    expect(indexes.map((index) => index.name)).toEqual(["_id_"]);
  });

  it("fails a query immediately instead of buffering when not connected", async () => {
    // A connection that has never opened, like the default one in a fresh
    // process. It inherits the global bufferCommands setting.
    const neverOpened = mongoose.createConnection();
    const Item = neverOpened.model(
      "UnbufferedModel",
      new mongoose.Schema({ slug: String }),
    );

    try {
      const started = Date.now();
      await expect(Item.findOne({ slug: "x" }).lean()).rejects.toThrow(
        /bufferCommands = false/,
      );
      // Buffering would have waited bufferTimeoutMS (10 s) first.
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await neverOpened.destroy();
    }
  });
});

describe("disconnectDb", () => {
  it("closes the client so the next connectDb starts a fresh one", async () => {
    useTestServer();
    await connectDb();
    const first = getMongoClient();

    await disconnectDb();
    expect(mongoose.connection.readyState).toBe(
      mongoose.ConnectionStates.disconnected,
    );

    await connectDb();
    expect(getMongoClient()).not.toBe(first);
    expect(mongoose.connection.getClient()).toBe(getMongoClient());
  });
});
