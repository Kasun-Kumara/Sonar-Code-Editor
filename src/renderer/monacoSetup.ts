/**
 * Configure @monaco-editor/react to use the locally bundled monaco-editor
 * instead of fetching from CDN.  This ensures the editor loads on machines
 * without internet access (e.g. exam-room Windows clients) and avoids CSP
 * issues in the production Electron build.
 *
 * Worker configuration (MonacoEnvironment.getWorker + Worker constructor
 * patch) lives in monacoWorkerPatch.ts which MUST be imported before this
 * module so that globalThis.MonacoEnvironment is set before monaco-editor
 * evaluates.
 *
 * Must be imported BEFORE any <MonacoEditor /> component is rendered.
 */
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

// Point @monaco-editor/react at the local bundle instead of CDN.
loader.config({ monaco });
