import type { M3StructureHistory } from './structures.js'

/** Global registry of parsed M3 structure histories keyed by structure name. */
let structures: Record<string, M3StructureHistory> = {}

/** Get the current structures registry. */
export function getStructures(): Record<string, M3StructureHistory> {
  return structures
}

/** Replace the entire structures registry. */
export function setStructures(newStructures: Record<string, M3StructureHistory>): void {
  structures = newStructures
}
