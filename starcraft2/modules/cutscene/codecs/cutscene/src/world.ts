/** SC2 cutscene presentation adapter. Native time/catalog/coordinate semantics stay here;
 * Host owns dependency reads and M3→UVM, worldSceneModel owns model/texture publication,
 * and the common scene renderer owns pose sampling and the image. No filesystem or clock.
 * Presentation slice: CModel links/RequiredAnims, explicit M3A, transforms, sparse full-weight
 * priority layers and TargetCamera/sampled model camera. FacialController/fxaOverride are readonly
 * codec references. Blend ramps, weighted layers, lighting, FaceFX playback and effects remain partial.
 */
import type { InspectionContext } from '@modkit/codec-kit'
import { quaternionFromRotationMatrix } from '@modkit/codec-kit/model-math/transform'
import { modelAnimationNameMatches } from '@modkit/codec-kit/model/animation'
import { worldSceneModel, worldSceneModelLimits, type WorldModelTexture } from '@modkit/host/maps'
import type { Diagnostic } from '@modkit/core'
import type { DataResolvedEntity } from '@modkit/sdk'
import { WORLD_SCENE_SOURCE_CONTRACT, type WorldSceneSource, type WorldSceneFrame,
  type WorldSceneCamera, type WorldSceneObjectItem, type WorldSceneResourceItem,
  type WorldSceneItem, type WorldSceneInfo } from '@modkit/sdk/maps'
import { catalogAssetLogicalId, catalogModelVariationLogicalId, modelVariationFor } from '../../../../../shared/catalog-model.js'
import { assertCutsceneTime, type CompiledCutscene, type CutsceneNodeState } from './evaluate.js'
import { cutsceneFacialAt } from './facial.js'
import { cutsceneFlagValue } from './model.js'

type Properties = Readonly<Record<string, string | number>>
type Vec = readonly [number, number, number]
const SPACE = 'sc2-cutscene-uvw'
const scopes = ['current-mount', 'enclosing-container', 'workspace-dependency-layer'] as const
const note = (code: string, message: string): Diagnostic => ({ code: `blizzard.sc2-cutscene/${code}`, severity: 'warning', message })
const numeric = (value: string | number | undefined, fallback: number) => value === undefined ? fallback : Number(value)
/** Evaluated axis channels override the authored vector without changing its SC2 units. */
function vector(properties: Properties, name: string, fallback: Vec): Vec {
  const stored = typeof properties[name] === 'string' ? String(properties[name]).split(',').map(Number) : fallback
  const result = ['X', 'Y', 'Z'].map((axis, index) => numeric(properties[`${name}${axis}`], stored[index] ?? fallback[index]!))
  if (!result.every(Number.isFinite)) throw new TypeError(`non-finite cutscene ${name}`)
  return result as unknown as Vec
}
const turned = ([x, y, z]: Vec): Vec => [x, z, -y]
const position = ([x, y, z]: Vec) => ({ x, y, z })

/** Native RGBA team colour has an independent source selector; retain its authored RGB. */
function teamColor(properties: Properties): Vec | undefined {
  const name = 'teamColorDiffuse'
  if (properties[name] === undefined && !['R', 'G', 'B'].some(axis => properties[name + axis] !== undefined)) return undefined
  const stored = String(properties[name] ?? '1,1,1').split(',').map(Number)
  const rgb = ['R', 'G', 'B'].map((axis, index) => numeric(properties[name + axis], stored[index] ?? 1))
  return rgb.every(value => Number.isFinite(value) && value >= 0 && value <= 1) ? rgb as unknown as Vec : undefined
}

/** SC2Cutscene composes Rx·Ry·Rz; retain the unqualified ActorState convention.
 * Native actor bearing/scene rotation still require camera/resource frame qualification. */
function rotation(angles: Vec, legacy: boolean): readonly [number, number, number, number] {
  const [x, y, z] = angles.map(value => value * Math.PI / 180)
  const a = Math.cos(x!), b = Math.sin(x!), c = Math.cos(y!), d = Math.sin(y!), e = Math.cos(z!), f = Math.sin(z!)
  const [qx, qy, qz, qw] = quaternionFromRotationMatrix(legacy ? [
    c * e, c * f, -d, b * d * e - a * f, b * d * f + a * e, b * c,
    a * d * e + b * f, a * d * f - b * e, a * c,
  ] : [
    c * e, a * f + b * d * e, b * f - a * d * e,
    -c * f, a * e - b * d * f, b * e + a * d * f,
    d, -b * c, a * c,
  ])
  return [qx, qz, -qy, qw]
}

/** Project an authored TargetCamera lens; missing/invalid lens values never become orbit defaults. */
function targetCamera(frame: ReturnType<CompiledCutscene['sceneAt']>): WorldSceneCamera | undefined {
  if (frame.camera?.state !== 'native-camera' || frame.camera.kind !== 'TargetCamera' || frame.camera.properties === null) return undefined
  const p = frame.camera.properties
  // Blizzard's Camera Node: verticalFOV opts into a vertical lens; the default is horizontal.
  const eye = vector(p, 'eyePosition', [NaN, NaN, NaN])
  const target = vector(p, 'targetPosition', p['position'] === undefined ? [NaN, NaN, NaN] : vector(p, 'position', [NaN, NaN, NaN]))
  const fov = numeric(p['fov'], NaN) * Math.PI / 180
  const near = numeric(p['nearClip'], NaN), far = numeric(p['farClip'], NaN)
  if (!(fov > 0 && fov < Math.PI && near > 0 && Number.isFinite(far) && far > near)) return undefined
  return { eye: turned(eye), target: turned(target), up: [0, 1, 0],
    ...(numeric(p['verticalFOV'], 0) === 1 ? { verticalFieldOfView: fov } : { horizontalFieldOfView: fov }),
    near, far, roll: numeric(p['roll'], 0) * Math.PI / 180 }
}

/** Publish revision-scoped lazy resources and independent pure frame samples through the shared world. */
export function createCutsceneWorldSource(context: InspectionContext, compiled: () => CompiledCutscene): WorldSceneSource & {
  facialResources(signal?: AbortSignal): Promise<readonly WorldSceneResourceItem[]>
  facialAt(timeMs: number, signal?: AbortSignal): ReturnType<typeof cutsceneFacialAt>
} {
  const snapshotId = String(context.input.revisions.revision)
  const actors = () => compiled().sceneAt(0).nodes.filter(node => node.kind === 'Actor')
  const resourceId = (actor: CutsceneNodeState) => `model:${actor.sourceStart}`
  const textureCache = new Map<string, Promise<WorldModelTexture>>()
  let pending: Promise<{ resources: WorldSceneResourceItem[]; facialResources: WorldSceneResourceItem[]; diagnostics: Diagnostic[]; entities: Map<string, DataResolvedEntity> }> | undefined
  const resources = (signal?: AbortSignal) => pending ??= (async () => {
    const nodes = actors()
    const refs = [...new Set(nodes.filter(node => compiled().dialect !== 'actor-state' || node.attributes['model'] === undefined).map(node => node.attributes['modelLink']).filter((value): value is string => !!value))].map(entityId => ({ namespace: 'Model', entityId }))
    const entities = new Map<string, DataResolvedEntity>()
    // Keep worker frames and catalog questions bounded independently of the document size.
    for (let offset = 0; offset < refs.length; offset += 128) {
      signal?.throwIfAborted()
      for (const entity of await context.catalog?.entities(refs.slice(offset, offset + 128), signal) ?? []) entities.set(entity.entityId, entity)
    }
    const diagnostics: Diagnostic[] = []
    const result = nodes.map(node => {
      const model = entities.get(node.attributes['modelLink'] ?? '')
      const legacy = compiled().dialect === 'actor-state' ? node.attributes['model'] : undefined
      if (legacy !== undefined && (/^[A-Za-z]:|^[\\/]|(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(legacy))) throw new TypeError('SC2Scene model path must be logical and relative')
      const named = catalogAssetLogicalId(model, 'Model', legacy ?? model?.fields['Model'])
      const logicalId = named === undefined ? undefined : catalogModelVariationLogicalId(named,
        modelVariationFor(model, { variation: numeric(node.attributes['variation'], 0) }))
      if (logicalId === undefined) diagnostics.push(note('model-unresolved', `Actor ${node.guid ?? node.sourceStart}: CModel ${node.attributes['modelLink'] ?? '(missing)'} has no resolved Model path.`))
      return { facet: 'resources' as const, id: resourceId(node), layerId: 'resources',
        namespace: 'Model', ...(node.attributes['modelLink'] === undefined ? {} : { entityId: node.attributes['modelLink'] }), resolved: logicalId !== undefined,
        kind: 'uvm' as const, objectIds: [`object:${node.sourceStart}`],
        ...(logicalId === undefined ? {} : { modelResource: { id: resourceId(node), logicalId, role: 'sidecar' as const, scopes } }) }
    })
    // FacialController stays a logical media dependency owned by the FaceFX codecs, never an M3A.
    const facial: WorldSceneResourceItem[] = nodes.flatMap(node => {
      const field = node.attributes['fxaOverride'] ?? entities.get(node.attributes['modelLink'] ?? '')?.fields['FacialController']
      if (typeof field !== 'string' || field.length === 0) return []
      return [{ facet: 'resources', id: `facial:${node.sourceStart}`, layerId: 'resources',
        namespace: 'FaceFX', ...(node.attributes['modelLink'] === undefined ? {} : { entityId: node.attributes['modelLink'] }), kind: 'media',
        uri: field.replace(/\\/gu, '/'), resolved: false, objectIds: [`object:${node.sourceStart}`] }]
    })
    return { resources: result, facialResources: facial, diagnostics, entities }
  })().catch(error => { pending = undefined; throw error })

  const sample = async (timeMs: number, signal?: AbortSignal): Promise<WorldSceneFrame> => {
    assertCutsceneTime(timeMs)
    signal?.throwIfAborted()
    const frame = compiled().sceneAt(timeMs)
    const diagnostics = [...frame.diagnostics.filter(item => item.code !== 'native-projection' &&
      !(item.code === 'native-semantics-required' && frame.nodes.some(node => node.sourceStart === item.sourceStart && node.kind === 'M3A'))).map(item => note(item.code, `${item.sourceStart}: ${item.message}`)),
      note('presentation-partial', 'Native actor bearing/scene rotation and roll still need camera/resource frame qualification and Editor comparison. Native lighting, FaceFX, attachments, blend layers and scene effects are not rendered. Model cameras currently support the first projected camera; M3A playback binds bone TRS only.')]
    const byStart = new Map(frame.nodes.map(node => [node.sourceStart, node]))
    const animationTimes: { objectId: number; seconds: number }[] = []
    const objects: WorldSceneObjectItem[] = []
    const shotStarts = new Set(frame.shotNodes.map(node => node.sourceStart))
    const lookAtsByActor = new Map<number, typeof frame.lookAts[number][]>()
    for (const request of frame.lookAts) if (request.ownerStart !== null) {
      const requests = lookAtsByActor.get(request.ownerStart) ?? []
      requests.push(request)
      lookAtsByActor.set(request.ownerStart, requests)
    }
    for (const node of frame.nodes.filter(item => item.kind === 'Actor' && item.active &&
      (shotStarts.has(item.sourceStart) || frame.camera?.objectStart === item.sourceStart))) {
      try {
        const p = node.properties
        for (const request of lookAtsByActor.get(node.sourceStart) ?? [])
          diagnostics.push(note('look-at-pose-required', `Actor ${node.guid}: ${request.type ?? '(default type)'} targets ${request.targetGuid ?? '(missing)'} / ${request.attachmentId ?? '(default attachment)'} (${request.state}); model gaze blending is required, actor placement is preserved.`))
        const hidden = cutsceneFlagValue(p['visible']) === 'off' || ['visible', 'opacity'].some(name => p[name] !== undefined &&
          String(p[name]).trim() !== '' && numeric(p[name], NaN) === 0)
        if (hidden) {
          // The common model-camera sampler still needs this actor's transform and pose.
          if (frame.camera?.state !== 'model-camera-required' || frame.camera.objectStart !== node.sourceStart) continue
          diagnostics.push(note('hidden-camera-carrier', `Actor ${node.guid}: hidden model-camera owner retained for pose resolution; hiding its geometry remains partial.`))
        }
        const clips = frame.activeClips.filter(clip => clip.kind === 'Anim' &&
          (clip.ownerStart === node.sourceStart || (clip.ownerStart !== null && byStart.get(clip.ownerStart)?.parentStart === node.sourceStart)))
        const layers = clips.flatMap(clip => {
          if (numeric(clip.attributes['weight'], 1) !== 1) {
            diagnostics.push(note('animation-weight-unsupported', `Actor ${node.guid}: weighted clip ${clip.attributes['anim']} omitted from hard-override preview.`))
            return []
          }
          const timeSeconds = (clip.elapsed * numeric(clip.attributes['timeScale'], 1) + numeric(clip.attributes['startOffset'], 0)) / 1000
          const priority = numeric(clip.attributes['priority'], 0)
          if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || !Number.isFinite(priority)) throw new TypeError('invalid animation layer clock/priority')
          return [{ name: clip.attributes['anim'] ?? 'Stand', groups: [], loop: clip.attributes['looping'] === '1', timeSeconds, priority }]
        })
        if (layers.length > 32) throw new RangeError('actor exceeds 32 animation layers')
        if (clips.some(clip => numeric(clip.attributes['blendTime'], 150) > 0 || numeric(clip.attributes['blendOutTime'], 0) > 0))
          diagnostics.push(note('animation-blend-required', `Actor ${node.guid}: sparse priority overrides shown; blend ramps and native tie rules still need Editor verification.`))
        const clip = layers[0]
        if (clip !== undefined) animationTimes.push({ objectId: node.sourceStart, seconds: 0 })
        // Native Object schema defaults RotationZ to -90; Actor bearing adds 90 after axis curves.
        // Only catalog-backed native actors use this path; external scene rotation is separate.
        const legacy = compiled().dialect === 'actor-state'
        const nativeActor = !legacy && !!node.attributes['modelLink']?.trim()
        const angles = vector(p, 'rotation', [0, 0, nativeActor ? -90 : legacy ? numeric(p['facing'], 0) : 0])
        const visualAngles: Vec = nativeActor ? [angles[0], angles[1], angles[2] + 90] : angles
        const scale = vector(p, 'scale', [1, 1, 1])
        const color = teamColor(p)
        const tintNames = ['tintColorRed', 'tintColorGreen', 'tintColorBlue']
        const tinted = tintNames.some(name => p[name] !== undefined)
        const tint = tintNames.map(name => numeric(p[name], 1))
        const tintSupported = tint.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
        if (tinted && !tintSupported) diagnostics.push(note('actor-tint-unsupported', `Actor ${node.guid}: tint is outside the current world RGB 0..1 contract; authored values retained.`))
        const opacity = numeric(p['opacity'], 1)
        if (Number.isFinite(opacity) && opacity > 0 && opacity < 1)
          diagnostics.push(note('actor-opacity-required', `Actor ${node.guid}: authored opacity ${opacity} needs the common world opacity contract.`))
        objects.push({ facet: 'objects', id: `object:${node.sourceStart}`, objectId: node.sourceStart,
          sourceKey: node.guid ?? String(node.sourceStart), layerId: 'objects', coordinateSpaceId: SPACE,
          kind: 'doodad', ...(node.attributes['modelLink'] === undefined ? {} : { typeId: node.attributes['modelLink'] }),
          ...(node.attributes['name'] === undefined ? {} : { name: node.attributes['name'] }),
          resourceId: resourceId(node), position: position(vector(p, 'position', [0, 0, 0])),
          ...(color === undefined ? {} : { presentationTeamColor: color }),
          ...(tinted && tintSupported ? { presentationTint: tint as unknown as Vec } : {}),
          sourcePositionDimensions: 3, heightReference: 'absolute',
          uvwPosition: position(turned(vector(p, 'position', [0, 0, 0]))),
          uvwRotation: rotation(visualAngles, legacy), uvwScale: { x: scale[0], y: scale[2], z: scale[1] },
          ...(clip === undefined ? {} : { presentationAnimation: { name: clip.name, groups: [],
            loop: clip.loop, speed: 1, layers } }),
        })
      } catch (error) { diagnostics.push(note('actor-transform-invalid', `Actor ${node.guid}: ${String(error)}`)) }
    }
    let camera: WorldSceneCamera | undefined
    try { camera = targetCamera(frame) } catch (error) { diagnostics.push(note('camera-invalid', String(error))) }
    const modelCamera = frame.camera?.state === 'model-camera-required' && frame.camera.objectStart !== null
      ? { objectId: frame.camera.objectStart!, cameraIndex: numeric(frame.camera.cameraIndex, 0) } : undefined
    if (camera === undefined && modelCamera === undefined) diagnostics.push(note('camera-unavailable', 'No supported TargetCamera at this time. Model cameras require the sampled model pose.'))
    signal?.throwIfAborted()
    return { snapshotId, timeMs, objects, animationTimes, ...(camera === undefined ? {} : { camera }), ...(modelCamera === undefined ? {} : { modelCamera }), diagnostics, complete: false }
  }
  const source: WorldSceneSource = {
    contract: WORLD_SCENE_SOURCE_CONTRACT, major: 1, snapshotId, frame: sample,
    async info(signal) {
      signal?.throwIfAborted()
      const count = actors().length
      const info: WorldSceneInfo = { contract: WORLD_SCENE_SOURCE_CONTRACT, major: 1, maturity: 'publisher-candidate', snapshotId,
        mapId: String(context.primary.source.id), coordinateSpaces: [{ id: SPACE, horizontalAxes: ['x', 'z'], verticalAxis: 'y',
          handedness: 'right', linearUnit: 'sc2-world-unit', rotationUnit: 'radian', origin: 'scene-origin' }],
        crossSpaceTransforms: [], bounds: [], facets: (['objects', 'resources'] as const).map(facet => ({ facet, layerId: facet,
          state: 'partial' as const, itemCount: count, lods: ['exact'], reason: 'first cutscene presentation slice' })),
        provenance: [], unknownFacets: ['lighting', 'attachments', 'additional-model-cameras', 'effects', 'facefx', 'm3a-non-trs-channels'], lossPolicy: 'explicit-partial', complete: false }
      return info
    },
    async page(request, signal) {
      signal?.throwIfAborted()
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100_000) throw new RangeError('invalid cutscene page limit')
      const offset = request.cursor === undefined ? 0 : Number(request.cursor)
      if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('invalid cutscene page cursor')
      let items: readonly WorldSceneItem[]
      if (request.facet === 'layers') items = (await source.info(signal)).facets.map(facet => ({ facet: 'layers', id: `layer:${facet.facet}`,
        layerId: facet.facet, kind: facet.facet as 'objects' | 'resources', state: 'partial', itemCount: facet.itemCount, lods: ['exact'] }))
      else if (request.facet === 'resources') items = (await resources(signal)).resources
      else if (request.facet === 'objects') items = (await sample(0, signal)).objects
      else return { snapshotId, facet: request.facet, state: 'unsupported', items: [], reason: 'cutscene publishes objects and model resources' }
      const end = offset + request.limit
      return { snapshotId, facet: request.facet, state: 'available', items: items.slice(offset, end),
        ...(end < items.length ? { nextCursor: String(end) } : {}) }
    },
    async model(id, request, signal) {
      worldSceneModelLimits(request, Number.MAX_SAFE_INTEGER)
      const resolved = await resources(signal)
      const requirement = resolved.resources.find(item => item.id === id)?.modelResource
      if (requirement === undefined || context.modelResources === undefined) return { state: 'unresolved', diagnostics: [...resolved.diagnostics, note('model-unavailable', `No model resource/Host port for ${id}`)] }
      const actorStart = Number(id.slice('model:'.length))
      const actor = actors().find(node => node.sourceStart === actorStart)
      const model = resolved.entities.get(actor?.attributes['modelLink'] ?? '')
      const required = model?.fields['RequiredAnims']
      // Resolved indexed catalog arrays retain their explicit index and value wrapper.
      const catalogAnimations = (required === undefined ? [] : Array.isArray(required) ? required : [required])
        .map(entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry['value'] : entry)
      const authoredAnimations = compiled().sceneAt(0).nodes.filter(node => node.kind === 'M3A' && node.enabled && node.parentStart === actorStart)
        .map(node => node.attributes['filePath'])
      const animationPaths = [...catalogAnimations, ...authoredAnimations].map(path => {
        if (typeof path !== 'string' || path.length === 0 || /^[A-Za-z]:|^[\\/]|(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(path)) throw new TypeError('M3A reference must be a relative logical path')
        return catalogAssetLogicalId(model, 'RequiredAnims', path)!
      })
      const animationResources = [...new Map(animationPaths.map(path => [path.toLowerCase(), path])).values()]
        .map((path, index) => ({ id: id + '/animation/' + index, logicalId: path, role: 'sidecar' as const, scopes }))
      const nodes = new Map(compiled().sceneAt(0).nodes.map(node => [node.sourceStart, node]))
      const animationNames = [...new Set(compiled().animationClips.filter(clip => clip.ownerStart === actorStart ||
        (clip.ownerStart !== null && nodes.get(clip.ownerStart)?.parentStart === actorStart))
        .map(clip => clip.attributes['anim'] ?? 'Stand'))]
      const lease = await context.modelResources.acquire({ requirement, maxBytes: request.maxBytes,
        ...(animationResources.length === 0 ? {} : { animationResources }),
        ...(animationResources.length === 0 || animationNames.length === 0 ? {} : { animationNames }),
        ...(request.metersPerSourceUnit === undefined ? {} : { metersPerSourceUnit: request.metersPerSourceUnit }) }, signal)
      try {
        const result = await worldSceneModel(lease.value, request, { requirement, textureCache }, signal)
        if (result.state !== 'converted') return result
        const unavailable = animationNames.filter(name => !result.animations?.some(clip =>
          clip.channels.length > 0 && modelAnimationNameMatches(clip.name, name)))
        return unavailable.length === 0 ? result : { ...result, diagnostics: [...(result.diagnostics ?? []),
          ...unavailable.map(name => note('animation-unavailable', `Actor ${actor?.guid ?? actorStart}: requested animation ${name} has no populated projected clip.`))] }
      }
      finally { await lease.release() }
    },
  }
  return Object.freeze({ ...source,
    async facialResources(signal?: AbortSignal) { return (await resources(signal)).facialResources },
    async facialAt(timeMs: number, signal?: AbortSignal) {
      assertCutsceneTime(timeMs)
      return cutsceneFacialAt(context, compiled(), (await resources(signal)).entities, timeMs, signal)
    },
  })
}
