import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/probes/m4-sc2-nested-dds.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
