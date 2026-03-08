/**
 * Patch the global Worker constructor to suppress uncaught Worker errors.
 *
 * MUST be imported as the very first module in the app — before monaco-editor
 * or any other library that creates workers.
 *
 * Problem:
 *   Monaco v0.55+ creates ESM blob-URL workers.  In Electron these workers
 *   fail because the blob origin doesn't match the page origin (file:// or
 *   custom protocol).  The Worker `error` event fires as "Uncaught" which
 *   triggers a synchronous error-handling path in Monaco that blocks the main
 *   thread for several seconds — freezing any active typing (inline rename,
 *   file/folder creation inputs, and even the Monaco editor itself).
 *
 * Fix:
 *   We monkey-patch the Worker constructor so that every Worker instance
 *   automatically gets an `error` event listener that calls
 *   `event.preventDefault()`.  This suppresses the "Uncaught" propagation,
 *   allowing Monaco to handle the failure gracefully via its promise-chain
 *   rejection (which is fast) instead of the catastrophic synchronous path.
 *
 * Also sets `self.MonacoEnvironment` here (before any monaco-editor import)
 * to provide a `getWorker` override for proper worker creation.
 */

// ── 1. Patch Worker constructor ──────────────────────────────────────────────
const NativeWorker = globalThis.Worker;

class PatchedWorker extends NativeWorker {
  constructor(scriptURL: string | URL, options?: WorkerOptions) {
    super(scriptURL, options);

    // Suppress uncaught Worker errors.  Monaco internally sets its own
    // onerror / addEventListener('error'), but those can be overwritten or
    // removed.  By using addEventListener (not the onerror property) we
    // install an independent listener that always fires.
    this.addEventListener("error", (e: Event) => {
      e.preventDefault();
    });
  }
}

// Replace the global Worker so all code (Monaco, libraries, etc.) uses it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).Worker = PatchedWorker;


// ── 2. Set MonacoEnvironment BEFORE monaco-editor is imported ────────────────
// This runs at module evaluation time, which is before any subsequent
// `import` statements in files that import this module.
//
// We provide `getWorker` as a safety net.  Even if Monaco's internal code
// path bypasses this (e.g. the webWorkerFactory.js ESM fallback), the
// Worker constructor patch above still catches the error.

const IS_DEV =
  typeof location !== "undefined" && location.protocol.startsWith("http");

function createNoopWorker(label: string): Worker {
  const blob = new Blob(
    // Respond to Monaco's SimpleWorkerClient protocol so it doesn't timeout.
    // Every request gets an empty response which causes Monaco to fall back
    // to main-thread language services.
    [
      `self.onmessage = function(e) {
        var d = e.data;
        if (d && d.id !== undefined) {
          self.postMessage(d.vsWorker !== undefined
            ? { vsWorker: d.vsWorker, seq: d.seq, err: { message: 'noop' } }
            : { id: d.id, type: 'reply', res: null });
        }
      };`,
    ],
    { type: "application/javascript" },
  );
  const url = URL.createObjectURL(blob);
  const w = new Worker(url, { name: label });
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  return w;
}

self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (IS_DEV) {
      // In dev mode, try to use real workers via Vite dev server
      const WORKER_PATHS: Record<string, string> = {
        json: "/node_modules/monaco-editor/esm/vs/language/json/json.worker.js",
        css: "/node_modules/monaco-editor/esm/vs/language/css/css.worker.js",
        scss: "/node_modules/monaco-editor/esm/vs/language/css/css.worker.js",
        less: "/node_modules/monaco-editor/esm/vs/language/css/css.worker.js",
        html: "/node_modules/monaco-editor/esm/vs/language/html/html.worker.js",
        handlebars: "/node_modules/monaco-editor/esm/vs/language/html/html.worker.js",
        razor: "/node_modules/monaco-editor/esm/vs/language/html/html.worker.js",
        typescript: "/node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js",
        javascript: "/node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js",
      };
      const DEFAULT = "/node_modules/monaco-editor/esm/vs/editor/editor.worker.js";

      const workerUrl = new URL(
        WORKER_PATHS[label] || DEFAULT,
        location.origin,
      ).href;

      try {
        const blob = new Blob(
          [`import ${JSON.stringify(workerUrl)};`],
          { type: "application/javascript" },
        );
        const blobUrl = URL.createObjectURL(blob);
        const worker = new Worker(blobUrl, { type: "module", name: label });
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
        return worker;
      } catch {
        // Fall through to no-op worker
      }
    }

    // Production or dev fallback — return no-op worker
    return createNoopWorker(label);
  },
};
