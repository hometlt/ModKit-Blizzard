/**
 * A string table as a host-bound companion: `rez\stat_txt.tbl`, which names units, weapons,
 * upgrades and technologies, or a data table's own `arr\<file>.tbl`. Found where the tileset is: in
 * the storage the subject lies in, beside it, or in the installation behind it.
 */
import type { AssetInput } from '@modkit/sdk'
import { readTbl, type StringTable } from './tbl.js'

export const STAT_TXT = 'rez/stat_txt.tbl'
/** A string table is tens of KiB; this is far past any the game has. */
const MAX_TABLE_BYTES = 4 << 20

export function stringTableRequirement(id: string, path: string) {
  return Object.freeze({
    id,
    role: 'localization',
    ownership: 'companion' as const,
    patterns: Object.freeze([path]),
    scopes: Object.freeze(['sibling-directory', 'current-mount', 'enclosing-container', 'workspace-dependency-layer']),
    cardinality: 'zero-or-one' as const,
    // Without its strings a subject still opens; what they would name stays a number.
    required: false as const,
  })
}

export interface LoadedStringTable {
  readonly table?: StringTable
  readonly bindingIds: readonly string[]
  readonly note?: string
}

export async function loadStringTable(
  input: AssetInput,
  requirementId: string,
  path: string,
  decode: (bytes: Uint8Array) => string,
  signal?: AbortSignal,
): Promise<LoadedStringTable> {
  if (input.originKind === 'derived') return { bindingIds: [] }
  const bound = input.bindingsFor(requirementId)
  const bindingIds = bound.map(binding => binding.bindingId)
  const binding = bound[0]
  if (binding === undefined) return { bindingIds, note: `${path} is not bound; names stay numbers` }
  const lease = await input.openBinding(binding.bindingId, signal)
  try {
    const source = lease.value
    if (source.kind !== 'bytes' || (source.size ?? 0n) > BigInt(MAX_TABLE_BYTES)) return { bindingIds, note: `${path} is not a readable string table` }
    return { bindingIds, table: readTbl(await source.read(0n, Number(source.size ?? 0n), signal), decode) }
  } catch (error) {
    return { bindingIds, note: `${path}: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    await lease.release()
  }
}
