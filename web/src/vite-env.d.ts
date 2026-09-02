/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override the gateway address during development, e.g. http://10.0.0.18:8080 */
  readonly VITE_GATEWAY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Injected by Decaid when it serves the skin (see /__decent/skin-api.js).
 * Absent in a plain browser or under `vite dev`, so always feature-detect.
 */
interface DecentApp {
  exitToDashboard?: () => void;
}

interface Window {
  decentApp?: DecentApp;
}
