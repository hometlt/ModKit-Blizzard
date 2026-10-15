#!/usr/bin/env node
/**
 * Keeps the incremental build caches honest. The starcraft2 TypeScript projects record what they
 * emitted in `node_modules/.cache/tsbuildinfo`, and `skip-unchanged.mjs` records step fingerprints
 * in `node_modules/.cache/build-steps`; both trust that the `dist` they describe is still there.
 * When `starcraft2/dist` is gone (a fresh checkout, a cleaned tree) the records are dropped, so the
 * next build emits everything instead of skipping files that no longer exist.
 */
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = join(repositoryRoot, 'node_modules', '.cache')

if (!existsSync(join(repositoryRoot, 'starcraft2', 'dist'))) {
  await rm(join(cache, 'tsbuildinfo'), { recursive: true, force: true })
  await rm(join(cache, 'build-steps'), { recursive: true, force: true })
  process.stdout.write('build cache: starcraft2/dist is missing, incremental records dropped\n')
}
