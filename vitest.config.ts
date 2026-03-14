import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    setupFiles: ["./src/renderer/test/setup.ts"],
    environmentMatchGlobs: [
      ["src/main/**/*.test.ts", "node"],
      ["src/shared/**/*.test.ts", "node"],
      ["src/preload/**/*.test.ts", "node"],
      ["src/renderer/**/*.test.tsx", "jsdom"]
    ],
    exclude: ["node_modules", "out", "release", "output"]
  }
})
