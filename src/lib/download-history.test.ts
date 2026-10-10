// Tests for the /my-downloads reader on an in-memory MongoDB: only the user's
// own entries, newest first, 20 per page with stable ties, a page past the
// end shows the last page, deleted/draft products and deleted files are
// reported gracefully, and nothing but the projected fields is read.

import { Types } from "mongoose";
import { beforeEach, describe, expect, it } from "vitest";

import { setupMemoryDb } from "../../test/helpers/memory-db";
import { DatasheetModel, DownloadLogModel, ProductModel } from "@/models";

import {
  DOWNLOAD_HISTORY_PAGE_SIZE,
  getDownloadHistory,
  historyPageSchema,
} from "./download-history";

setupMemoryDb("download-history");

const me = new Types.ObjectId();
const someoneElse = new Types.ObjectId();
const sheet = new Types.ObjectId();
const goneSheet = new Types.ObjectId();
const published = new Types.ObjectId();
const draft = new Types.ObjectId();
const noSheet = new Types.ObjectId();
const deleted = new Types.ObjectId();

const base = new Date("2026-10-01T10:00:00.000Z");
const minutes = (n: number) => new Date(base.getTime() + n * 60_000);

/* Raw inserts: the reader must cope with whatever is stored. */
async function seedCatalog(): Promise<void> {
  await ProductModel.collection.insertMany([
    {
      _id: published,
      name: "Arc",
      family: "Arc",
      modelCode: "AR-013A",
      slug: "arc-ar-013a",
      status: "published",
      datasheetId: sheet,
      // Must never come back from the reader.
      specs: { driver: "Secret Driver Co" },
    },
    {
      _id: draft,
      name: "Halo",
      family: "",
      slug: "halo-ha-1",
      status: "draft",
      datasheetId: sheet,
    },
    {
      _id: noSheet,
      name: "Dot",
      slug: "dot-d-1",
      status: "published",
      datasheetId: null,
    },
  ]);
  await DatasheetModel.collection.insertOne({
    _id: sheet,
    fileName: "Arc family.xlsx",
    storageKey: "datasheets/secret-key.xlsx",
  });
}

beforeEach(async () => {
  await Promise.all([
    ProductModel.collection.deleteMany({}),
    DatasheetModel.collection.deleteMany({}),
    DownloadLogModel.collection.deleteMany({}),
  ]);
  await seedCatalog();
});

describe("historyPageSchema", () => {
  it("accepts whole page numbers and falls back to 1", () => {
    expect(historyPageSchema.parse("1")).toBe(1);
    expect(historyPageSchema.parse("37")).toBe(37);
    expect(historyPageSchema.parse("1000")).toBe(1000);
    for (const raw of [
      undefined,
      "",
      "0",
      "-1",
      "2.5",
      "1e3",
      "abc",
      "01",
      "1001",
      "99999",
      ["2", "3"],
    ]) {
      expect(historyPageSchema.parse(raw)).toBe(1);
    }
  });
});

describe("getDownloadHistory", () => {
  it("is empty for a user with no downloads, or an invalid id", async () => {
    expect(await getDownloadHistory(String(me), 1)).toEqual({
      rows: [],
      page: 1,
      pageCount: 1,
      total: 0,
    });
    expect(await getDownloadHistory("not-an-id", 1)).toMatchObject({
      total: 0,
    });
    expect(await getDownloadHistory("aaaaaaaaaaaa", 1)).toMatchObject({
      total: 0,
    });
  });

  it("lists only the user's own entries, newest first, with product and file", async () => {
    await DownloadLogModel.create([
      {
        user: me,
        product: published,
        datasheet: sheet,
        downloadedAt: minutes(1),
      },
      { user: me, product: draft, datasheet: sheet, downloadedAt: minutes(3) },
      {
        user: someoneElse,
        product: published,
        datasheet: sheet,
        downloadedAt: minutes(5),
      },
      {
        user: me,
        product: deleted,
        datasheet: goneSheet,
        downloadedAt: minutes(2),
      },
      {
        user: me,
        product: noSheet,
        datasheet: sheet,
        downloadedAt: minutes(4),
      },
    ]);

    const result = await getDownloadHistory(String(me), 1);
    expect(result.total).toBe(4);
    expect(result.pageCount).toBe(1);
    expect(result.rows.map((row) => row.downloadedAt)).toEqual([
      minutes(4),
      minutes(3),
      minutes(2),
      minutes(1),
    ]);

    const [dot, halo, gone, arc] = result.rows;
    expect(arc?.product).toEqual({
      id: String(published),
      name: "Arc",
      family: "Arc",
      modelCode: "AR-013A",
      slug: "arc-ar-013a",
      listed: true,
      downloadable: true,
    });
    expect(arc?.fileName).toBe("Arc family.xlsx");
    // A draft is shown by name, without a link or a download.
    expect(halo?.product).toMatchObject({
      listed: false,
      downloadable: false,
      family: null,
      modelCode: null,
    });
    // Published but no datasheet attached any more.
    expect(dot?.product).toMatchObject({ listed: true, downloadable: false });
    // Deleted product and deleted file.
    expect(gone?.product).toBeNull();
    expect(gone?.fileName).toBeNull();

    // Nothing beyond the projection: no spec value, no storage key.
    const json = JSON.stringify(result);
    expect(json).not.toContain("Secret Driver Co");
    expect(json).not.toContain("secret-key");
  });

  it("pages by 20 with stable ties, and clamps a page past the end", async () => {
    const count = DOWNLOAD_HISTORY_PAGE_SIZE * 2 + 5;
    // Pairs share a timestamp, so the _id tie-break matters.
    await DownloadLogModel.insertMany(
      Array.from({ length: count }, (_, i) => ({
        user: me,
        product: published,
        datasheet: sheet,
        downloadedAt: minutes(Math.floor(i / 2)),
      })),
    );

    const pages = await Promise.all(
      [1, 2, 3].map((page) => getDownloadHistory(String(me), page)),
    );
    expect(pages.map((p) => p.rows.length)).toEqual([20, 20, 5]);
    expect(pages.every((p) => p.pageCount === 3 && p.total === count)).toBe(
      true,
    );
    const ids = pages.flatMap((p) => p.rows.map((row) => row.id));
    expect(new Set(ids).size).toBe(count);
    const times = pages.flatMap((p) =>
      p.rows.map((row) => row.downloadedAt.getTime()),
    );
    expect(times).toEqual([...times].sort((a, b) => b - a));

    const past = await getDownloadHistory(String(me), 9);
    expect(past.page).toBe(3);
    expect(past.rows.map((row) => row.id)).toEqual(
      pages[2]?.rows.map((row) => row.id),
    );
  });
});
