import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const blizzardRoot = new URL('../', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/u, '')
const linkedCoreRoot =
  process.env.MODKIT_LINK_MODE === 'core'
    ? `${(process.env.MODKIT_CORE_ROOT ?? fileURLToPath(new URL('../../modkit-core', import.meta.url)))
        .replaceAll('\\', '/')
        .replace(/\/$/u, '')}/`
    : undefined
const linkedCoreAliases = linkedCoreRoot === undefined
  ? []
  : ['codec-kit', 'core', 'host', 'scene', 'sdk', 'testkit', 'ui', 'uv', 'vfs']
      .flatMap(packageName => {
        const manifest = JSON.parse(
          readFileSync(`${linkedCoreRoot}packages/${packageName}/package.json`, 'utf8'),
        )
        return Object.entries(manifest.exports ?? {}).flatMap(([key, exported]) => {
          const target = typeof exported === 'string' ? exported : exported?.default
          if (typeof target !== 'string') return []
          const specifier = `@modkit/${packageName}${key === '.' ? '' : key.slice(1)}`
          if (!specifier.includes('*'))
            return [{
              find: specifier,
              replacement: `${linkedCoreRoot}packages/${packageName}/${target.replace(/^\.\//u, '')}`,
            }]
          const expression = specifier
            .split('*')
            .map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
            .join('(.+)')
          return [{
            find: new RegExp(`^${expression}$`, 'u'),
            replacement: `${linkedCoreRoot}packages/${packageName}/${target.replace(/^\.\//u, '').replaceAll('*', '$1')}`,
          }]
        })
      })
      .sort((left, right) => String(right.find).length - String(left.find).length)
const tier = process.env.MODKIT_TEST_TIER ?? 'quick'
const tiers = {
  quick: {
    corpus: '0',
    exclude: [
      '**/*-corpus.test.ts',
      'starcraft2/modules/galaxy/test/semantic-provider.test.ts',
      'models/test/m3a-corpus-audit.test.ts',
      'mpq/test/native-preserving-workflow.test.ts',
      'test/integration/**/*.test.ts',
    ],
    timeout: 120_000,
  },
  owner: {
    corpus: '0',
    exclude: [
      '**/*-corpus.test.ts',
      'models/test/m3a-corpus-audit.test.ts',
      'mpq/test/native-preserving-workflow.test.ts',
      'starcraft2/test/sc2-map-world-writer.test.ts',
      'test/integration/sc2-runtime-catalog-real.test.ts',
      'test/integration/sc2-document-info-real.test.ts',
      'test/integration/sc2-triggers-c2-real.test.ts',
      'starcraft2/modules/mod/test/workspace/mod-resources-real.test.ts',
    ],
    timeout: 180_000,
  },
  real: {
    corpus: '1',
    exclude: [],
    include: [
      'models/test/m3-animation.test.ts',
      'models/test/m3-material.test.ts',
      'models/test/m3-skeleton.test.ts',
      'models/test/m3a-corpus-audit.test.ts',
      'mpq/test/native-preserving-workflow.test.ts',
      'starcraft2/test/**/*-corpus.test.ts',
      'starcraft2/modules/**/test/**/*-corpus.test.ts',
      'blizzard-diablo/test/**/*-corpus.test.ts',
      'blizzard-warcraft-3/test/**/*-corpus.test.ts',
      'blizzard-starcraft-1/test/**/*-corpus.test.ts',
      'blizzard-heroes/test/**/*-corpus.test.ts',
      'blizzard-world-of-warcraft/test/**/*-corpus.test.ts',
      'mpq/test/**/*-corpus.test.ts',
      'models/test/m3-uvm-textured-corpus.test.ts',
      'models/test/m3-uvm-physics-corpus.test.ts',
      'starcraft2/test/sc2-map-world-writer.test.ts',
      'test/integration/sc2-runtime-catalog-real.test.ts',
      'test/integration/sc2-document-info-real.test.ts',
      'test/integration/sc2-triggers-c2-real.test.ts',
      'starcraft2/modules/mod/test/workspace/mod-resources-real.test.ts',
    ],
    timeout: 180_000,
  },
}
const selected = tiers[tier]
if (selected === undefined) throw new Error(`unknown MODKIT_TEST_TIER: ${tier}`)

process.env.MODKIT_TEST_INSTALLED_CORPUS = selected.corpus

export default defineConfig({
  resolve: {
    alias: [
      ...linkedCoreAliases,
      // JS world-writer imports the native TS owner with its compiled extension.
      { find: '../../../shared/format/formats/texture-masks.js',
        replacement: fileURLToPath(new URL('../starcraft2/modules/map/shared/format/formats/texture-masks.ts', import.meta.url)) },
      {
        find: '@modkitx/models-processing/core/effects-sim',
        replacement: new URL(
          '../../modkit-core/packages/codec-kit/src/model-math/effects-sim.ts',
          import.meta.url,
        ).pathname.replace(/^\/(?=[A-Za-z]:)/u, ''),
      },
      {
        find: '@modkitx/models-processing',
        replacement: new URL(
          '../../modkit-core/packages/codec-kit/src/legacy-model-support.ts',
          import.meta.url,
        ).pathname.replace(/^\/(?=[A-Za-z]:)/u, ''),
      },
    ],
  },
  test: {
    include: selected.include ?? [
      'blizzard-common-formats/test/**/*.test.ts',
      'blizzard-diablo/test/**/*.test.ts',
      'blizzard-warcraft-3/test/**/*.test.ts',
      'blizzard-starcraft-1/test/**/*.test.ts',
      'blizzard-heroes/test/**/*.test.ts',
      'blizzard-world-of-warcraft/test/**/*.test.ts',
      'casc/test/**/*.test.ts',
      'starcraft2/modules/galaxy/test/**/*.test.ts',
      'models/test/**/*.test.ts',
      'models/test/m3-field-effects.test.mjs',
      'models/test/metadata-schema-host.test.mjs',
      'models/test/m3-projector-tracks.test.mjs',
      'models/test/m3-projector-host.test.mjs',
      'models/test/m3-collision-splats-host.test.mjs',
      'models/test/m3-effect-shading-host.test.mjs',
      'models/test/m3-ribbon-rings-host.test.mjs',
      'models/test/m3-linked-emission-host.test.mjs',
      'models/test/m3-effect-splines.test.mjs',
      'models/test/m3-billboards-host.test.mjs',
      'models/test/m3-model-particles-host.test.mjs',
      'models/test/m3-static-preview.test.mjs',
      'models/test/m3-static-preview-host.test.mjs',
      'models/test/fresh-rig-host.test.mjs',
      'models/test/fresh-write-host.test.mjs',
      'mpq/test/**/*.test.ts',
      'starcraft2/test/**/*.test.ts',
      'starcraft2/modules/**/test/**/*.test.ts',
      'test/integration/**/*.test.ts',
    ],
    exclude: selected.exclude,
    fileParallelism: true,
    testTimeout: selected.timeout,
    hookTimeout: selected.timeout,
  },
})
