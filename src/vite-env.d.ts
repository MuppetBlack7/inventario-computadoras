/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_IMAGEKIT_BACKEND_URL?: string
  readonly VITE_FIREBASE_AUTH_DOMAIN_OVERRIDE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
