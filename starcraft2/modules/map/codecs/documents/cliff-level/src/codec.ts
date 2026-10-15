import { readSyncCliffLevel, writeSyncCliffLevel } from '../../../../shared/format/formats/sync-cliff-level.js'
import { createNumericGridCodec } from '../../../../shared/documents/numeric-grid-codec.js'
const codec = createNumericGridCodec({
  id: 'blizzard/sc2-cliff-level', formatId: 'sc2-cliff-level', label: 'StarCraft II synchronized cliff level', magic: 'CLIF', paths: [/(?:^|[\\/])(?:t3SyncCliffLevel|mapSyncCliffLevel)$/iu],
  read: readSyncCliffLevel, write: writeSyncCliffLevel, dimensions: data => [data.sizeX, data.sizeY], version: data => data.version,
  cell: (data, index) => ({ height: data.heights[index]! }),
  setCell(data, index, input) { if (!Number.isSafeInteger(input['height']) || (input['height'] as number) < 0 || (input['height'] as number) > 65535) throw new RangeError('height must be uint16'); data.heights[index] = input['height'] as number },
  preserved: data => ({ paddingBytes: data._raw.padding.length, trailingBytes: data._raw.trailing.length }),
})
export const operations = codec.operations
export const definition = codec.definition
export const createCodec = codec.createCodec
export const abiVersion = 1
