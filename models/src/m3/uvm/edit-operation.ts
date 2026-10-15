import type { JsonObject, JsonValue, AssetEditPlan } from '@modkit/sdk'
import type { InspectionContext } from '@modkit/codec-kit'
import { editPlanFromBinding, replaceBytes } from '@modkit/codec-kit/editing'
import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import { sha256Hex } from '@modkit/codec-kit/crypto/digest'
import { prepareUvmEditRequest } from '@modkit/scene/uvm'
import { readUvmContainer } from '@modkit/uv/model/container'
import { exportFreshM3FromUvm } from '../../../src/m3/runtime/fresh-export.js'

export type M3SceneImporter = (
  request: { schemaVersion: 1; metersPerSourceUnit: number },
  options: { signal?: AbortSignal },
) => Promise<{ kind: 'bytes'; value: Uint8Array }>

/** Operation wiring only. Scene owns JSON/BIN edits/history and the native converter owns field
 * mappings. Capture the complete opened bundle before any asynchronous conversion or hashing. */
export async function prepareM3UvmEdit(
  source: Uint8Array,
  value: JsonValue,
  context: InspectionContext,
  importScene: M3SceneImporter,
  signal?: AbortSignal,
): Promise<{ kind: 'edit-plan'; plan: AssetEditPlan }> {
  signal?.throwIfAborted()
  const budget = {
    maxDepth: context.budget.maxDepth,
    maxNodes: context.budget.maxNodes,
    maxJsonBytes: context.budget.maxScalarBytes,
    maxInputBytes: Number(
      context.budget.maxInputBytes > 0xffffffffn ? 0xffffffffn : context.budget.maxInputBytes,
    ),
  }
  const request = snapshotJson(
    value,
    { maxDepth: budget.maxDepth, maxNodes: budget.maxNodes, maxBytes: budget.maxJsonBytes },
    signal,
  )
  if (request === null || typeof request !== 'object' || Array.isArray(request))
    throw new TypeError('model.edit requires an object')
  const input = request as JsonObject
  const scale = input['metersPerSourceUnit']
  if (
    input['schemaVersion'] !== 1 ||
    typeof scale !== 'number' ||
    !Number.isFinite(scale) ||
    scale <= 0 ||
    (Object.hasOwn(input, 'json') && !Array.isArray(input['json'])) ||
    (Object.hasOwn(input, 'binary') && !Array.isArray(input['binary'])) ||
    Object.keys(input).some(
      key => !['schemaVersion', 'metersPerSourceUnit', 'json', 'binary'].includes(key),
    )
  )
    throw new TypeError(
      'model.edit requires schemaVersion 1, positive metersPerSourceUnit, and json/binary edit arrays',
    )
  if (source.length > budget.maxInputBytes) throw new RangeError('M3 source exceeds maxInputBytes')
  const byteLength = source.length
  const bindingId = context.primary.bindingId
  const base = editPlanFromBinding(context.input, bindingId, {
    planId: `m3-uvm-edit:${context.input.revisions.revision}`,
    edits: [],
    fidelity: {
      roundTrip: 'semantic',
      preservesUnknownData: false,
      notes: [
        'M3 is regenerated from common UVM scene data and the bounded BlizzardM3 residual. Source bytes are never embedded in UVM.',
      ],
    },
  })
  const operationOptions = signal === undefined ? {} : { signal }
  const imported = await importScene(
    { schemaVersion: 1, metersPerSourceUnit: scale },
    operationOptions,
  )
  signal?.throwIfAborted()
  const importedContainer = readUvmContainer(imported.value, budget, signal)
  const document = importedContainer.document
  const object = (value: unknown): JsonObject => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new TypeError('M3 source-free residual is absent')
    return value as JsonObject
  }
  const envelope = object(object(document['extras'])['BlizzardM3'])
  if (envelope['schemaVersion'] !== 1)
    throw new TypeError('M3 edit requires source-free BlizzardM3 schemaVersion 1')
  const format = envelope['format']
  if (format !== 'm3' && format !== 'm3a')
    throw new TypeError('M3 edit residual has an invalid native format')
  const edited = prepareUvmEditRequest(
    imported.value,
    { json: input['json'] ?? [], binary: input['binary'] ?? [] },
    { budget, ...operationOptions },
  )
  const candidate = await exportFreshM3FromUvm(
    readUvmContainer(edited, budget, signal),
    scale,
    context.budget,
    signal,
    format,
  )
  const digest = await sha256Hex(candidate)
  signal?.throwIfAborted()
  const target = base.targets.find(item => item.targetId === bindingId)
  if (target === undefined) throw new TypeError('M3 edit target is absent')
  return {
    kind: 'edit-plan',
    plan: Object.freeze({
      ...base,
      planId: `${base.planId}:${digest}`,
      edits: Object.freeze([
        Object.freeze({
          ...replaceBytes(0, byteLength, candidate, 'Edit M3 through UVM scene'),
          targetId: target.targetId,
          source: target.ownerSource,
        }),
      ]),
    }),
  }
}
