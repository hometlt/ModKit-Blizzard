import type { GalaxySymbolTreeNode } from '../../../../../dist/modules/galaxy/services/analysis/types.js'

/** Consume the Galaxy owner's prior build; mixing its source with dist declarations collides at emit. */
export type GalaxyResourceSymbol = GalaxySymbolTreeNode

export function galaxySymbols(text: string, path: string): readonly GalaxyResourceSymbol[]
