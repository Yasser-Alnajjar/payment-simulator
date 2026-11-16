import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** S5 static guarantees for the public API reference page (the runtime behaviour is verified in a real browser, see docs/S5-report.md). */
const WEB = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(WEB, p), "utf8");
const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

describe("API reference page (static)", () => {
  it("@scalar/api-reference is a pinned production dependency, not a dev dependency", () => {
    expect(pkg.dependencies["@scalar/api-reference"]).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
    expect(pkg.devDependencies["@scalar/api-reference"]).toBeUndefined();
  });
  it("follows page -> SSR -> CSR and keeps the page itself thin", () => {
    const page = read("src/app/docs/page.tsx");
    expect(page).toMatch(/<Docs\.ApiReference \/>/);
    expect(page).not.toMatch(/fetch\(|@scalar|process\.env/);
    expect(read("modules/docs/api-reference/ssr/ApiReference.tsx")).not.toMatch(/use client/);
    expect(read("modules/docs/api-reference/csr/ApiReferenceViewer.tsx")).toMatch(/^"use client"/);
  });
  it("loads the library from the bundle and the document from the same origin: no absolute URL anywhere in the page code", () => {
    for (const f of ["modules/docs/api-reference/csr/ApiReferenceViewer.tsx", "modules/docs/api-reference/ssr/ApiReference.tsx", "src/app/docs/page.tsx", "src/lib/isolate-browser-storage.ts"]) {
      expect(read(f), f).not.toMatch(/https?:\/\//);
    }
  });
  it("configures Scalar with no telemetry, no persisted auth, no proxy, no web fonts and no agent/MCP", () => {
    const v = read("modules/docs/api-reference/csr/ApiReferenceViewer.tsx");
    expect(v).toMatch(/telemetry: false/);
    expect(v).toMatch(/persistAuth: false/);
    expect(v).toMatch(/withDefaultFonts: false/);
    expect(v).toMatch(/agent: \{ disabled: true \}/);
    expect(v).toMatch(/mcp: \{ disabled: true \}/);
    expect(v).not.toMatch(/proxyUrl/);
  });
  it("replaces persistent browser storage before the library loads and fails closed if it cannot", () => {
    const v = read("modules/docs/api-reference/csr/ApiReferenceViewer.tsx");
    expect(v.indexOf("isolateBrowserStorage()")).toBeGreaterThan(-1);
    expect(v.indexOf("isolateBrowserStorage()")).toBeLessThan(v.indexOf('import("@scalar/api-reference")'));
    expect(v).toMatch(/if \(!isolation\.ok\)[\s\S]*return;/);
    const i = read("src/lib/isolate-browser-storage.ts");
    for (const store of ['"localStorage"', '"sessionStorage"', '"indexedDB"', "cookie"]) expect(i).toContain(store);
  });
  it("serves /docs with an enforcing CSP that allows only same-origin connections, and the proxy leaves it public", () => {
    const cfg = read("next.config.ts");
    expect(cfg).toMatch(/connect-src 'self'"/);
    expect(cfg).toMatch(/default-src 'self'/);
    expect(cfg).toMatch(/frame-ancestors 'none'/);
    expect(cfg).toMatch(/source: "\/docs"/);
    expect(cfg).not.toMatch(/connect-src[^"]*https?:/);
    expect(read("src/proxy.ts")).toMatch(/"\/docs", "\/openapi\.json"/);
  });
  it("publishes the generated document as a static file", () => {
    expect(existsSync(path.join(WEB, "public/openapi.json"))).toBe(true);
  });
});
