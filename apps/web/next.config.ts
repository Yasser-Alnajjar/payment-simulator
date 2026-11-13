import path from "node:path";
import type { NextConfig } from "next";

// Local development: load the repo-root .env (gitignored). Real environment variables always win,
// and a missing file (e.g. in production, where the platform injects variables) is fine.
try {
  process.loadEnvFile(path.resolve(process.cwd(), "../../.env"));
} catch {
  /* no root .env */
}

const config: NextConfig = {
  transpilePackages: ["@sandbox/core", "@sandbox/db"],
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  async redirects() {
    return [{ source: "/", destination: "/credentials", permanent: false }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};
export default config;
