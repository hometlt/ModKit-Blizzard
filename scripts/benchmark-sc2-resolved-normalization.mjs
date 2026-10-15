// Compares the current normalizer with the committed baseline, in separate Node processes.
// node scripts/benchmark-sc2-resolved-normalization.mjs
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2]
if (!mode) {
  for (const variant of ['baseline', 'current']) {
    for (let sample = 0; sample < 3; sample++) {
      const result = spawnSync(
        process.execPath,
        ['--expose-gc', fileURLToPath(import.meta.url), variant],
        { encoding: 'utf8' },
      )
      if (result.status !== 0) throw new Error(result.stderr)
      process.stdout.write(result.stdout)
    }
  }
} else {
  const modulePath = 'starcraft2/modules/data/services/catalog/resolved-data-normalization.js'
  const baselineRef = process.env.SC2_NORMALIZATION_BASELINE ?? 'HEAD'
  const url =
    mode === 'baseline'
      ? `data:text/javascript;base64,${execFileSync('git', ['show', `${baselineRef}:${modulePath}`]).toString('base64')}`
      : new URL(`../${modulePath}`, import.meta.url).href
  const { normalizeStarcraft2ResolvedSnapshot } = await import(url)
  const freeze = value => {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child)
      Object.freeze(value)
    }
    return value
  }
  const definitions = Array.from({ length: 40_000 }, (_, i) =>
    freeze({
      namespace: 'Unit',
      typeId: 'CUnit',
      entityId: `Unit${i}`,
      fields: {
        LifeMax: 45 + (i % 100),
        Speed: 2.25,
        Name: `Unit/Name/Unit${i}`,
        WeaponArray: [{ index: '0', value: { Link: `Weapon${i % 10}` } }],
        Cost: [
          {
            index: '0',
            value: {
              Charge: { Link: i % 100 === 0 ? 'Abil/##id##' : `Abil/Unit${i}`, CountUse: 1 },
            },
          },
        ],
      },
    }),
  )
  const snapshot = { definitions, entities: [], relations: [], diagnostics: [] }
  global.gc()
  const before = process.memoryUsage().heapUsed
  const start = performance.now()
  const result = normalizeStarcraft2ResolvedSnapshot(snapshot)
  const ms = performance.now() - start
  const allocatedMiB = (process.memoryUsage().heapUsed - before) / 1048576
  global.gc()
  const retainedMiB = (process.memoryUsage().heapUsed - before) / 1048576
  const digest = createHash('sha256').update(JSON.stringify(result)).digest('hex')
  process.stdout.write(
    JSON.stringify({
      mode,
      entities: definitions.length,
      ms: +ms.toFixed(1),
      allocatedMiB: +allocatedMiB.toFixed(1),
      retainedMiB: +retainedMiB.toFixed(1),
      digest,
    }) + '\n',
  )
}
