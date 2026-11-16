export interface ApiReferenceViewerProps {
  /** Same-origin URL of the OpenAPI document. */
  specUrl: string;
}

export type StorageIsolationResult = { ok: true; restore: () => void } | { ok: false; reason: string };
