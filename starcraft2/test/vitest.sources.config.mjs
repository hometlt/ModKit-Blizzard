import { defineConfig } from 'vitest/config'
import ownerConfig from '../../test/vitest.config.mjs'

const blizzardRoot = new URL('../', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/u, '')

/**
 * The extension's own public subpaths (`@modkit/blizzard-starcraft2/...`) resolved to their sources,
 * so suites exercise the TypeScript they import rather than a possibly stale `dist`. The module
 * `.spec.ts` suites run here; `.test.ts` suites run in the owner config.
 */
export default defineConfig({
  ...ownerConfig,
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        useDefineForClassFields: false,
      },
    },
  },
  resolve: {
    alias: [
      {
        find: /^@modkit\/blizzard-starcraft2\/triggers\/document$/u,
        replacement: `${blizzardRoot}modules/triggers/shared/trigger-document/index.ts`,
      },
      {
        find: '@modkit/blizzard-starcraft2/galaxy/detection',
        replacement: `${blizzardRoot}modules/galaxy/services/source-detection.ts`,
      },
      {
        find: '@modkit/blizzard-starcraft2/triggers/detection',
        replacement: `${blizzardRoot}modules/triggers/services/source-detection.ts`,
      },
      {
        find: '@modkit/blizzard-starcraft2/galaxy/language-core',
        replacement: `${blizzardRoot}modules/galaxy/language-core/index.ts`,
      },
      {
        find: /^@modkit\/blizzard-starcraft2\/triggers\/document\/(.+)\.js$/u,
        replacement: `${blizzardRoot}modules/triggers/shared/trigger-document/$1.ts`,
      },
      {
        find: /^@modkit\/blizzard-starcraft2\/triggers\/editing\/(.+)\.js$/u,
        replacement: `${blizzardRoot}modules/triggers/services/editing/$1.ts`,
      },
      {
        find: /^@modkit\/blizzard-starcraft2\/triggers\/galaxy-conversion\/internal\/(.+)\.js$/u,
        replacement: `${blizzardRoot}modules/triggers/services/galaxy-conversion/internal/$1.ts`,
      },
      {
        find: /^@modkit\/blizzard-starcraft2\/galaxy\/analysis\/(.+)\.js$/u,
        replacement: `${blizzardRoot}modules/galaxy/services/analysis/$1.ts`,
      },
    ],
  },
  test: {
    ...ownerConfig.test,
    globals: true,
    include: ['starcraft2/modules/**/test/**/*.spec.ts'],
    exclude: [],
    setupFiles: ['./starcraft2/modules/layout/test/layout-engine/test/sc2-layout-core/setup.ts'],
  },
})
