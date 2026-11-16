import path from "node:path";
import type { NextConfig } from "next";

// Local development: load the repo-root .env (gitignored). Real environment variables always win,
// and a missing file (e.g. in production, where the platform injects variables) is fine.
try {
  process.loadEnvFile(path.resolve(process.cwd(), "../../.env"));
} catch {
  /* no root .env */
}

// The public API reference runs a third-party UI library and accepts a pasted API credential, so the browser itself is told to refuse every
// request that is not to this origin (no CDN, no analytics, no proxy) and to refuse embedding. Verified in a real browser in S5.
const DOCS_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}` /* React dev mode needs eval; production does not */,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const config: NextConfig = {
  transpilePackages: ["@sandbox/core", "@sandbox/db"],
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
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
      { source: "/docs", headers: [{ key: "Content-Security-Policy", value: DOCS_CSP }, { key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "no-store" }] },
      // The checkout token is in the URL: never leak it through Referer, never cache the page.
      {
        source: "/checkout/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};
export default config;
