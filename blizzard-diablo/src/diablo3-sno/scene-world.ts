/**
 * A Diablo III scene as a world for the common world viewer (`common.view/world-scene-source@1`,
 * Core's decision 2026-09-29: the SNO codec publishes it itself).
 *
 * - Navigation: the navigation mesh, one sample per square at its centre with its height and flags,
 *   `squareSize` world units apart; square (column, row) is x = (column + ½)·size,
 *   y = (row + ½)·size in the scene's frame. A scene has no terrain surface: its ground is the
 *   scene's own mesh, so the terrain facet is unavailable (drawn under the mesh, the navigation
 *   heights fought it square by square).
 * - Objects: the scene's own mesh at the origin, and every marker of its marker sets with the
 *   marker's full quaternion. A marker that places an actor draws the actor's appearance; others
 *   (sounds, lights, encounters) are points.
 * - Resources: one per appearance, read by SNO id (`Appearance/<id>.app`) beside the scene; a
 *   model is converted by the host's model port and the shared world helper (`worldSceneModel`),
 *   as a map's are.
 *
 * The scene's frame is z-up; everything is published in UVW's y-up frame by the (x, y, z) →
 * (x, z, −y) turn the appearance export applies to its models. An appearance is in its own frame —
 * the game's turned a quarter about z and scaled 17 (`DIABLO3_APPEARANCE_*`) — so a model is placed
 * with the inverse quarter turn before its marker's quaternion and at 1/17 scale; the scene's own
 * mesh then lies on its navigation mesh. Units stay Diablo III world units (no metre length is
 * declared by the game).
 */
import { boundsOf } from '@modkit/codec-kit/model/bounds'
import { worldSceneModel, worldSceneModelLimits, type WorldModelTexture } from '@modkit/host/maps'
import type { LogicalResourceRequirement, ModelResourcePort } from '@modkit/sdk'
import {
  WORLD_SCENE_SOURCE_CONTRACT,
  type MapPosition,
  type WorldSceneFacetBounds,
  type WorldSceneFacetState,
  type WorldSceneInfo,
  type WorldSceneItem,
  type WorldSceneLayerKind,
  type WorldSceneModelRequest,
  type WorldSceneModelResult,
  type WorldScenePage,
  type WorldScenePageRequest,
  type WorldSceneSource,
} from '@modkit/sdk/maps'
import type { SnoDecoder, SnoValue } from './decode.js'
import type { SnoTypeRegistry } from './registry.js'
import { DIABLO3_APPEARANCE_SCALE, DIABLO3_APPEARANCE_TO_GAME } from '../diablo3-app/appearance.js'
import { navigationMesh, type NavigationMesh } from './scene-layers.js'
import { markerSetMarkers, sceneLinks } from './scene-markers.js'

const SPACE = 'diablo3-scene'
const SCOPES = Object.freeze(['current-mount', 'enclosing-container', 'workspace-dependency-layer'] as const)

/** z-up to y-up; a rotation's vector part turns the same way (conjugating by the turn). */
const turned = ([x = 0, y = 0, z = 0]: readonly number[]): MapPosition => Object.freeze({ x, y: z, z: -y })
const turnedRotation = ([x, y, z, w]: readonly [number, number, number, number]) => Object.freeze([x, z, -y, w] as const)
/** a ⊗ b: rotating by b, then by a. */
const product = (
  [ax, ay, az, aw]: readonly [number, number, number, number],
  [bx, by, bz, bw]: readonly [number, number, number, number],
): readonly [number, number, number, number] => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
]
const APPEARANCE_SCALE = Object.freeze({ x: 1 / DIABLO3_APPEARANCE_SCALE, y: 1 / DIABLO3_APPEARANCE_SCALE, z: 1 / DIABLO3_APPEARANCE_SCALE })

export interface ScenePlacement {
  readonly name: string
  readonly typeId: string
  readonly position: readonly [number, number, number]
  readonly rotation: readonly [number, number, number, number]
  readonly appearance?: number
}

export interface SceneWorld {
  readonly mesh?: NavigationMesh
  readonly placements: readonly ScenePlacement[]
  /** Linked files that did not read or decode, and links past the read budget. */
  readonly unread: number
}

export interface SceneWorldInput {
  readonly scene: SnoValue
  readonly decoder: SnoDecoder
  readonly registry: SnoTypeRegistry
  /** Logical path prefix of the storage the scene sits in (`Scene/…` sits at ''). */
  readonly root: string
  /** Reads logical paths; a path that does not read is absent from the answer. */
  read(paths: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>>
  /** Linked files read at most (marker sets and actors). */
  readonly maxLinks: number
}

/** What the scene places, read through its marker sets and their actors. */
export async function loadSceneWorld(input: SceneWorldInput): Promise<SceneWorld> {
  const { decoder, registry } = input
  const decode = (bytes: Uint8Array | undefined, group: string): SnoValue | undefined => {
    const root = decoder.rootOf(group)
    if (bytes === undefined || root === undefined) return undefined
    try {
      return decoder.decode(bytes, root, { maxMembers: 1_000_000, maxDepth: 16 }).value
    } catch {
      return undefined
    }
  }
  const links = sceneLinks(input.scene, registry.groups)
  let unread = Math.max(0, links.markerSets.length - input.maxLinks)
  const setPaths = links.markerSets.slice(0, input.maxLinks).map(id => `${input.root}MarkerSet/${id}.mrk`)
  const sets = await input.read(setPaths)
  const markers = setPaths.flatMap(path => {
    const set = decode(sets.get(path), 'MarkerSet')
    if (set === undefined) unread += 1
    return set === undefined ? [] : markerSetMarkers(set)
  })
  // an actor draws its appearance: the actor's own DT_SNO of the appearance group
  const actors = [...new Set(markers.flatMap(marker => (marker.sno.group !== null && registry.groups[marker.sno.group] === '.acr' ? [marker.sno.id] : [])))]
  const budget = Math.max(0, input.maxLinks - setPaths.length)
  unread += Math.max(0, actors.length - budget)
  const actorPath = (id: number) => `${input.root}Actor/${id}.acr`
  const actorBytes = await input.read(actors.slice(0, budget).map(actorPath))
  const appearanceOf = new Map<number, number>()
  for (const id of actors.slice(0, budget)) {
    const actor = decode(actorBytes.get(actorPath(id)), 'Actor')
    const appearance = actor?.kind === 'structure' ? actor.members.find(member => member.value.kind === 'sno' && member.value.group !== null && registry.groups[member.value.group] === '.app' && member.value.id > 0)?.value : undefined
    if (appearance?.kind === 'sno') appearanceOf.set(id, appearance.id)
    else unread += 1
  }
  const placements: ScenePlacement[] = []
  if (links.appearance !== undefined)
    placements.push({ name: 'Scene mesh', typeId: `Appearance ${links.appearance}`, position: [0, 0, 0], rotation: [0, 0, 0, 1], appearance: links.appearance })
  for (const marker of markers) {
    const extension = marker.sno.group === null ? undefined : registry.groups[marker.sno.group]
    const appearance = extension === '.acr' ? appearanceOf.get(marker.sno.id) : undefined
    placements.push({
      name: marker.name,
      typeId: `SNO ${marker.sno.id}${extension === undefined ? '' : ` (${extension})`}`,
      position: marker.position,
      rotation: marker.rotation,
      ...(appearance === undefined ? {} : { appearance }),
    })
  }
  const mesh = navigationMesh(input.scene)
  return { ...(mesh === undefined ? {} : { mesh }), placements, unread }
}

function pageOf(snapshotId: string, facet: string, items: readonly WorldSceneItem[], request: WorldScenePageRequest): WorldScenePage {
  const offset = request.cursor === undefined ? 0 : Number(request.cursor)
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('invalid scene world cursor')
  const page = items.slice(offset, offset + request.limit)
  return Object.freeze({
    snapshotId,
    facet,
    state: 'available' as const,
    items: Object.freeze(page),
    ...(offset + page.length < items.length ? { nextCursor: String(offset + page.length) } : {}),
  })
}

interface Built {
  readonly info: WorldSceneInfo
  readonly items: ReadonlyMap<string, readonly WorldSceneItem[]>
}

function build(world: SceneWorld, snapshotId: string, mapId: string, root: string): Built {
  const navigation: WorldSceneItem[] = []
  const mesh = world.mesh
  if (mesh !== undefined)
    for (let row = 0; row < mesh.rows; row += 1)
      for (let column = 0; column < mesh.width; column += 1) {
        const height = mesh.squares[row * mesh.width + column]!.height
        const position = turned([(column + 0.5) * mesh.squareSize, (row + 0.5) * mesh.squareSize, height])
        const flags = mesh.squares[row * mesh.width + column]!.flags
        navigation.push(Object.freeze({ facet: 'navigation' as const, id: `navigation:${column}:${row}`, layerId: 'navigation', coordinateSpaceId: SPACE, x: column, y: row, flags, uvwPosition: position, lod: 'exact' as const }))
      }
  const resourceIdOf = (appearance: number) => `appearance:${appearance}`
  const objects: WorldSceneItem[] = world.placements.map((placement, index) => {
    const position = turned(placement.position)
    const resourceId = placement.appearance === undefined ? undefined : resourceIdOf(placement.appearance)
    return Object.freeze({
      facet: 'objects' as const,
      id: `object:${index}`,
      layerId: 'objects',
      coordinateSpaceId: SPACE,
      kind: resourceId === undefined ? ('point' as const) : ('doodad' as const),
      objectId: index,
      position,
      sourcePositionDimensions: 3 as const,
      heightReference: 'absolute' as const,
      uvwPosition: position,
      // a model is an appearance, in its own frame: back to the game's, then the marker's turn
      uvwRotation: turnedRotation(resourceId === undefined ? placement.rotation : product(placement.rotation, DIABLO3_APPEARANCE_TO_GAME)),
      ...(resourceId === undefined ? {} : { uvwScale: APPEARANCE_SCALE }),
      typeId: placement.typeId,
      name: placement.name,
      ...(resourceId === undefined ? {} : { resourceId, resourceIds: Object.freeze([resourceId]) }),
    })
  })
  const users = new Map<number, string[]>()
  world.placements.forEach((placement, index) => {
    if (placement.appearance !== undefined) users.set(placement.appearance, [...(users.get(placement.appearance) ?? []), `object:${index}`])
  })
  const resources: WorldSceneItem[] = [...users].map(([appearance, objectIds]) => {
    const requirement: LogicalResourceRequirement = Object.freeze({ id: resourceIdOf(appearance), logicalId: `${root}Appearance/${appearance}.app`, role: 'sidecar' as const, scopes: SCOPES })
    return Object.freeze({ facet: 'resources' as const, id: requirement.id, layerId: 'resources', resolved: true, kind: 'uvm' as const, modelResource: requirement, objectIds: Object.freeze(objectIds) })
  })
  const partial = world.unread > 0 ? `${world.unread} linked marker sets or actors did not read or were past the read budget` : undefined
  const layers: readonly [WorldSceneLayerKind, readonly WorldSceneItem[], WorldSceneFacetState['state'], string | undefined][] = [
    ['terrain', [], 'unavailable', "a scene's ground is its own mesh (an object); it has no terrain surface"],
    ['navigation', navigation, mesh === undefined ? 'unavailable' : 'available', mesh === undefined ? 'the scene holds no complete navigation mesh' : undefined],
    ['objects', objects, partial === undefined ? 'available' : 'partial', partial],
    ['resources', resources, partial === undefined ? 'available' : 'partial', partial],
  ]
  const facets = layers.map(([kind, items, state, reason]) =>
    Object.freeze({ facet: kind, layerId: kind, state, itemCount: items.length, lods: Object.freeze(['exact']), ...(reason === undefined ? {} : { reason }) }),
  )
  const facetBounds = (facet: WorldSceneLayerKind, points: readonly MapPosition[]): WorldSceneFacetBounds => {
    if (points.length === 0) {
      const unknown = Object.freeze({ state: 'unknown' as const, reason: 'no items' })
      return Object.freeze({ facet, coordinateSpaceId: SPACE, x: unknown, y: unknown, z: unknown })
    }
    const { min, max } = boundsOf(points.flatMap(point => [point.x, point.y, point.z]))
    const axis = (index: 0 | 1 | 2) => Object.freeze({ state: 'known' as const, minimum: min[index], maximum: max[index] })
    return Object.freeze({ facet, coordinateSpaceId: SPACE, x: axis(0), y: axis(1), z: axis(2) })
  }
  const positions = (items: readonly WorldSceneItem[]) => items.flatMap(item => ('uvwPosition' in item && item.uvwPosition !== undefined ? [item.uvwPosition] : []))
  const info: WorldSceneInfo = Object.freeze({
    contract: WORLD_SCENE_SOURCE_CONTRACT,
    major: 1 as const,
    maturity: 'publisher-candidate' as const,
    snapshotId,
    mapId,
    coordinateSpaces: Object.freeze([
      Object.freeze({ id: SPACE, horizontalAxes: Object.freeze(['x', 'z'] as const), verticalAxis: 'y', handedness: 'right', linearUnit: 'diablo3-world-unit', rotationUnit: 'radian', origin: 'scene-origin' }),
    ]),
    crossSpaceTransforms: Object.freeze([]),
    bounds: Object.freeze([facetBounds('navigation', positions(navigation)), facetBounds('objects', positions(objects))]),
    facets: Object.freeze(facets),
    provenance: Object.freeze([]),
    unknownFacets: Object.freeze(['terrain-materials', 'water', 'cliffs', 'regions', 'gateways', 'lighting', 'object-scale']),
    lossPolicy: 'explicit-partial' as const,
    complete: false,
  })
  const layerItems: WorldSceneItem[] = layers.map(([kind, items, state]) =>
    Object.freeze({ facet: 'layers' as const, id: `layer:${kind}`, layerId: kind, kind, state, itemCount: items.length, lods: Object.freeze(['exact']) }),
  )
  return { info, items: new Map([['layers', layerItems], ['terrain', []], ['navigation', navigation], ['objects', objects], ['resources', resources]]) }
}

/** The world of one scene, read on first use. */
export function createSceneWorldSource(options: {
  readonly snapshotId: string
  readonly mapId: string
  readonly root: string
  /** The host's model port (`ContributionContext.modelResources`); without it objects stay placeholders. */
  readonly models?: ModelResourcePort
  load(): Promise<SceneWorld>
}): WorldSceneSource {
  let pending: Promise<Built> | undefined
  // one texture cache for the scene: its actors share most of their textures
  const textureCache = new Map<string, Promise<WorldModelTexture>>()
  const unresolved = (message: string): WorldSceneModelResult =>
    Object.freeze({ state: 'unresolved' as const, diagnostics: Object.freeze([Object.freeze({ code: 'blizzard.diablo3-sno/world-model-unavailable', severity: 'warning' as const, message })]) })
  const built = () =>
    (pending ??= options.load().then(
      world => build(world, options.snapshotId, options.mapId, options.root),
      error => {
        pending = undefined
        throw error
      },
    ))
  return Object.freeze({
    contract: WORLD_SCENE_SOURCE_CONTRACT,
    major: 1 as const,
    snapshotId: options.snapshotId,
    async info(signal?: AbortSignal) {
      signal?.throwIfAborted()
      return (await built()).info
    },
    async page(request: WorldScenePageRequest, signal?: AbortSignal) {
      signal?.throwIfAborted()
      if (!Number.isSafeInteger(request.limit) || request.limit <= 0) throw new RangeError('scene world page limit must be a positive safe integer')
      const items = (await built()).items.get(request.facet)
      if (items === undefined)
        return Object.freeze({ snapshotId: options.snapshotId, facet: request.facet, state: 'unsupported' as const, items: Object.freeze([]), reason: 'a Diablo III scene publishes navigation, objects and resources' })
      const bounds = request.bounds
      const inside =
        bounds === undefined || request.facet === 'layers' || request.facet === 'resources'
          ? items
          : items.filter(item => {
              const position = 'uvwPosition' in item ? item.uvwPosition : undefined
              return position === undefined || (position.x >= bounds.minimumX && position.x <= bounds.maximumX && position.z >= bounds.minimumY && position.z <= bounds.maximumY)
            })
      return pageOf(options.snapshotId, request.facet, inside, request)
    },
    async model(resourceId: string, request: WorldSceneModelRequest, signal?: AbortSignal) {
      signal?.throwIfAborted()
      worldSceneModelLimits(request, Number.MAX_SAFE_INTEGER)
      const item = (await built()).items.get('resources')?.find(candidate => candidate.id === resourceId)
      const requirement = item?.facet === 'resources' ? item.modelResource : undefined
      if (requirement === undefined) return unresolved(`the scene has no model resource ${resourceId}`)
      if (options.models === undefined) return unresolved('this host converts no models for a codec (no modelResources port)')
      const lease = await options.models.acquire(
        { requirement, maxBytes: request.maxBytes, ...(request.metersPerSourceUnit === undefined ? {} : { metersPerSourceUnit: request.metersPerSourceUnit }) },
        signal,
      )
      try {
        return await worldSceneModel(lease.value, request, { requirement, textureCache }, signal)
      } finally {
        await lease.release()
      }
    },
  })
}
