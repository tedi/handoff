/// <reference types="vite/client" />

import type { HandoffApi } from "../shared/contracts"

declare global {
  interface Window {
    handoffApp: HandoffApi
  }
}

export {}
