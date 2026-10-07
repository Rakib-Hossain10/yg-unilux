// Pure helpers of the datasheets UI (T13): the pre-upload checks, the PUT with
// exactly the returned headers, and the list search and paging.

import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_DATASHEET_BYTES } from "@/lib/constants";

import { checkDatasheetFile, putDatasheet } from "./datasheet-upload";
import {
  DATASHEETS_PAGE_SIZE,
  datasheetsListPath,
  pageDatasheets,
} from "./datasheet-paths";

describe("checkDatasheetFile", () => {
  it("accepts an .xlsx within the limit, any letter case", () => {
    expect(checkDatasheetFile({ name: "Family.XLSX", size: 10 })).toBeNull();
    expect(
      checkDatasheetFile({ name: "a.xlsx", size: MAX_DATASHEET_BYTES }),
    ).toBeNull();
  });

  it.each([
    ["family.xls", 10],
    ["family.csv", 10],
    [".xlsx", 10],
    ["family.xlsx.zip", 10],
  ])("refuses %s", (name, size) => {
    expect(checkDatasheetFile({ name, size })).toMatch(/not an Excel/);
  });

  it("refuses an empty and an oversized file with the limit in the text", () => {
    expect(checkDatasheetFile({ name: "a.xlsx", size: 0 })).toMatch(/empty/);
    expect(
      checkDatasheetFile({ name: "a.xlsx", size: MAX_DATASHEET_BYTES + 1 }),
    ).toMatch(/limit is 10 MB/);
  });
});

describe("putDatasheet", () => {
  const sent: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }[] = [];
  let status = 200;

  class FakeXhr {
    upload: { onprogress: ((e: unknown) => void) | null } = {
      onprogress: null,
    };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    private record = {
      method: "",
      url: "",
      headers: {} as Record<string, string>,
      body: undefined as unknown,
    };
    open(method: string, url: string) {
      this.record.method = method;
      this.record.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.record.headers[name] = value;
    }
    send(body: unknown) {
      this.record.body = body;
      sent.push(this.record);
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
      this.status = status;
      this.onload?.();
    }
    abort() {
      this.onabort?.();
    }
  }

  afterEach(() => {
    sent.length = 0;
    status = 200;
    vi.unstubAllGlobals();
  });

  const ticket = {
    uploadUrl: "https://r2.test/incoming/x.xlsx?sig=1",
    headers: { "Content-Type": "application/test-type" } as const,
    incomingKey: "incoming/x.xlsx",
    expiresIn: 300,
  };

  it("PUTs the raw file with exactly the returned headers and reports progress", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const file = new Blob(["abc"]);
    const percents: number[] = [];
    const outcome = await putDatasheet(ticket, file, (p) => percents.push(p));
    expect(outcome).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "PUT",
      url: ticket.uploadUrl,
      headers: { "Content-Type": "application/test-type" },
    });
    expect(Object.keys(sent[0]!.headers)).toEqual(["Content-Type"]);
    expect(sent[0]!.body).toBe(file);
    expect(percents).toEqual([50]);
  });

  it("a non-2xx answer is a failure that shows no URL", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    status = 403;
    const outcome = await putDatasheet(ticket, new Blob(["a"]), () => {});
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("r2.test");
  });

  it("an already aborted signal sends nothing", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const controller = new AbortController();
    controller.abort();
    const outcome = await putDatasheet(
      ticket,
      new Blob(["a"]),
      () => {},
      controller.signal,
    );
    expect(outcome.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("pageDatasheets", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    fileName: `Sheet-${i}.xlsx`,
  }));

  it("pages 25 at a time and clamps the page", () => {
    const first = pageDatasheets(rows, { q: "", page: 1 });
    expect(first.rows).toHaveLength(DATASHEETS_PAGE_SIZE);
    expect(first.pageCount).toBe(3);
    expect(pageDatasheets(rows, { q: "", page: 99 }).page).toBe(3);
    expect(pageDatasheets(rows, { q: "", page: -4 }).page).toBe(1);
  });

  it("searches the file name without case", () => {
    const hit = pageDatasheets(rows, { q: "sHeEt-5.x", page: 1 });
    expect(hit.rows.map((r) => r.fileName)).toEqual(["Sheet-5.xlsx"]);
    expect(pageDatasheets(rows, { q: "nope", page: 1 }).total).toBe(0);
  });

  it("builds list URLs without default params", () => {
    expect(datasheetsListPath({ q: "", page: 1 })).toBe("/admin/datasheets");
    expect(datasheetsListPath({ q: "a b", page: 2 })).toBe(
      "/admin/datasheets?q=a+b&page=2",
    );
  });
});
