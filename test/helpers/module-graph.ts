// Import-graph helper for static guards: resolves every specifier with the
// REAL TypeScript resolver (tsconfig paths, moduleResolution "bundler") and
// TypeScript's own import scanner, so "@/x/./y", ".js" extensions, "//" in a
// path and re-export chains resolve exactly as the build resolves them.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const SRC = path.join(ROOT, "src");

const parsed = ts.parseJsonConfigFileContent(
  ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile).config,
  ts.sys,
  ROOT,
);
const options = parsed.options;
const host = ts.createCompilerHost(options);

/** A repo-relative, forward-slash path (lower case on Windows). */
export function norm(file: string): string {
  const real = existsSync(file) ? realpathSync.native(file) : file;
  const rel = path.relative(ROOT, real).replaceAll("\\", "/");
  return process.platform === "win32" ? rel.toLowerCase() : rel;
}

export interface ImportEdge {
  spec: string;
  /** The resolved project file; null for a package or an unresolved name. */
  file: string | null;
}

const edgeCache = new Map<string, ImportEdge[]>();

/** Every import/export/import()/require() of `file`, resolved. */
export function importEdges(file: string): ImportEdge[] {
  const key = norm(file);
  const hit = edgeCache.get(key);
  if (hit) return hit;
  const info = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
  const out = info.importedFiles.map(({ fileName: spec }): ImportEdge => {
    const r = ts.resolveModuleName(spec, file, options, host).resolvedModule;
    const resolved =
      r &&
      !r.isExternalLibraryImport &&
      !r.resolvedFileName.includes("node_modules")
        ? r.resolvedFileName
        : null;
    return { spec, file: resolved };
  });
  edgeCache.set(key, out);
  return out;
}

/** Resolves one specifier as if imported from `from`. */
export function resolveSpecifier(spec: string, from: string): string | null {
  const r = ts.resolveModuleName(spec, from, options, host).resolvedModule;
  return r ? r.resolvedFileName : null;
}

/** Source files under `dir` (tests excluded), absolute paths. */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.(ts|tsx|mts|cts|js|jsx|mjs)$/.test(entry.name) &&
        !/\.test\.[jt]sx?$/.test(entry.name),
    )
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

/**
 * Every import chain from `start` to an edge matching `hit`, transitively
 * through project files, as readable "a -> b -> c" strings.
 */
export function reachingChains(
  start: string,
  hit: (edge: ImportEdge) => boolean,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const stack: [string, string[]][] = [[start, [norm(start)]]];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    const [file, trail] = next;
    if (seen.has(norm(file))) continue;
    seen.add(norm(file));
    for (const edge of importEdges(file)) {
      if (hit(edge)) {
        found.push(
          [...trail, edge.file ? norm(edge.file) : edge.spec].join(" -> "),
        );
      }
      if (edge.file && !/\.d\.ts$/.test(edge.file)) {
        stack.push([edge.file, [...trail, norm(edge.file)]]);
      }
    }
  }
  return found;
}
