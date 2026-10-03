/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONSTELLATION_RELAY_ADDRS?: string
  readonly VITE_CONSTELLATION_PUBLIC_URL?: string
}

declare const __CONSTELLATION_BUILD_METADATA__: Readonly<{
  version: string
  commit: string
  builtAt: string
}>
