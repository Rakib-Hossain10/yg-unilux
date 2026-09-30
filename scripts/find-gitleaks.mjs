#!/usr/bin/env node
// Locates the gitleaks binary for the pre-commit hook.
//
// Order: $GITLEAKS_BIN, then PATH, then (Windows) the winget install folders,
// because a fresh `winget install` is not on PATH until the shell restarts.
//
// CLI: prints the absolute path and exits 0, or prints install instructions to
// stderr and exits 1. The hook must fail the commit in that case, never skip.

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * @typedef {object} FindOptions
 * @property {Record<string, string | undefined>} env
 * @property {NodeJS.Platform} platform
 * @property {(p: string) => boolean} isFile
 * @property {(p: string) => string[]} readdir
 */

/** @param {FindOptions} options @returns {string | null} */
export function findGitleaks({ env, platform, isFile, readdir }) {
  const isWindows = platform === "win32";
  const p = isWindows ? path.win32 : path.posix;
  const exe = isWindows ? "gitleaks.exe" : "gitleaks";

  const explicit = env.GITLEAKS_BIN;
  if (explicit && isFile(explicit)) return explicit;

  // Windows env var names are case-insensitive; Node exposes it as "Path".
  const pathVar = env.PATH ?? env.Path ?? "";
  for (const dir of pathVar.split(p.delimiter)) {
    // Relative entries (".", "bin", empty) resolve against the repo, so a
    // committed file could impersonate gitleaks. Only trust absolute dirs.
    if (!dir || !p.isAbsolute(dir)) continue;
    const candidate = p.join(dir, exe);
    if (isFile(candidate)) return candidate;
  }

  if (isWindows && env.LOCALAPPDATA) {
    const winget = p.join(env.LOCALAPPDATA, "Microsoft", "WinGet");
    const link = p.join(winget, "Links", exe);
    if (isFile(link)) return link;

    const packages = p.join(winget, "Packages");
    let entries = [];
    try {
      entries = readdir(packages);
    } catch {
      entries = []; // No winget packages folder: nothing to find there.
    }
    for (const entry of entries
      .filter((e) => e.startsWith("Gitleaks.Gitleaks_"))
      .sort()) {
      const candidate = p.join(packages, entry, exe);
      if (isFile(candidate)) return candidate;
    }
  }

  return null;
}

function isFileOnDisk(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false; // Missing or unreadable path: treat as "not here".
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const found = findGitleaks({
    env: process.env,
    platform: process.platform,
    isFile: isFileOnDisk,
    readdir: (dir) => readdirSync(dir),
  });
  if (found) {
    process.stdout.write(`${found}\n`);
  } else {
    process.stderr.write(
      [
        "gitleaks was not found, so the commit is blocked (secret scanning is required).",
        "Install it, then retry:",
        "  Windows: winget install Gitleaks.Gitleaks",
        "  macOS:   brew install gitleaks",
        "  Linux:   https://github.com/gitleaks/gitleaks/releases (v8.30.1)",
        "Or point GITLEAKS_BIN at the binary.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
}
