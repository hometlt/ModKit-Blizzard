/**
 * A scenario's tileset as a host-bound companion. The files lie in the game's `tileset\` folder: in
 * the storage a campaign scenario is read from (enclosing container), beside a scenario extracted
 * with its tilesets (sibling directory), or in the installation behind a map (the subject's
 * workspace dependency layer). The codec reads the scenario's era from its first bytes and asks for
 * that era's five files by name.
 */
import { parsePalette } from '@modkit/codec-kit/raster/palette'
import type { AssetInput } from '@modkit/sdk'
import { TILESET_FILES } from '../chk/scenario.js'
import { fileNameOf } from '../uri.js'
import { readTileset, type Tileset } from './tileset.js'

export const TILESET_REQUIREMENT_ID = 'tileset'

/**
 * The tileset companion requirement: the five files of `era` (a TILESET_FILES index), or of every
 * era when the scenario's era is not known yet. Files are named, not globbed: `*.vr4` would also
 * bind Remastered's HD `*.dds.vr4` (40–76 MiB each), and binding a file costs its read.
 */
export function tilesetRequirement(era?: number) {
  const eras = era === undefined ? TILESET_FILES : [TILESET_FILES[era]!]
  return Object.freeze({
    id: TILESET_REQUIREMENT_ID,
    role: 'tileset',
    ownership: 'companion' as const,
    patterns: Object.freeze(eras.flatMap(name => ['cv5', 'vx4ex', 'vx4', 'vr4', 'vf4', 'wpe'].map(extension => `tileset/${name}.${extension}`))),
    scopes: Object.freeze(['sibling-directory', 'current-mount', 'enclosing-container', 'workspace-dependency-layer']),
    cardinality: 'many' as const,
    // A scenario without its tileset still opens: tiles as numbers, no terrain image.
    required: false as const,
  })
}

export interface LoadedTileset {
  readonly tileset?: Tileset
  /** Every tileset file the host bound, read or not: the descriptor names them all. */
  readonly bindingIds: readonly string[]
  readonly note?: string
}

/**
 * Reads the era's five files from the bindings of `requirementIds`; `cv5`, when given, is the one
 * already open (a tileset opened by its `.cv5`).
 */
export async function loadTileset(
  input: AssetInput,
  era: string,
  maxBytes: number,
  maxNodes: number,
  signal?: AbortSignal,
  requirementIds: readonly string[] = [TILESET_REQUIREMENT_ID],
  cv5?: Uint8Array,
): Promise<LoadedTileset> {
  // A derived input (a subject made from other subjects) binds no files.
  if (input.originKind === 'derived') return { bindingIds: [] }
  const bound = requirementIds.flatMap(id => input.bindingsFor(id))
  const bindingIds = bound.map(binding => binding.bindingId)
  const byName = new Map(bound.map(binding => [fileNameOf(binding.source.uri), binding.bindingId]))
  const read = async (name: string): Promise<Uint8Array | undefined> => {
    const bindingId = byName.get(name)
    if (bindingId === undefined) return undefined
    const lease = await input.openBinding(bindingId, signal)
    try {
      const source = lease.value
      if (source.kind !== 'bytes') return undefined
      const size = Number(source.size ?? 0n)
      if (size > maxBytes) throw new RangeError(`${name} is ${String(size)} bytes, more than ${String(maxBytes)}`)
      return await source.read(0n, size, signal)
    } finally {
      await lease.release()
    }
  }
  try {
    const wide = byName.has(`${era}.vx4ex`)
    const [groups, vx4, vr4, vf4, wpe] = await Promise.all([
      cv5 ?? read(`${era}.cv5`),
      read(`${era}.${wide ? 'vx4ex' : 'vx4'}`),
      read(`${era}.vr4`),
      read(`${era}.vf4`),
      read(`${era}.wpe`),
    ])
    if (groups === undefined || vx4 === undefined || vr4 === undefined || vf4 === undefined || wpe === undefined)
      return { bindingIds, note: `the ${era} tileset is not bound; the terrain is shown as tile numbers only` }
    return { bindingIds, tileset: readTileset({ cv5: groups, vx4, wide, vr4, vf4, colors: parsePalette(wpe, maxNodes).colors }) }
  } catch (error) {
    return { bindingIds, note: `the ${era} tileset did not read: ${error instanceof Error ? error.message : String(error)}` }
  }
}
