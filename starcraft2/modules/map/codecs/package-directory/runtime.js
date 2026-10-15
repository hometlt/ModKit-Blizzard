import { createSc2MapCodec } from '../../../../dist/modules/map/codecs/package/portable/codec.mjs'

export const abiVersion = 1
// The loose (folder) map is the same map codec over a mounted directory: its declared map
// operations (embedded, world, render, …) need the map handlers, not the bare namespace codec.
export const createCodec = context =>
  createSc2MapCodec({ loose: true, id: 'blizzard/sc2-map-directory' }, context)
