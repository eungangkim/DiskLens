/// <reference types="vite/client" />
import type { DiskLensApi } from '@shared/ipc'

declare global {
  interface Window {
    /** preload(contextBridge)가 노출한 API */
    api: DiskLensApi
  }
}

export {}
