/**
 * Portrait images of StarCraft II profiles, from public depot files alone.
 *
 * A profile record names the selected portrait by its unlockable id. The Toon Welcome of a session
 * lists the unlockable definition files (`.unlk`); the one whose header has type tag `PORT` places
 * every portrait in a texture atlas: `m_imageHandle` = { `m_textureFileIndex`, `m_offset` }. A
 * texture list (`.ldpt`, usage `ldpt`) maps each texture file index to the atlas (`.wafl`, a DXT
 * DDS) and its grid; the offset is the cell, row by row. All three are JSON object streams
 * (Battlenet::Persistent::*), content-addressed on the depot like map files.
 *
 * Which texture list belongs to the portraits is not in either file, and the request the game uses
 * to learn it (Cache GetConfigHandle) has no writer in the editor to recover its layout from. The
 * lists below were found in a game cache (EU and US, 17 atlases of 6 × 6); a list is used only when
 * it covers every portrait of the catalog, and the caller can add the lists of a local game cache
 * for when Blizzard publishes a new one. The atlases are the same files on every server.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { encodePng, resizeRgba, type RgbaImage } from '@modkit/codec-kit/raster'
import { crop, decodeDepotImage } from '../content-sources/map-preview.js'
import type { DepotComponentRequest } from '../content-sources/public-depot.js'
import type { BattleNetPortrait } from '../content-sources/vfs-provider.js'

/** `.ldpt` handles (type, region, SHA-256) of the portrait texture list seen in a game cache on 2026-09-22. */
export const KNOWN_PORTRAIT_TEXTURE_LISTS: readonly string[] = [
  '6c64707400004555' + '7c4864605f8419247de2b633c04f5b8b806d470ca1610ff3830a89ae5ef8f244',
  '6c64707400005553' + '5ed0566082450b97929fd6f3b7f685b5034407fb8ffa60dd63cea3f21775e0ca',
]

const PORTRAIT_TAG = 0x504F5254
const DEFINITION_BYTES = 4 * 1024 * 1024
const LIST_BYTES = 1024 * 1024
const ATLAS_BYTES = 16 * 1024 * 1024
const PARALLEL = 6
const KEPT_IMAGES = 512
const KEPT_ATLASES = 3

export interface PortraitImagesOptions {
  readonly readComponent: (request: DepotComponentRequest) => Promise<Uint8Array>
  /** More `.ldpt` handles to consider after the known ones, e.g. those of a local game cache. */
  readonly textureLists?: (signal: AbortSignal) => Promise<readonly string[]>
}

export interface PortraitRequest {
  readonly region: string
  readonly portraitId: number
  /** Hex handles of the session's unlockable definition files (Toon Welcome). */
  readonly unlockableFiles: readonly string[]
  /** Longest side of the image (default 96). */
  readonly maxSize?: number
  readonly signal: AbortSignal
}

interface Placement { readonly texture: number; readonly cell: number }
interface Texture { readonly handle: string; readonly cols: number; readonly rows: number }

/** The top-level JSON objects of a Battlenet::Persistent object stream. */
export function objectStream(bytes: Uint8Array, limit = 100_000): Record<string, unknown>[] {
  const text = new TextDecoder().decode(bytes)
  const output: Record<string, unknown>[] = []
  let depth = 0, start = -1, inString = false, escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{') { if (depth++ === 0) start = index }
    else if (char === '}') {
      if (--depth < 0) throw new Error('Malformed object stream')
      if (depth === 0) {
        const value: unknown = JSON.parse(text.slice(start, index + 1))
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Malformed object stream')
        output.push(value as Record<string, unknown>)
        if (output.length > limit) throw new Error('Object stream too long')
      }
    }
  }
  if (depth !== 0 || inString) throw new Error('Truncated object stream')
  return output
}

const u32 = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= -0x80000000 && value <= 0xFFFFFFFF ? value >>> 0 : undefined
const small = (value: unknown, max: number): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Portrait id -> placement, when `objects` is the PORT definition file; undefined for another type. */
export function portraitCatalog(objects: readonly Record<string, unknown>[]): Map<number, Placement> | undefined {
  const header = objects[0]
  if (!header || u32(header['m_typeTag']) !== PORTRAIT_TAG) return undefined
  const catalog = new Map<number, Placement>()
  for (const entry of objects.slice(1)) {
    const id = u32(entry['m_unlockableId']), image = object(entry['m_imageHandle'])
    const texture = small(image?.['m_textureFileIndex'], 255), cell = small(image?.['m_offset'], 4095)
    if (id !== undefined && texture !== undefined && cell !== undefined) catalog.set(id, { texture, cell })
  }
  return catalog
}

/** Texture file index -> atlas of a `.ldpt` list; undefined when it is not a texture list. */
export function textureList(objects: readonly Record<string, unknown>[]): Texture[] | undefined {
  const header = objects[0]
  // m_usage is the FourCC 'ldpt' as a number.
  if (!header || u32(header['m_usage']) !== 0x6C647074) return undefined
  const textures: Texture[] = []
  for (let index = 1; index + 1 < objects.length; index += 2) {
    const handle = objects[index]?.['m_cacheHandle'], meta = objects[index + 1]
    const at = small(meta?.['m_textureFileIndex'], 255), cols = small(meta?.['m_textureCols'], 64), rows = small(meta?.['m_textureRows'], 64)
    if (typeof handle !== 'string' || !/^[a-f0-9]{80}$/iu.test(handle) || at === undefined || !cols || !rows) return undefined
    textures[at] = { handle: handle.toLowerCase(), cols, rows }
  }
  return textures
}

/**
 * Handles of the texture lists a local Battle.net cache holds (`<root>/<aa>/<bb>/<sha256>.ldpt`),
 * with no region: they are read from that cache, not from a depot.
 */
export async function cachedTextureLists(directory: string, signal: AbortSignal): Promise<string[]> {
  const handles: string[] = []
  const names = async (path: string) => (await readdir(path, { withFileTypes: true }).catch(() => []))
  for (const first of await names(directory)) {
    if (!first.isDirectory() || !/^[a-f0-9]{2}$/iu.test(first.name)) continue
    signal.throwIfAborted()
    for (const second of await names(join(directory, first.name))) {
      if (!second.isDirectory() || !/^[a-f0-9]{2}$/iu.test(second.name)) continue
      for (const file of await names(join(directory, first.name, second.name))) {
        const match = /^([a-f0-9]{64})\.ldpt$/iu.exec(file.name)
        if (file.isFile() && match) handles.push('6c647074' + '00000000' + match[1]!.toLowerCase())
      }
    }
  }
  return handles
}

/** `work` on every item, at most PARALLEL at a time. */
async function limited<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await work(items[next++] as T)
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker))
}

export function createPortraitImages(options: PortraitImagesOptions) {
  /** Definition file handle -> whether it is the portrait catalog (read once per process). */
  const kinds = new Map<string, boolean>()
  let catalog: { readonly key: string; readonly value: Promise<Map<number, Placement> | null> } | undefined
  let textures: { readonly key: string; readonly value: Promise<Texture[] | null> } | undefined
  const images = new Map<string, Promise<BattleNetPortrait | null>>()
  const atlases = new Map<string, Promise<RgbaImage | null>>()

  const read = (region: string, handle: string, maximumBytes: number, signal: AbortSignal) =>
    options.readComponent({ region, handle, maximumBytes, signal })

  /**
   * Every portrait definition file of the session, merged: the Welcome names more than one (on EU
   * 2026-09-27: the main catalog of 573 portraits and one of 17), so no single file has them all.
   */
  async function findCatalog(region: string, files: readonly string[], signal: AbortSignal): Promise<Map<number, Placement> | null> {
    const found: Map<number, Placement>[] = []
    let unread = 0
    await limited(files.filter(handle => kinds.get(handle) !== false), async handle => {
      signal.throwIfAborted()
      let placements: Map<number, Placement> | undefined
      try { placements = portraitCatalog(objectStream(await read(region, handle, DEFINITION_BYTES, signal))) } catch (error) {
        if (signal.aborted) throw error
        unread++
        return
      }
      kinds.set(handle, placements !== undefined)
      if (placements) found.push(placements)
    })
    // A partial catalog would answer "no portrait" for portraits it missed: only a complete read counts.
    if (unread) throw new Error(`${String(unread)} unlockable definition files could not be read`)
    return found.length ? new Map(found.flatMap(placements => [...placements])) : null
  }

  async function findTextures(region: string, placements: Map<number, Placement>, signal: AbortSignal): Promise<Texture[] | null> {
    const candidates = new Set([...KNOWN_PORTRAIT_TEXTURE_LISTS, ...(await options.textureLists?.(signal) ?? [])])
    let unread = 0
    for (const handle of candidates) {
      signal.throwIfAborted()
      let list: Texture[] | undefined
      try { list = textureList(objectStream(await read(region, handle, LIST_BYTES, signal))) } catch (error) {
        if (signal.aborted) throw error
        unread++
        continue
      }
      // The list of the portraits holds every atlas the catalog names, each with room for its cells.
      if (list && [...placements.values()].every(({ texture, cell }) => {
        const atlas = list![texture]
        return atlas !== undefined && cell < atlas.cols * atlas.rows
      })) return list
    }
    if (unread === candidates.size) throw new Error('No portrait texture list could be read')
    return null
  }

  function atlas(region: string, handle: string, signal: AbortSignal): Promise<RgbaImage | null> {
    const kept = atlases.get(handle)
    if (kept) return kept
    const value = read(region, handle, ATLAS_BYTES, signal).then(decodeDepotImage)
    value.catch(() => atlases.delete(handle))
    atlases.set(handle, value)
    while (atlases.size > KEPT_ATLASES) atlases.delete(atlases.keys().next().value as string)
    return value
  }

  async function render(request: PortraitRequest, size: number): Promise<BattleNetPortrait | null> {
    const { region, signal } = request
    const key = [...request.unlockableFiles].sort().join()
    if (catalog?.key !== key) {
      const value = findCatalog(region, request.unlockableFiles, signal)
      catalog = { key, value }
      value.catch(() => { if (catalog?.value === value) catalog = undefined })
    }
    const placements = await catalog.value
    if (!placements) return null
    const placement = placements.get(request.portraitId >>> 0)
    if (!placement) return null
    if (textures?.key !== key) {
      const value = findTextures(region, placements, signal)
      textures = { key, value }
      value.catch(() => { if (textures?.value === value) textures = undefined })
    }
    const list = await textures.value
    const texture = list?.[placement.texture]
    if (!texture) return null
    const image = await atlas(region, texture.handle, signal)
    if (!image) return null
    const width = Math.floor(image.width / texture.cols), height = Math.floor(image.height / texture.rows)
    const left = (placement.cell % texture.cols) * width, top = Math.floor(placement.cell / texture.cols) * height
    let cell = crop(image, left, top, left + width, top + height)
    const scale = size / Math.max(cell.width, cell.height)
    if (scale < 1) cell = resizeRgba(cell, Math.max(1, Math.round(cell.width * scale)), Math.max(1, Math.round(cell.height * scale)))
    return { id: request.portraitId >>> 0, width: cell.width, height: cell.height, png: await encodePng(cell.width, cell.height, cell.pixels, signal) }
  }

  return {
    /** The image of one portrait, or null when the catalog or its atlas does not have it. */
    image(request: PortraitRequest): Promise<BattleNetPortrait | null> {
      const size = Math.max(16, Math.min(256, request.maxSize ?? 96))
      const key = `${request.portraitId >>> 0}:${size}`
      const kept = images.get(key)
      if (kept) return kept
      const value = render(request, size)
      // A definite answer is kept; a failure (network, cancel) is asked again next time.
      value.catch(() => images.delete(key))
      images.set(key, value)
      while (images.size > KEPT_IMAGES) images.delete(images.keys().next().value as string)
      return value
    },
  }
}
