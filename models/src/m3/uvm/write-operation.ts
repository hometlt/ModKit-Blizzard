import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import type { JsonObject, JsonValue, ResourceBudget } from '@modkit/sdk'
import { readUvmContainer } from '@modkit/uv/model/container'
import { prepareUvmEditRequest } from '@modkit/scene/uvm'
import { exportFreshM3FromUvm } from '../../../src/m3/runtime/fresh-export.js'

/** Primary model.write route consumes the common working document and its bounded format residual.
 * This only prepares output bytes;
 * it does not edit the opened native source or create a transaction/history implementation. */
export async function writeM3UvmRequest(
  value: JsonValue,
  budget: ResourceBudget,
  signal?: AbortSignal,
  requestedFormat?: 'm3' | 'm3a',
): Promise<{ readonly kind: 'bytes'; readonly value: Uint8Array }> {
  signal?.throwIfAborted()
  const request = snapshotJson(
    value,
    {
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
      maxBytes: budget.maxScalarBytes,
    },
    signal,
  )
  if (request === null || typeof request !== 'object' || Array.isArray(request))
    throw new TypeError('model.write requires a UVM request object')
  const input = request as JsonObject,
    hex = input['uvmBytesHex']
  if (
    input['schemaVersion'] !== 1 ||
    typeof hex !== 'string' ||
    hex.length === 0 ||
    hex.length % 2 !== 0 ||
    Object.keys(input).some(
      key =>
        !['schemaVersion', 'uvmBytesHex', 'metersPerNativeUnit', 'json', 'binary'].includes(key),
    )
  )
    throw new TypeError('model.write UVM input requires {schemaVersion: 1, uvmBytesHex}')
  const byteLength = hex.length / 2
  if (
    BigInt(byteLength) > budget.maxInputBytes ||
    byteLength > budget.maxScalarBytes ||
    byteLength > 0xffffffff
  )
    throw new RangeError('model.write UVM input exceeds byte budget')
  if (!/^[0-9a-fA-F]+$/u.test(hex)) throw new TypeError('model.write UVM bytes must be hexadecimal')
  const bytes = new Uint8Array(byteLength)
  for (let index = 0; index < bytes.length; index++) {
    if ((index & 4095) === 0) signal?.throwIfAborted()
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  const containerBudget = {
    maxInputBytes: Number(budget.maxInputBytes > 0xffffffffn ? 0xffffffffn : budget.maxInputBytes),
    maxJsonBytes: budget.maxScalarBytes,
    maxDepth: budget.maxDepth,
    maxNodes: budget.maxNodes,
  }
  let container = readUvmContainer(bytes, containerBudget, signal)
  const hasNativeEnvelope = (extras: JsonValue | undefined) =>
    extras !== null &&
    typeof extras === 'object' &&
    !Array.isArray(extras) &&
    Object.hasOwn(extras, 'BlizzardM3')
  const hadFormatResidual = hasNativeEnvelope(container.document['extras'])
  if (Object.hasOwn(input, 'json') || Object.hasOwn(input, 'binary')) {
    const candidate = prepareUvmEditRequest(
      bytes,
      {
        ...(Object.hasOwn(input, 'json') ? { json: input['json'] as JsonValue } : {}),
        ...(Object.hasOwn(input, 'binary') ? { binary: input['binary'] as JsonValue } : {}),
      },
      { budget: containerBudget, ...(signal === undefined ? {} : { signal }) },
    )
    container = readUvmContainer(candidate, containerBudget, signal)
  }
  // A format-aware working document keeps its residual across common scene edits.
  const hasFormatResidual = hadFormatResidual || hasNativeEnvelope(container.document['extras'])
  const nativeEnvelope = hasFormatResidual
    ? ((container.document['extras'] as JsonObject)['BlizzardM3'] as JsonObject)
    : undefined
  const native = await encodeM3UvmContainer(
    container,
    budget,
    signal,
    requestedFormat,
    hasFormatResidual,
    nativeEnvelope,
    input['metersPerNativeUnit'],
  )
  signal?.throwIfAborted()
  return { kind: 'bytes', value: native }
}

async function encodeM3UvmContainer(
  container: ReturnType<typeof readUvmContainer>,
  budget: ResourceBudget,
  signal: AbortSignal | undefined,
  requestedFormat: 'm3' | 'm3a' | undefined,
  hasFormatResidual: boolean,
  nativeEnvelope: JsonObject | undefined,
  requestedUnits: JsonValue | undefined,
  materialPolicy: 'strict' | 'base-color-coverage' = 'strict',
  notes: string[] = [],
): Promise<Uint8Array> {
  const containerBudget = {
    maxInputBytes: Number(budget.maxInputBytes > 0xffffffffn ? 0xffffffffn : budget.maxInputBytes),
    maxJsonBytes: budget.maxScalarBytes,
    maxDepth: budget.maxDepth,
    maxNodes: budget.maxNodes,
  }
  if (hasFormatResidual) {
    if (requestedUnits !== undefined)
      throw new TypeError('format-aware M3 export uses UV_units from the working document')
    if (nativeEnvelope?.['schemaVersion'] !== 1)
      throw new TypeError('BlizzardM3 UVM requires source-free schemaVersion 1')
    const sourceFormat = nativeEnvelope['format']
    if (sourceFormat !== 'm3' && sourceFormat !== 'm3a')
      throw new TypeError('source-free BlizzardM3 residual requires an M3 family format')
    const targetFormat = requestedFormat ?? sourceFormat
    const units = ((container.document['extensions'] as JsonObject | undefined)?.[
      'UV_units'
    ] as JsonObject | undefined)?.['metersPerSourceUnit']
    if (typeof units !== 'number' || !Number.isFinite(units) || units <= 0)
      throw new TypeError('source-free M3 UVM requires positive UV_units.metersPerSourceUnit')
    return exportFreshM3FromUvm(container, units, budget, signal, targetFormat, notes, materialPolicy)
  }
  const units = requestedUnits ?? 1
  if (typeof units !== 'number' || !Number.isFinite(units) || units <= 0)
    throw new TypeError('fresh M3 requires positive metersPerNativeUnit')
  return exportFreshM3FromUvm(container, units, budget, signal, requestedFormat ?? 'm3', notes, materialPolicy)
}

/** Direct capability path: owned UVM bytes in, native model bytes out, without hexadecimal JSON. */
export async function encodeM3UvmBytes(
  bytes: Uint8Array,
  budget: ResourceBudget,
  signal?: AbortSignal,
  requestedFormat: 'm3' | 'm3a' = 'm3',
  metersPerNativeUnit?: number,
  materialPolicy: 'strict' | 'base-color-coverage' = 'strict',
  /** Conversion losses, passed to the native encoder's diagnostic result. */
  notes: string[] = [],
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  if (!(bytes instanceof Uint8Array)) throw new TypeError('native M3 encoder requires UVM bytes')
  if (BigInt(bytes.byteLength) > budget.maxInputBytes || bytes.byteLength > budget.maxScalarBytes)
    throw new RangeError('native M3 encoder UVM exceeds byte budget')
  const containerBudget = {
    maxInputBytes: Number(budget.maxInputBytes > 0xffffffffn ? 0xffffffffn : budget.maxInputBytes),
    maxJsonBytes: budget.maxScalarBytes,
    maxDepth: budget.maxDepth,
    maxNodes: budget.maxNodes,
  }
  const container = readUvmContainer(bytes, containerBudget, signal)
  const extras = container.document['extras']
  const envelope =
    extras !== null && typeof extras === 'object' && !Array.isArray(extras)
      ? ((extras as JsonObject)['BlizzardM3'] as JsonObject | undefined)
      : undefined
  return encodeM3UvmContainer(
    container,
    budget,
    signal,
    requestedFormat,
    envelope !== undefined,
    envelope,
    metersPerNativeUnit,
    materialPolicy,
    notes,
  )
}
