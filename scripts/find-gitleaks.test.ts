import path from "node:path";
import { describe, expect, it } from "vitest";

import { findGitleaks } from "./find-gitleaks.mjs";

const win = path.win32;
const LOCAL = "C:\\Users\\dev\\AppData\\Local";
const WINGET_PKG = win.join(
  LOCAL,
  "Microsoft",
  "WinGet",
  "Packages",
  "Gitleaks.Gitleaks_Microsoft.Winget.Source_8wekyb3d8bbwe",
);

/** Fake filesystem: a set of existing files and the directory listings we allow. */
function fakeFs(files: string[], dirs: Record<string, string[]> = {}) {
  const fileSet = new Set(files);
  return {
    isFile: (p: string) => fileSet.has(p),
    readdir: (p: string) => {
      const entries = dirs[p];
      if (!entries)
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return entries;
    },
  };
}

describe("findGitleaks", () => {
  it("prefers an explicit GITLEAKS_BIN that exists", () => {
    const result = findGitleaks({
      env: { GITLEAKS_BIN: "/opt/gl/gitleaks", PATH: "/usr/bin" },
      platform: "linux",
      ...fakeFs(["/opt/gl/gitleaks", "/usr/bin/gitleaks"]),
    });
    expect(result).toBe("/opt/gl/gitleaks");
  });

  it("finds gitleaks on PATH (posix)", () => {
    const result = findGitleaks({
      env: { PATH: "/usr/local/bin:/opt/homebrew/bin" },
      platform: "darwin",
      ...fakeFs(["/opt/homebrew/bin/gitleaks"]),
    });
    expect(result).toBe(path.posix.join("/opt/homebrew/bin", "gitleaks"));
  });

  it("finds gitleaks.exe on PATH (windows)", () => {
    const result = findGitleaks({
      env: { Path: "C:\\Windows;C:\\tools", LOCALAPPDATA: LOCAL },
      platform: "win32",
      ...fakeFs([win.join("C:\\tools", "gitleaks.exe")]),
    });
    expect(result).toBe(win.join("C:\\tools", "gitleaks.exe"));
  });

  it("falls back to the winget package folder when PATH has no gitleaks", () => {
    const packages = win.join(LOCAL, "Microsoft", "WinGet", "Packages");
    const result = findGitleaks({
      env: { Path: "C:\\Windows", LOCALAPPDATA: LOCAL },
      platform: "win32",
      ...fakeFs([win.join(WINGET_PKG, "gitleaks.exe")], {
        [packages]: [
          "Other.Tool_x",
          "Gitleaks.Gitleaks_Microsoft.Winget.Source_8wekyb3d8bbwe",
        ],
      }),
    });
    expect(result).toBe(win.join(WINGET_PKG, "gitleaks.exe"));
  });

  it("returns null when gitleaks is nowhere", () => {
    const result = findGitleaks({
      env: { Path: "C:\\Windows", LOCALAPPDATA: LOCAL },
      platform: "win32",
      ...fakeFs([]),
    });
    expect(result).toBeNull();
  });

  it("ignores a GITLEAKS_BIN that does not exist", () => {
    const result = findGitleaks({
      env: { GITLEAKS_BIN: "/nope/gitleaks", PATH: "" },
      platform: "linux",
      ...fakeFs([]),
    });
    expect(result).toBeNull();
  });
});
