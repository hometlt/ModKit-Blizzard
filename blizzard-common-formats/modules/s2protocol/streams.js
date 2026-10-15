import { BitPackedDecoder, decodeEventStream } from './bitpacked.js'
import { asArray, asNumber, asString, asStruct, decodeVersioned } from './versioned.js'

const numberOr = (value, fallback = 0) =>
  typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : fallback

export function decodeReplayHeaderPayload(bytes, options) {
  const value = asStruct(decodeVersioned(bytes, options))
  const version = asStruct(value[1])
  const signature = asString(value[0])
  if (!signature.startsWith('StarCraft II replay')) {
    throw new TypeError(`s2protocol: unexpected replay signature ${JSON.stringify(signature)}`)
  }
  const result = {
    signature,
    version: {
      flags: asNumber(version[0]),
      major: asNumber(version[1]),
      minor: asNumber(version[2]),
      revision: asNumber(version[3]),
      build: asNumber(version[4]),
      baseBuild: asNumber(version[5]),
    },
    type: asNumber(value[2]),
    elapsedGameLoops: asNumber(value[3]),
  }
  if (value[4] !== undefined) result.scaledTime = asNumber(value[4])
  if (value[6] !== undefined) result.dataBuild = asNumber(value[6])
  return Object.freeze(result)
}

export function decodeReplayDetails(bytes, options) {
  const value = asStruct(decodeVersioned(bytes, options))
  const players = asArray(value[0] ?? []).map(item => {
    const player = asStruct(item)
    const color = asStruct(player[3] ?? {})
    const result = {
      name: player[0] === undefined ? '' : asString(player[0]),
      race: player[2] === undefined ? '' : asString(player[2]),
      color: {
        a: numberOr(color[0]),
        r: numberOr(color[1]),
        g: numberOr(color[2]),
        b: numberOr(color[3]),
      },
      control: numberOr(player[4]),
      teamId: numberOr(player[5]),
      handicap: numberOr(player[6]),
      observe: numberOr(player[7]),
      result: numberOr(player[8]),
    }
    if (player[9] !== undefined) result.workingSetSlotId = numberOr(player[9])
    return result
  })
  const result = {
    players,
    title: value[1] === undefined ? '' : asString(value[1]),
    isBlizzardMap: numberOr(value[4]) !== 0,
    timeUTC: typeof value[5] === 'bigint' ? value[5] : BigInt(numberOr(value[5])),
    timeLocalOffset: typeof value[6] === 'bigint' ? value[6] : BigInt(numberOr(value[6])),
  }
  try {
    const thumbnail = asStruct(value[3])
    if (thumbnail[0] !== undefined) result.mapFile = asString(thumbnail[0])
  } catch {}
  return result
}

export const decodeGameEvents = (bytes, protocol, options) =>
  decodeEventStream(bytes, protocol, 'game', options)
export const decodeMessageEvents = (bytes, protocol, options) =>
  decodeEventStream(bytes, protocol, 'message', options)

export function decodeReplayInitData(bytes, protocol, options) {
  if (protocol.replayInitdataTypeid == null)
    throw new TypeError('s2protocol: selected build has no init-data type')
  return new BitPackedDecoder(bytes, protocol.typeinfos, options).instance(
    protocol.replayInitdataTypeid,
  )
}

export function decodeReplayAttributes(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array))
    throw new TypeError('replay attributes input must be Uint8Array')
  const maxNodes = options.maxNodes ?? 100_000
  const legacyHeader = options.baseBuild !== undefined && options.baseBuild < 17_326
  const headerBytes = legacyHeader ? 8 : 9
  if (bytes.byteLength < headerBytes) throw new RangeError('replay.attributes.events is truncated')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const source = legacyHeader ? undefined : bytes[0]
  const mapNamespace = view.getUint32(legacyHeader ? 0 : 1, true)
  const declaredCount = view.getUint32(legacyHeader ? 4 : 5, true)
  const payloadBytes = bytes.byteLength - headerBytes
  if (payloadBytes % 13 !== 0) throw new RangeError('replay.attributes.events is truncated')
  const count = payloadBytes / 13
  if (count > maxNodes) throw new RangeError(`replay attributes exceed ${maxNodes} entries`)
  const result = []
  let offset = headerBytes
  for (let index = 0; index < count; index += 1) {
    options.signal?.throwIfAborted()
    if (offset + 13 > bytes.byteLength)
      throw new RangeError('replay.attributes.events is truncated')
    const namespace = view.getUint32(offset, true)
    const id = view.getUint32(offset + 4, true)
    const scope = bytes[offset + 8]
    const value = new TextDecoder('latin1')
      .decode(bytes.subarray(offset + 9, offset + 13))
      .replace(/\0+$/u, '')
      .split('')
      .reverse()
      .join('')
    result.push({ namespace, id, scope, value })
    offset += 13
  }
  return Object.freeze({ source, mapNamespace, declaredCount, attributes: Object.freeze(result) })
}

/**
 * Decode the undocumented loading-screen sidecar as its stable little-endian word layout.
 * The first twelve words correspond to SC2 player slots; unknown trailing words and bytes remain
 * explicit so callers do not have to guess field meanings.
 */
export function decodeReplayLoadInfo(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('replay load info input must be Uint8Array')
  const maxScalarBytes = options.maxScalarBytes ?? 16 * 1024 * 1024
  if (!Number.isSafeInteger(maxScalarBytes) || maxScalarBytes <= 0) {
    throw new RangeError('replay load info maxScalarBytes must be a positive safe integer')
  }
  if (bytes.byteLength > maxScalarBytes) {
    throw new RangeError(`replay.load.info exceeds ${maxScalarBytes} bytes`)
  }
  options.signal?.throwIfAborted()
  const raw = bytes.slice()
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const valueByteLength = raw.byteLength - (raw.byteLength % 4)
  const values = []
  for (let offset = 0; offset < valueByteLength; offset += 4) {
    options.signal?.throwIfAborted()
    values.push(view.getUint32(offset, true))
  }
  return Object.freeze({
    raw,
    values: Object.freeze(values),
    playerSlots: Object.freeze(
      values.slice(0, 12).map((value, index) => Object.freeze({ slot: index + 1, value })),
    ),
    extraValues: Object.freeze(values.slice(12)),
    isEmpty: values.every(value => value === 0),
    trailingBytes: raw.slice(valueByteLength),
  })
}
