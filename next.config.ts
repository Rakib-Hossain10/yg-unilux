import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` would otherwise append a managed block to CLAUDE.md when it
  // detects an AI agent. CLAUDE.md is maintained by hand in this repo.
  agentRules: false,
  // Do not advertise the framework in an X-Powered-By header.
  poweredByHeader: false,
};

export default nextConfig;
