import type { StorageIsolationResult } from "@/lib/types/docs";

/**
 * The API reference page lets a developer type a real API credential into "Try it". That credential must live only in the memory of
 * this page. Before the reference library loads, this replaces every persistent browser store with an in-memory stand-in:
 * localStorage, sessionStorage, IndexedDB and document.cookie writes. `restore()` puts the originals back when the page unmounts, so the
 * rest of the dashboard is unaffected. If any store cannot be replaced, it reports failure and the caller must NOT load the library.
 */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  const s = {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(String(k), String(v)),
  };
  return s as Storage;
}

type Undo = () => void;

function replace(target: object, name: string, value: unknown): Undo {
  const original = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, get: () => value });
  return () => {
    if (original) Object.defineProperty(target, name, original);
    else delete (target as Record<string, unknown>)[name];
  };
}

export function isolateBrowserStorage(): StorageIsolationResult {
  const undo: Undo[] = [];
  try {
    undo.push(replace(window, "localStorage", memoryStorage()));
    undo.push(replace(window, "sessionStorage", memoryStorage()));
    undo.push(replace(window, "indexedDB", undefined));
    // Cookies: reads still work (nothing sensitive is readable, session cookies are httpOnly); writes are discarded.
    const proto = Document.prototype;
    const cookie = Object.getOwnPropertyDescriptor(proto, "cookie");
    if (!cookie?.get || !cookie.configurable) throw new Error("document.cookie cannot be isolated");
    Object.defineProperty(document, "cookie", { configurable: true, get: () => "", set: () => undefined });
    undo.push(() => { delete (document as unknown as Record<string, unknown>).cookie; });
    // Verify, do not assume: writing must not reach the real stores.
    window.localStorage.setItem("__isolation_probe__", "1");
    document.cookie = "__isolation_probe__=1";
    if (document.cookie !== "") throw new Error("cookie writes are not isolated");
  } catch (e) {
    undo.reverse().forEach((u) => u());
    return { ok: false, reason: e instanceof Error ? e.message : "storage could not be isolated" };
  }
  return { ok: true, restore: () => undo.reverse().forEach((u) => u()) };
}
