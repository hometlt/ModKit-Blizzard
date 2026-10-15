/**
 * Folder-backed {@link LayoutFileSource}: reads layout files from a mod's
 * SC2Data root on disk. Used by tests and by reference-dump previews; the
 * VFS-backed source (CASC/MPQ) arrives with `galaxy-layout-convergence`
 * stage 3.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LayoutFileSource } from './workspace.js'

/**
 * @param name       label for diagnostics (e.g. `core.sc2mod`)
 * @param dataRoot   absolute path to the mod's SC2Data folder (the directory
 *                   that contains `UI/Layout/…`), e.g.
 *                   `…/core.sc2mod/base.sc2data`
 */
export function fsLayoutSource(name: string, dataRoot: string): LayoutFileSource {
  const root = path.resolve(dataRoot)
  return {
    name,
    async read(relPath: string): Promise<string | undefined> {
      try {
        return await fs.readFile(path.join(root, relPath), 'utf8')
      } catch {
        return undefined
      }
    },
    uri(relPath: string): string {
      return pathToFileURL(path.join(root, relPath)).toString()
    },
  }
}
