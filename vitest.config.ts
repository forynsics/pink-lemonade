import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Renderer logic tests + main-process *pure* modules (CSV parse/sanitize/SQL builders).
    // The better-sqlite3 binding layer (src/main/csv/db.ts) is NOT unit-tested here — its
    // native binary is built for the Electron ABI and won't load under vitest's node runtime.
    include: ['src/shared/**/*.test.ts', 'src/renderer/src/**/*.test.ts', 'src/main/**/*.test.ts']
  }
})
