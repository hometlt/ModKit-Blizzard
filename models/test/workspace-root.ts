import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** Locate modkit-core from a standalone extension checkout or an explicit local override. */
export function findModkitCoreWorkspace(testDirectory: string): string {
  const candidates = [
    ...(process.env['MODKIT_CORE_ROOT'] === undefined
      ? []
      : [resolve(process.env['MODKIT_CORE_ROOT'])]),
    resolve(testDirectory, '..', '..', '..', 'modkit-core'),
    resolve(testDirectory, '..', '..', '..', '..'),
  ]
  const workspace = candidates.find(candidate =>
    existsSync(resolve(candidate, 'packages', 'host', 'package.json')),
  )
  if (workspace === undefined) {
    throw new Error(`cannot locate the shared modkit-core workspace from ${testDirectory}`)
  }
  return workspace
}

/** Locate this standalone Blizzard extension repository from one of its package tests. */
export function findBlizzardExtensionRoot(testDirectory: string): string {
  const extensionRoot = resolve(testDirectory, '..', '..')
  if (!existsSync(resolve(extensionRoot, 'package.json'))) {
    throw new Error(
      `cannot locate the standalone Blizzard extension repository from ${testDirectory}`,
    )
  }
  return extensionRoot
}
