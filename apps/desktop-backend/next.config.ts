import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      "@/lib/db/client": { browser: "./vendored-web/lib/db/client.ts", default: "./vendored-web/lib/db/client.ts" },
      "@/lib/db/schema": { browser: "./vendored-web/lib/db/schema.ts", default: "./vendored-web/lib/db/schema.ts" },
      "@/lib/db/sessions": { browser: "./vendored-web/lib/db/sessions.ts", default: "./vendored-web/lib/db/sessions.ts" },
      "@/lib/db/usage": { browser: "./vendored-web/lib/db/usage.ts", default: "./vendored-web/lib/db/usage.ts" },
      "@/lib/usage/date-range": { browser: "./vendored-web/lib/usage/date-range.ts", default: "./vendored-web/lib/usage/date-range.ts" },
      "@/lib/skills/global-skill-refs": { browser: "./vendored-web/lib/skills/global-skill-refs.ts", default: "./vendored-web/lib/skills/global-skill-refs.ts" },
      "@open-agents/sandbox": { browser: "./types/sandbox-state.d.ts", default: "./types/sandbox-state.d.ts" },
    },
  },
};

export default nextConfig;
