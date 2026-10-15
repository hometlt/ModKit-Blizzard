import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createModkit } from '@modkit/host/node'
import type { RasterImageSource } from '@modkit/sdk'
import { authoredGrp } from './sc1-fixtures.js'

const extension = join(import.meta.dirname, '..')
const { decodeGrpFrame, readGrp } = (await import(pathToFileURL(join(extension, 'dist', 'grp', 'grp.js')).href)) as typeof import('../dist/grp/grp.js')

describe('StarCraft GRP', () => {
  it('decodes a coded frame onto the canvas, 0 where nothing is drawn', () => {
    const bytes = authoredGrp()
    const grp = readGrp(bytes)
    expect([grp.width, grp.height, grp.frames.length, grp.coded]).toEqual([4, 2, 1, true])
    expect([...decodeGrpFrame(bytes, grp, 0)]).toEqual([0, 5, 6, 0, 0, 0, 7, 0])
  })

  it('reads a plain frame as width × height indices, as the interface GRPs store them', () => {
    const bytes = Uint8Array.from([1, 0, 2, 0, 2, 0, 0, 0, 2, 2, 14, 0, 0, 0, 1, 2, 3, 4])
    const grp = readGrp(bytes)
    expect(grp.coded).toBe(false)
    expect([...decodeGrpFrame(bytes, grp, 0)]).toEqual([1, 2, 3, 4])
  })

  it('refuses a frame outside its canvas', () => {
    expect(() => readGrp(Uint8Array.from([1, 0, 2, 0, 2, 0, 1, 0, 2, 2, 14, 0, 0, 0]))).toThrow(/outside/u)
  })

  it('opens through the host as frames of a raster source; without a tileset palette, in grey', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'modkit-sc1-grp-'))
    const path = join(scratch, 'marine.grp')
    await writeFile(path, authoredGrp())
    const m = await createModkit({ extensions: [extension], roots: [scratch] })
    const opened = await m.open(path)
    try {
      if (opened.snapshot.state !== 'opened') throw new Error(JSON.stringify(opened.snapshot))
      expect(opened.snapshot.selected.contributionId).toBe('blizzard/starcraft1-grp')
      const lease = await opened.session!.dataSource('common.view/raster-image-source', 1)
      try {
        const raster = lease.value as RasterImageSource
        expect(await raster.info()).toMatchObject({ width: 4, height: 2, frames: 1 })
        const region = await raster.readRegion!({ x: 1, y: 0, width: 2, height: 1, frame: 0, pixelFormat: 'rgba8', maxBytes: 64 })
        expect([...region.pixels]).toEqual([5, 5, 5, 255, 6, 6, 6, 255])
        const empty = await raster.readRegion!({ x: 0, y: 0, width: 1, height: 1, frame: 0, pixelFormat: 'rgba8', maxBytes: 64 })
        expect(empty.pixels[3]).toBe(0)
      } finally {
        await lease.release()
      }
    } finally {
      await opened.close()
      await m.close()
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
