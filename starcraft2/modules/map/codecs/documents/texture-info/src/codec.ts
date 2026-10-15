import { readSyncTextureInfo, writeSyncTextureInfo } from '../../../../shared/format/formats/sync-texture-info.js'
import { createNumericGridCodec } from '../../../../shared/documents/numeric-grid-codec.js'
const codec = createNumericGridCodec({
  id: 'blizzard/sc2-texture-info', formatId: 'sc2-texture-info', label: 'StarCraft II synchronized texture info', magic: 'RTXT', paths: [/(?:^|[\\/])(?:t3SyncTextureInfo|mapSyncTextureInfo)$/iu],
  read: readSyncTextureInfo, write: writeSyncTextureInfo, dimensions: data => [data.sizeX, data.sizeY], version: data => data.version,
  cell: (data, index) => ({ textureIndex: data.cells[index]! }),
  setCell(data, index, input) { if (!Number.isSafeInteger(input['textureIndex']) || (input['textureIndex'] as number) < 0 || (input['textureIndex'] as number) > 0xffffffff) throw new RangeError('textureIndex must be uint32'); data.cells[index] = input['textureIndex'] as number },
  preserved: data => ({ textureNames: data.textureNames.length }),
})
export const operations = codec.operations
export const definition = codec.definition
export const createCodec = codec.createCodec
export const abiVersion = 1
