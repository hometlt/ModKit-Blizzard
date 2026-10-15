import type { PrimitiveFieldMeta, M3PrimitiveType } from '../types.js'

export const PRIMITIVE_FIELD_INFO: Record<M3PrimitiveType, PrimitiveFieldMeta> = {
  uint8: { size: 1, getter: 'getUint8', setter: 'setUint8' },
  int16: { size: 2, getter: 'getInt16', setter: 'setInt16' },
  uint16: { size: 2, getter: 'getUint16', setter: 'setUint16' },
  int32: { size: 4, getter: 'getInt32', setter: 'setInt32' },
  uint32: { size: 4, getter: 'getUint32', setter: 'setUint32' },
  uint64: { size: 8, getter: 'getBigUint64', setter: 'setBigUint64' },
  float: { size: 4, getter: 'getFloat32', setter: 'setFloat32' },
}

/** Names of primitive structures that store a single scalar value. */
export const PRIMITIVE_STRUCTURE_NAMES = new Set([
  'U8__',
  'I16_',
  'U16_',
  'I32_',
  'U32_',
  'I64_',
  'U64_',
  'FLAG',
  'REAL',
  'CHAR',
])
