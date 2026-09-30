import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` would otherwise append a managed block to CLAUDE.md when it
  // detects an AI agent. CLAUDE.md is maintained by hand in this repo.
  agentRules: false,
};

export default nextConfig;
