#!/usr/bin/env node
// Automatic per-file code review.
//
// Called by two hooks in .claude/settings.json:
//   post-tool-use  -> Claude wrote/edited a file (Write|Edit)
//   file-changed   -> any watched file changed on disk (external editors, git, other tools)
//
// It debounces bursts of edits, skips unchanged content, caps concurrent reviews, then runs
// the project agent .claude/agents/code-reviewer.md through headless `claude -p --agent code-reviewer`.
// Reports go to .claude/reviews/. When the verdict is FAIL (critical/high findings) it exits 2,
// which (with asyncRewake) wakes Claude with a short summary.
//
// Turn off: create .claude/reviews/.disabled, or set CLAUDE_AUTO_REVIEW=off.

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SOURCE = process.argv[2]; // "post-tool-use" | "file-changed"

const CONFIG = {
  debounceMs: { "post-tool-use": Number(process.env.CLAUDE_REVIEW_DEBOUNCE_MS ?? 15_000), "file-changed": Number(process.env.CLAUDE_REVIEW_DEBOUNCE_MS ?? 20_000) },
  claudeEditWindowMs: 60_000, // FileChanged ignores files Claude touched within this window
  maxConcurrent: 2,
  slotWaitMs: 15 * 60_000,
  reviewTimeoutMs: 10 * 60_000,
  maxFileBytes: 150_000,
  maxDiffChars: 40_000,
  extensions: new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css"]),
  ignoredDirs: new Set([
    "node_modules", ".next", ".git", ".claude", ".agents", ".vercel", "doc",
    "coverage", "playwright-report", "test-results", "public",
  ]),
  ignoredFiles: [/\.d\.ts$/, /\.min\.(js|css)$/, /^next-env\.d\.ts$/],
};

const ROOT = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const REVIEWS_DIR = path.join(ROOT, ".claude", "reviews");
const STATE_DIR = path.join(REVIEWS_DIR, ".state");
const AGENT_NAME = "code-reviewer";
const AGENT_FILE = path.join(ROOT, ".claude", "agents", `${AGENT_NAME}.md`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const readOr = (p, fallback = null) => {
  try { return fs.readFileSync(p, "utf8"); } catch { return fallback; }
};

function log(entry) {
  try {
    fs.appendFileSync(
      path.join(REVIEWS_DIR, "_log.jsonl"),
      JSON.stringify({ time: new Date().toISOString(), source: SOURCE, ...entry }) + "\n",
    );
  } catch { /* logging must never break the hook */ }
}

// CLAUDE_REVIEW_DEBUG=1 prints why a file was skipped (for troubleshooting the hook).
function skip(reason, extra = {}) {
  if (process.env.CLAUDE_REVIEW_DEBUG) process.stderr.write(`[review] skip: ${reason} ${JSON.stringify(extra)}
`);
  return 0;
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  try { return JSON.parse(data || "{}"); } catch { return {}; }
}

function isReviewable(rel) {
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const parts = rel.split("/");
  if (parts.some((p) => CONFIG.ignoredDirs.has(p))) return false;
  const base = parts.at(-1);
  if (CONFIG.ignoredFiles.some((re) => re.test(base))) return false;
  return CONFIG.extensions.has(path.extname(base));
}

async function acquireSlot() {
  const deadline = Date.now() + CONFIG.slotWaitMs;
  while (Date.now() < deadline) {
    for (let i = 0; i < CONFIG.maxConcurrent; i++) {
      const slot = path.join(STATE_DIR, `slot-${i}`);
      try {
        fs.mkdirSync(slot);
        return slot;
      } catch {
        try { // reclaim slots left by crashed reviews
          if (Date.now() - fs.statSync(slot).mtimeMs > CONFIG.reviewTimeoutMs + 60_000) {
            fs.rmSync(slot, { recursive: true, force: true });
          }
        } catch { /* slot vanished between calls */ }
      }
    }
    await sleep(5_000);
  }
  return null;
}

function gitDiff(rel) {
  const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    const tracked = git(["ls-files", "--", rel]).trim() !== "";
    if (!tracked) return "(new or untracked file: review the whole file)";
    const diff = git(["diff", "--no-color", "HEAD", "--", rel]);
    if (!diff.trim()) return "(no diff against HEAD: content matches the last commit; review the whole file)";
    return diff.length > CONFIG.maxDiffChars
      ? diff.slice(0, CONFIG.maxDiffChars) + "\n... (diff truncated; read the file for the rest)"
      : diff;
  } catch {
    return "(git diff unavailable: review the whole file)";
  }
}

function runReviewer(prompt) {
  return new Promise((resolve) => {
    // Model, tools and skills come from the agent's frontmatter; the flags below are a second
    // guard so the review session can never write, run commands or reach the network.
    const args = [
      "-p",
      "--agent", AGENT_NAME,
      "--allowedTools", "Read,Grep,Glob,Skill",
      "--disallowedTools", "Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Agent",
      "--output-format", "text",
      "--no-session-persistence",
    ];

    const child = spawn("claude", args, {
      cwd: ROOT,
      env: { ...process.env, CLAUDE_REVIEW_CHILD: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), CONFIG.reviewTimeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.stdin.end(prompt);
  });
}

function buildPrompt(rel, event, diff) {
  const origin = SOURCE === "post-tool-use"
    ? "Claude Code edited this file (Write/Edit tool)."
    : `The file changed on disk outside Claude's tools (event: ${event}), e.g. a person's editor or git.`;
  return [
    `Review this changed file: ${rel}`,
    `Trigger: ${origin}`,
    `Project root: ${ROOT}`,
    "",
    "Git diff against HEAD:",
    "```diff",
    diff,
    "```",
    "",
    "Follow your review procedure and output format exactly. The last line must be the VERDICT line.",
  ].join("\n");
}

function blockingExcerpt(report) {
  const m = report.match(/## Blocking findings\s*\n([\s\S]*?)(\n## |\nVERDICT:|$)/);
  const text = (m ? m[1] : "").trim();
  const lines = text.split("\n");
  return lines.length > 30 ? lines.slice(0, 30).join("\n") + "\n..." : text;
}

async function main() {
  if (process.env.CLAUDE_REVIEW_CHILD) return skip("inside review session"); // never review from inside a review session
  if (process.env.CLAUDE_AUTO_REVIEW === "off") return skip("CLAUDE_AUTO_REVIEW=off");
  if (fs.existsSync(path.join(REVIEWS_DIR, ".disabled"))) return skip(".disabled present");

  const input = await readStdin();
  const rawPath = SOURCE === "post-tool-use" ? input.tool_input?.file_path : input.file_path;
  const event = input.event ?? "edit";
  if (!rawPath || event === "unlink") return skip("no path or unlink", { rawPath, event, keys: Object.keys(input) });

  const abs = path.resolve(ROOT, rawPath);
  const rel = path.relative(ROOT, abs).split(path.sep).join("/");
  if (!isReviewable(rel)) return skip("not reviewable", { ROOT, rel });

  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!fs.existsSync(path.join(REVIEWS_DIR, ".gitignore"))) {
    fs.writeFileSync(path.join(REVIEWS_DIR, ".gitignore"), "*\n");
  }

  const key = sha(rel).slice(0, 16);
  const touchFile = path.join(STATE_DIR, `${key}.claude-edit`);
  const pendingFile = path.join(STATE_DIR, `${key}.pending`);
  const hashFile = path.join(STATE_DIR, `${key}.hash`);

  // Claude's own edits also fire FileChanged; PostToolUse owns those so Claude gets the feedback.
  if (SOURCE === "post-tool-use") {
    fs.writeFileSync(touchFile, String(Date.now()));
  } else {
    const touched = Number(readOr(touchFile, "0"));
    if (Date.now() - touched < CONFIG.claudeEditWindowMs) return skip("recent Claude edit", { rel });
  }

  // Debounce: only the last event in a burst of edits reviews the file.
  const token = `${Date.now()}-${process.pid}-${SOURCE}`;
  fs.writeFileSync(pendingFile, token);
  await sleep(CONFIG.debounceMs[SOURCE] ?? 15_000);
  if (readOr(pendingFile) !== token) return skip("superseded by newer edit", { rel });

  const slot = await acquireSlot();
  if (!slot) { log({ file: rel, status: "skipped", reason: "no free review slot" }); return 0; }

  try {
    if (readOr(pendingFile) !== token) return 0; // a newer edit arrived while waiting
    const content = readOr(abs);
    if (content === null) return 0;
    if (Buffer.byteLength(content) > CONFIG.maxFileBytes) {
      log({ file: rel, status: "skipped", reason: "file too large" });
      return 0;
    }
    const contentHash = sha(content);
    if (readOr(hashFile) === contentHash) return skip("content already reviewed", { rel }); // this exact content was already reviewed

    if (!fs.existsSync(AGENT_FILE)) {
      log({ file: rel, status: "error", error: `reviewer agent missing: ${AGENT_FILE}` });
      return 0;
    }
    const started = Date.now();
    const result = await runReviewer(buildPrompt(rel, event, gitDiff(rel)));
    const report = result.out.trim();
    const verdict = [...report.matchAll(/VERDICT:\s*(PASS|WARN|FAIL)([^\n]*)/g)].at(-1);

    if (result.code !== 0 || !verdict) {
      log({ file: rel, status: "error", code: result.code, error: result.err.slice(0, 500) });
      return 0; // infrastructure failures must not interrupt work
    }

    const reportName = rel.replace(/[\\/]/g, "__") + ".md";
    const reportPath = path.join(REVIEWS_DIR, reportName);
    fs.writeFileSync(
      reportPath,
      `<!-- ${new Date().toISOString()} | ${SOURCE} | sha256:${contentHash.slice(0, 12)} -->\n${report}\n`,
    );
    fs.writeFileSync(hashFile, contentHash);
    log({ file: rel, status: "done", verdict: verdict[1], counts: verdict[2].trim(), seconds: Math.round((Date.now() - started) / 1000) });

    if (verdict[1] === "FAIL") {
      const who = SOURCE === "post-tool-use"
        ? "Fix these in the file you just edited, then continue."
        : "This was an external edit (not made by Claude). Tell the user about these findings; do not change the file unless asked.";
      process.stderr.write(
        `Automatic code review FAILED for ${rel} (${verdict[2].trim()}).\n` +
        `Full report: .claude/reviews/${reportName}\n\n${blockingExcerpt(report)}\n\n${who}\n`,
      );
      return 2;
    }
    return 0;
  } finally {
    fs.rmSync(slot, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (e) => { log({ status: "crash", error: String(e?.stack || e).slice(0, 800) }); process.exit(0); },
);
