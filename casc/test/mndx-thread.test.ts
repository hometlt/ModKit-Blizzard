import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { describe, expect, it } from 'vitest'

import { detectCascDataDirectory, readActiveBuildConfig } from '../src/casc/config.js'
import { parseEncodingTable } from '../src/casc/encoding.js'
import { MndxNameDb, parseMndxInThread } from '../src/casc/mndx.js'
import { CascStorage } from '../src/casc/storage.js'

// An installed game keeps its names in an MNDX root: `MODKIT_SC2_INSTALLATION=<dir>`.
const installedGame = process.env['MODKIT_SC2_INSTALLATION']

function installationFiles(root: string) {
  const at = (path: string) => nodePath.join(root, ...String(path).split('/'))
  return {
    list: async (path: string) => await fs.readdir(at(path)),
    get: async (path: string) => new Uint8Array(await fs.readFile(at(path))),
    async getRange(path: string, offset: number, length: number) {
      const file = await fs.open(at(path), 'r')
      try {
        const bytes = new Uint8Array(length)
        await file.read(bytes, 0, length, offset)
        return bytes
      } finally {
        await file.close()
      }
    },
    exists: async (path: string) => await fs.stat(at(path)).then(() => true, () => false),
  }
}

describe('MNDX parse in a worker thread', () => {
  it('hands the parse error back and leaves the root with the caller', async () => {
    const root = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    await expect(parseMndxInThread(root)).rejects.toThrow(/MNDX/u)
    expect(root).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
  })

  it.skipIf(installedGame === undefined)('builds the same index as parsing in place', async () => {
    const source = installationFiles(installedGame!)
    const { config, dataRoot } = await readActiveBuildConfig(
      source,
      '',
      await detectCascDataDirectory(source, ''),
    )
    const storage = await CascStorage.open(source, dataRoot, config, {})
    try {
      const encoding = parseEncodingTable(
        await storage.readEncodingKey(config.getKeyPair('encoding').encodingKey),
      )
      const rootPair = config.getKeyPair('root')
      const root = await storage.readEncodingKey(
        encoding.getEncodingKey(rootPair.contentKey) ?? rootPair.encodingKey,
      )
      const threaded = await parseMndxInThread(root)
      expect(Buffer.compare(threaded.serialize(), MndxNameDb.parse(root).serialize())).toBe(0)
    } finally {
      await storage.close()
    }
  }, 120_000)
})
