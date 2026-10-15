import { readCellFlags, writeCellFlags } from '../../../../shared/format/formats/cell-flags.js'
import { createNumericGridCodec } from '../../../../shared/documents/numeric-grid-codec.js'
const codec = createNumericGridCodec({
  id: 'blizzard/sc2-cell-flags', formatId: 'sc2-cell-flags', label: 'StarCraft II terrain cell flags', magic: 'LFCT', paths: [/(?:^|[\\/])(?:t3CellFlags|mapCellFlags)$/iu],
  read: readCellFlags, write: writeCellFlags, dimensions: data => [data.sizeX, data.sizeY], version: data => data.version,
  cell: (data, index) => ({ type: data.types[index]! }),
  setCell(data, index, input) { if (!Number.isSafeInteger(input['type']) || (input['type'] as number) < 0 || (input['type'] as number) > 255) throw new RangeError('type must be uint8'); data.types[index] = input['type'] as number },
  preserved: data => ({ zeroBytes: data._raw.zero.length, trailingBytes: data._raw.trailing.length }),
})
export const operations = codec.operations
export const definition = codec.definition
export const createCodec = codec.createCodec
export const abiVersion = 1
