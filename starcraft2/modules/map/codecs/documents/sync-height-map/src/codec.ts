import { readSyncHeightMap, writeSyncHeightMap } from '../../../../shared/format/formats/sync-height-map.js'
import { createNumericGridCodec } from '../../../../shared/documents/numeric-grid-codec.js'

const codec = createNumericGridCodec({
  id: 'blizzard/sc2-sync-height-map', formatId: 'sc2-sync-height-map', label: 'StarCraft II synchronized height map', magic: 'SMAP', paths: [/(?:^|[\\/])(?:t3SyncHeightMap|mapSyncHeightMap)$/iu],
  read: readSyncHeightMap, write: writeSyncHeightMap,
  dimensions: data => [data.sizeX, data.sizeY], version: data => data.version,
  cell: (data, index) => ({ height: data.cells[index]!.height, mask: data.cells[index]!.mask }),
  setCell(data, index, input) {
    if (!Number.isSafeInteger(input['height']) || (input['height'] as number) < -32768 || (input['height'] as number) > 32767 || !Number.isSafeInteger(input['mask']) || (input['mask'] as number) < 0 || (input['mask'] as number) > 65535) throw new RangeError('height must be int16 and mask must be uint16')
    data.cells[index] = { height: input['height'] as number, mask: input['mask'] as number }
  },
  preserved: data => ({ headerExtraBytes: data._raw.headerExtra.length, trailingBytes: data._raw.trailing.length }),
})
export const operations = codec.operations
export const definition = codec.definition
export const createCodec = codec.createCodec
export const abiVersion = 1
