"use client";

import { useEffect, useRef, useState } from "react";
import "@scalar/api-reference/style.css";
import { isolateBrowserStorage } from "@/lib/isolate-browser-storage";
import type { ApiReferenceViewerProps } from "@/lib/types/docs";

/**
 * Interactive API reference (Scalar), self-hosted: the library is bundled with the app, the document is same-origin and the page's
 * Content-Security-Policy (next.config.ts) allows no third-party request. Nothing typed into "Try it" is persisted: see isolate-browser-storage.ts.
 */
export const ApiReferenceViewer = ({ specUrl }: ApiReferenceViewerProps) => {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let app: { app: { unmount: () => void } } | null = null;
    let cancelled = false;
    const isolation = isolateBrowserStorage();
    if (!isolation.ok) {
      setError(`The interactive reference was not loaded because this browser does not allow it to run without persistent storage (${isolation.reason}). The raw OpenAPI document is still available.`);
      return;
    }
    (async () => {
      const { createApiReference } = await import("@scalar/api-reference");
      if (cancelled || !host.current) return;
      app = createApiReference(host.current, {
        url: specUrl,
        telemetry: false,
        persistAuth: false,
        hideClientButton: true,
        withDefaultFonts: false,
        agent: { disabled: true },
        mcp: { disabled: true },
        showDeveloperTools: "never",
        defaultHttpClient: { targetKey: "js", clientKey: "fetch" },
        authentication: { preferredSecurityScheme: "basicAuth" },
        metaData: { title: "Payment Sandbox API reference" },
      } as never) as never;
    })().catch(() => setError("The API reference failed to load. The raw OpenAPI document is still available."));
    return () => {
      cancelled = true;
      try { app?.app.unmount(); } catch { /* already gone */ }
      isolation.restore();
    };
  }, [specUrl]);

  return (
    <div className="min-h-screen bg-white">
      {error ? <p className="p-6 text-sm text-red-700" role="alert">{error}</p> : null}
      <div ref={host} />
    </div>
  );
};
