/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override the gateway address during development, e.g. http://10.0.0.18:8080 */
  readonly VITE_GATEWAY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
