import { createPaintedLayer } from '../../../../shared/documents/painted-layer-codec.js'
const codec = createPaintedLayer({ id: 'blizzard/sc2-painted-creep', formatId: 'sc2-painted-creep', label: 'StarCraft II painted creep layer', fileName: 'PaintedCreepLayer', semanticKnown: false })
export const { definition, operations, inspectOperationId, createCodec } = codec
export const abiVersion = 1
