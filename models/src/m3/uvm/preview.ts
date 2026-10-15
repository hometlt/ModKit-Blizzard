import type { JsonObject, JsonValue, ModelNode } from '@modkit/sdk'
import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import { previewFrameFromInverseBind, previewCameraNodeMatrix } from '@modkit/scene/uvm/cameras'

export interface M3StaticPreviewSource {
  /** Existing native buildCameras/buildLights values; no native records are decoded here. */
  readonly cameras: readonly JsonObject[]
  readonly lights: readonly JsonObject[]
  /** Complete source-local IREF correspondence indexed by native bone. Missing bind = null. */
  readonly inverseBindMatrices: readonly (readonly number[] | null)[]
}
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('M3 preview record absent')
  return value as JsonObject
}
function list(value: unknown): readonly JsonValue[] {
  if (!Array.isArray(value)) throw new TypeError('M3 preview array absent')
  return value as readonly JsonValue[]
}
function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
function nonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
function vector(value: unknown): readonly [number, number, number] {
  const values = list(value)
  if (
    values.length !== 3 ||
    values.some(item => typeof item !== 'number' || !Number.isFinite(item))
  )
    throw new TypeError('M3 preview vector must have three finite components')
  return [Number(values[0]), Number(values[1]), Number(values[2])]
}
function mappedSequenceAnimation(
  value: unknown,
  mapping: Readonly<Record<string, { readonly target: string; readonly scale?: number }>>,
): JsonObject | undefined {
  if (value === undefined) return undefined
  const source = object(value)
  if (Object.keys(source).some(key => !Object.hasOwn(mapping, key)))
    throw new TypeError('M3 preview animation contains an unsupported field')
  const result: Record<string, JsonValue> = {}
  for (const [key, candidate] of Object.entries(source)) {
    const target = mapping[key]!
    const entries = list(candidate).map(raw => {
      const entry = object(raw), track = object(entry['track'])
      const keys = list(track['keys']).map(rawKey => {
        const item = object(rawKey), scaled: Record<string, JsonValue> = { ...item }
        for (const property of ['vector', 'inTan', 'outTan']) {
          if (item[property] === undefined) continue
          scaled[property] = list(item[property]).map(component => {
            if (typeof component !== 'number' || !Number.isFinite(component))
              throw new TypeError('M3 preview animation key is invalid')
            return component * (target.scale ?? 1)
          })
        }
        return scaled
      })
      return { ...entry, track: { ...track, keys } }
    })
    result[target.target] = entries
  }
  return Object.keys(result).length === 0 ? undefined : result
}

/** The projection node the preview camera sits on: a root, in M3's own frame. */
export const M3_PREVIEW_CAMERA_NODE = 'm3/preview-camera'

/** One first-valid rest camera and at most four rest lights, plus already-resolved sequence tracks,
 * as the materializer's projection takes them: the camera on a root node of its own and the lights
 * in the source frame, both in M3's axes and units. This boundary evaluates no native records,
 * acquires no resources and does not override the caller's camera selection. */
export function projectM3StaticPreview(
  source: M3StaticPreviewSource,
  options: {
    readonly cameraBoneNodeIds?: readonly string[]
    readonly metersPerSourceUnit: number
    readonly budget: { readonly maxDepth: number; readonly maxNodes: number; readonly maxJsonBytes: number }
    readonly signal?: AbortSignal
  },
): {
  readonly node?: ModelNode
  readonly cameraParentNodeId?: string
  readonly camera?: { readonly nodeId: string; readonly camera: JsonObject; readonly sequenceAnimation?: JsonObject }
  readonly lights?: { readonly ambient: readonly [number, number, number]; readonly lights: readonly JsonObject[] }
  readonly diagnostics: readonly string[]
  /** The native correspondence; the caller adds the document's camera and node indices. */
  readonly mapping: JsonObject
} {
  const { budget, signal } = options
  signal?.throwIfAborted()
  if (!Number.isFinite(options.metersPerSourceUnit) || options.metersPerSourceUnit <= 0)
    throw new TypeError('M3 preview requires explicit positive source units')
  const native = object(
    snapshotJson(
      source,
      { maxDepth: budget.maxDepth, maxNodes: budget.maxNodes, maxBytes: budget.maxJsonBytes },
      signal,
    ),
  )
  const frames = list(native['inverseBindMatrices'])
  const diagnostics: string[] = []
  const frame = (record: JsonObject, label: string) => {
    const bone = record['boneIndex']
    if (
      typeof bone !== 'number' ||
      !Number.isSafeInteger(bone) ||
      bone < 0 ||
      bone >= frames.length ||
      frames[bone] === null
    ) {
      diagnostics.push(`${label}: missing native inverse-bind correspondence`)
      return undefined
    }
    const values = list(frames[bone])
    if (values.length !== 16 || values.some(value => typeof value !== 'number'))
      throw new TypeError('M3 preview inverse-bind matrix malformed')
    try {
      return previewFrameFromInverseBind(values.map(Number))
    } catch (error) {
      diagnostics.push(`${label}: ${error instanceof Error ? error.message : 'invalid bind frame'}`)
      return undefined
    }
  }
  let cameraMapping: JsonObject | undefined
  let camera: { nodeId: string; camera: JsonObject; sequenceAnimation?: JsonObject } | undefined
  let node: ModelNode | undefined
  let cameraParentNodeId: string | undefined
  for (const [index, raw] of list(native['cameras']).entries()) {
    signal?.throwIfAborted()
    const record = object(raw),
      pose = frame(record, `camera/${index}`)
    if (pose === undefined) continue
    const near = positive(record['nearClip'], 0.1),
      sourceFar = positive(record['farClip'], 10000)
    const far = sourceFar > near ? sourceFar : Math.max(near * 2, 10000)
    const fov = Math.max(0.01, Math.min(Math.PI - 0.01, positive(record['fieldOfView'], 0.5)))
    const target: readonly [number, number, number] = [
      pose.position[0] + pose.forward[0],
      pose.position[1] + pose.forward[1],
      pose.position[2] + pose.forward[2],
    ]
    const up: readonly [number, number, number] =
      Math.abs(pose.forward[2]) > 0.95 ? [0, 1, 0] : [0, 0, 1]
    // glTF clip distances are not scaled by the nodes above the camera: they are in metres.
    const znear = near * options.metersPerSourceUnit,
      zfar = far * options.metersPerSourceUnit
    if (!Number.isFinite(znear) || !Number.isFinite(zfar) || !(zfar > znear) || znear <= 0)
      throw new RangeError('M3 preview camera clip distances overflow source units')
    const sequenceAnimation = mappedSequenceAnimation(record['sequenceAnimation'], {
      fieldOfView: { target: 'yfov' },
      nearClip: { target: 'znear', scale: options.metersPerSourceUnit },
      farClip: { target: 'zfar', scale: options.metersPerSourceUnit },
    })
    cameraParentNodeId = options.cameraBoneNodeIds?.[Number(record['boneIndex'])]
    camera = {
      nodeId: M3_PREVIEW_CAMERA_NODE,
      camera: {
        type: 'perspective',
        perspective: { yfov: fov, znear, zfar },
        ...(typeof record['name'] === 'string' ? { name: record['name'] } : {}),
      },
      ...(sequenceAnimation === undefined ? {} : { sequenceAnimation }),
    }
    cameraMapping = {
      nativeIndex: index,
      boneIndex: record['boneIndex'] ?? -1,
      authoredFovAxis: record['useVerticalFov'] ? 'vertical' : 'horizontal',
      policy: 'pinned-fov-treated-as-vertical',
    }
    node = {
      id: M3_PREVIEW_CAMERA_NODE,
      ...(typeof record['name'] === 'string' ? { name: record['name'] } : {}),
      childIds: [],
      meshIds: [],
      transform: cameraParentNodeId === undefined ? previewCameraNodeMatrix(pose.position, target, up) : [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
    }
    break
  }
  const lights: JsonObject[] = []
  const lightMappings: JsonObject[] = []
  for (const [index, raw] of list(native['lights']).entries()) {
    signal?.throwIfAborted()
    if (lights.length === 4) break
    const record = object(raw),
      pose = frame(record, `light/${index}`)
    if (pose === undefined) continue
    const type =
      record['type'] === 0
        ? 'directional'
        : record['type'] === 1
          ? 'point'
          : record['type'] === 2
            ? 'spot'
            : undefined
    if (type === undefined) {
      diagnostics.push(`light/${index}: unsupported native light shape`)
      continue
    }
    const intensity = nonnegative(record['intensity']) ?? 1
    const color = vector(record['color']).map(value => (nonnegative(value) ?? 0) * intensity)
    if (!color.every(Number.isFinite))
      throw new RangeError('M3 preview intensity exceeds finite color')
    const attenuationStart = nonnegative(record['attenuationNear']),
      end = positive(record['attenuationFar'], 0),
      decay = nonnegative(record['decay']),
      inner = nonnegative(record['hotspot']),
      outer = positive(record['falloff'], 0)
    const commonIndex = lights.length
    const sequenceAnimation = mappedSequenceAnimation(record['sequenceAnimation'], {
      color: { target: 'color' },
      intensity: { target: 'intensity' },
      attenuationNear: { target: 'attenuationStart' },
      decay: { target: 'decayExponent' },
      hotspot: { target: 'innerConeAngle' },
      falloff: { target: 'outerConeAngle' },
    })
    lights.push({
      type,
      direction: type === 'directional' ? pose.forward.map(value => -value) : [...pose.forward],
      color,
      ...(type === 'directional' ? {} : { position: [...pose.position] }),
      ...(end > 0 ? { range: end, attenuationEnd: end } : {}),
      ...(attenuationStart === undefined ? {} : { attenuationStart }),
      ...(decay === undefined ? {} : { decayExponent: decay }),
      ...(type === 'spot' && inner !== undefined ? { innerConeAngle: inner } : {}),
      ...(type === 'spot' && outer > 0 ? { outerConeAngle: outer } : {}),
      ...(sequenceAnimation === undefined
        ? {}
        : {
            animationDefaults: {
              color: [...vector(record['color'])],
              intensity,
              ...(attenuationStart === undefined ? {} : { attenuationStart }),
              ...(decay === undefined ? {} : { decayExponent: decay }),
              ...(type === 'spot' && inner !== undefined ? { innerConeAngle: inner } : {}),
              ...(type === 'spot' && outer > 0 ? { outerConeAngle: outer } : {}),
            },
            sequenceAnimation,
          }),
    })
    lightMappings.push({
      nativeIndex: index,
      light: commonIndex,
      boneIndex: record['boneIndex'] ?? -1,
      intensity,
      ...(intensity === 0 ? { zeroIntensityColor: [...vector(record['color'])] } : {}),
      flags: record['flags'] ?? 0,
      specularColor: record['specularColor'] ?? [1, 1, 1],
      specularIntensity: record['specularIntensity'] ?? 1,
      ...(type === 'spot'
        ? {}
        : {
            hotspot: record['hotspot'] ?? 0,
            falloff: record['falloff'] ?? 0,
          }),
    })
  }
  return {
    ...(node === undefined ? {} : { node }),
    ...(cameraParentNodeId === undefined ? {} : { cameraParentNodeId }),
    ...(camera === undefined ? {} : { camera }),
    ...(lights.length === 0 ? {} : { lights: { ambient: [0.02, 0.02, 0.02], lights } }),
    diagnostics,
    mapping: {
      ...(cameraMapping === undefined ? {} : { camera: cameraMapping }),
      ...(lightMappings.length === 0 ? {} : { lights: lightMappings }),
    },
  }
}
