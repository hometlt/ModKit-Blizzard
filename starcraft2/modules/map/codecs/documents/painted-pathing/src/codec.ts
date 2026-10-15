import { createPaintedLayer } from '../../../../shared/documents/painted-layer-codec.js'
const codec = createPaintedLayer({ id: 'blizzard/sc2-painted-pathing', formatId: 'sc2-painted-pathing', label: 'StarCraft II painted pathing layer', fileName: 'PaintedPathingLayer', semanticKnown: true })
export const { definition, operations, inspectOperationId, createCodec } = codec
export const abiVersion = 1
