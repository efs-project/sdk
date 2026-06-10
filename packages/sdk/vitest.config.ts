import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // On-chain tests run against a local anvil fork (see test/setup.ts).
    // globalSetup: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
