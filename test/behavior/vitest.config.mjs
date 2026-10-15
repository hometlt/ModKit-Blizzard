import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/**
 * A migrated suite the coverage receipt marks `supersededBy` stays in the tree as history and
 * leaves the run: the receipt is the one list, this config only reads it.
 */
const superseded = JSON.parse(
  readFileSync(new URL('./coverage-receipt.json', import.meta.url), 'utf8'),
).suites.flatMap(suite => (suite.supersededBy === undefined ? [] : [suite.targetTest]))

export default defineConfig({
  test: {
    include: ['test/behavior/*.test.ts'],
    exclude: superseded,
    fileParallelism: true,
  },
})
