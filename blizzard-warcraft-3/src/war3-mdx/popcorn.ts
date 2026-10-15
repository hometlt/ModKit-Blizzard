/**
 * The PopcornFX emitters of a Warcraft III Reforged model (MDX `CORN` chunk), baked: each emitter's
 * `.pkb` runs through the PopcornFX VM (`../war3-pkb/runtime.ts`) over every clip, and what it draws
 * is recorded as sprites per clip, batch and frame — the `bakedParticles` of the model projection,
 * written as `UV_game_baked_particles` (SPEC_UVM §13.4). A viewer draws the frames; it never runs
 * the effect.
 *
 * Owner: GAME-WARCRAFT3. Inputs are the parsed MDX (`ParticleEmitterPopcorn`: `Path`,
 * `AnimVisibilityGuide`, `KPPV` visibility, `PivotPoint`) and the effects read beside the model
 * (`Foo.pkfx` → `Foo.pkb`). An emitter runs while its guide turns it on for the clip
 * (`war3PopcornGuideOn`: `Death=off, Always=on` style, matched on the clip name's start) and its
 * visibility track is above zero; when it stops, its particles live out their lives. A clip bakes
 * its first cycle from the effect's start, drawn once; a looping clip whose effect is still drawing
 * at the end bakes its second cycle instead, repeated, so a continuous effect loops without a pop.
 *
 * Units and frames: the VM runs in PopcornFX metres, Z up, in model space; the effect's frame is the
 * emitter's node at each step (its pivot when the node is not posed), and sprites are written in the
 * model's frame in Warcraft III units (`PKB_UNITS_PER_METRE`), named by the root
 * node. Each layer renderer of each emitter is one batch with its own material (texture under the
 * renderer's blend; `_HD.w3mod/` prefixes dropped, as the game's tree is merged HD first).
 *
 * The clip's animated emission rate, colour and alpha (`KPPE`, `KPPC`, `KPPA`) reach the effect as
 * the game's `__a_Game.EmissionRateMultiplier` and `__a_Game.ColorMultiplier`; static values are
 * not applied (1, or 0 and [0, 0, 0] meaning unset, in 1 248 of the game's 2 819 CORN).
 * Limits (ponytail): a global-sequence track is read as 1; ribbons are strips of their points (the game's bakes hold no light
 * renderers). A team-coloured layer is baked with white and multiplied by the player's colour in
 * its material: right for colours the effect scales by it, approximate for hue shifts of it. At most
 * `MAX_BAKED_SPRITES` sprites in all, `MAX_CLIP_SECONDS` of a clip; what is cut is reported.
 */
import type { AnimVector, Model, ParticleEmitterPopcorn } from '../lib/war3-model/model.js'
import { PKB_UNITS_PER_METRE, readPkEffect, type PkEffect, type PkRenderer } from '../war3-pkb/effect.js'
import { PkEffectInstance, createPkEnvironment } from '../war3-pkb/runtime.js'
import { collectPkSprites, type PkSpriteBatch } from '../war3-pkb/sprites.js'
import type { RenderModel } from '@modkit/codec-kit/legacy/models'
import { createModelSceneSampler } from '@modkit/scene/model'
import { war3AnimationClips, war3NodeId, war3SceneNodes, war3SkeletonBindings } from './scene.js'

/** Frames per second the bake records. */
export const WAR3_POPCORN_FRAME_RATE = 15
/** VM steps per recorded frame (1/30 s steps). */
const STEPS_PER_FRAME = 2
const MAX_CLIP_SECONDS = 10
/** Sprites the whole bake records at most (17 floats each: about 9 MB). */
const MAX_BAKED_SPRITES = 1 << 17
const SPRITE_FLOATS = 17

/** A CORN emitter as the bake needs it. */
export interface War3PopcornEmitter {
  readonly name: string
  /** The effect the game loads, `Abilities/…/Foo.pkfx`. */
  readonly path: string
  readonly guide: string
  /** The projection's id of the emitter's node (`war3NodeId`). */
  readonly nodeId: string
  readonly pivot: readonly [number, number, number]
  readonly visibility?: AnimVector
  /** The game's emission rate, colour and alpha multipliers (`KPPE`, `KPPC`, `KPPA`), when animated. */
  readonly emissionRate?: AnimVector
  readonly color?: AnimVector
  readonly alpha?: AnimVector
}

/** A clip of the model, as its projection names it. */
export interface War3PopcornClip {
  readonly clipId: string
  readonly name: string
  readonly startMs: number
  readonly endMs: number
  readonly looping: boolean
}

export interface War3PopcornBatch {
  readonly materialId: string
  readonly name: string
  readonly orientation: 'camera' | 'axis' | 'plane' | 'ribbon'
  readonly atlas: readonly [number, number]
  readonly texture: string
  readonly blendMode: number
  /**
   * The effect reads the player's colour for this layer (`__a_Game.TeamColor`): it was baked with
   * white, and its material multiplies the sprites by the viewer's team colour.
   */
  readonly teamColored: boolean
}

export interface War3PopcornBake {
  readonly frameRate: number
  readonly batches: readonly War3PopcornBatch[]
  readonly tracks: readonly {
    readonly clipId: string
    readonly batch: number
    readonly loop: boolean
    readonly frames: Uint32Array
    readonly sprites: Float32Array
  }[]
  readonly notes: readonly string[]
}

/** `{ [key]: track }` for an animated value, nothing for a static one. */
const animated = (key: string, value: unknown): Record<string, AnimVector> =>
  typeof value === 'object' && value !== null && 'Keys' in value ? { [key]: value as AnimVector } : {}

/** The model's CORN emitters, with the pivot of each one's node. */
export function war3PopcornEmitters(model: Model): War3PopcornEmitter[] {
  return (model.ParticleEmitterPopcorns ?? []).map((emitter: ParticleEmitterPopcorn) => {
    const pivot = emitter.PivotPoint ?? model.PivotPoints[emitter.ObjectId ?? -1]
    return {
      name: emitter.Name,
      path: emitter.Path ?? '',
      guide: emitter.AnimVisibilityGuide ?? '',
      nodeId: war3NodeId(emitter.ObjectId ?? -1),
      pivot: [pivot?.[0] ?? 0, pivot?.[1] ?? 0, pivot?.[2] ?? 0],
      ...(emitter.Visibility === undefined ? {} : { visibility: emitter.Visibility }),
      ...animated('emissionRate', emitter.EmissionRate),
      ...animated('color', emitter.Color),
      ...animated('alpha', emitter.Alpha),
    }
  })
}

/** The bake the game reads for a CORN path: `Foo.pkfx` → `Foo.pkb`, forward slashes. */
export function war3PopcornBakePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/\.pkfx$/iu, '.pkb')
}

/**
 * Whether an `AnimVisibilityGuide` turns its emitter on for a clip: the entry whose name starts
 * the clip's name (`Death` for `Death 1`, case aside), else `Always`, else on: an entry the game
 * does not know (Cyclone's `Alwyas=on`) turns nothing off, and the visibility track still hides.
 */
export function war3PopcornGuideOn(guide: string, clipName: string): boolean {
  const entries = guide
    .split(',')
    .map(entry => entry.split('=').map(part => part.trim().toLowerCase()))
    .filter((entry): entry is [string, string] => entry.length === 2 && entry[0] !== '')
  const name = clipName.trim().toLowerCase()
  const own = entries.filter(([key]) => key !== 'always' && name.startsWith(key))
  own.sort((a, b) => b[0].length - a[0].length)
  if (own[0] !== undefined) return own[0][1] === 'on'
  const always = entries.find(([key]) => key === 'always')
  if (always !== undefined) return always[1] === 'on'
  return true
}

/**
 * A track's lane `lane` at `ms` within the clip `[startMs, endMs]`: before the clip's first key its
 * value, after the last its value, between two keys a straight line (a `DontInterp` track, line
 * type 0, steps). 1 for no track, a static value (the game's static multipliers are 1, or 0 meaning
 * unset), a global-sequence track or one without keys in the clip.
 * ponytail: Hermite and Bezier keys are read as linear.
 */
export function war3PopcornTrackAt(
  track: AnimVector | number | ArrayLike<number> | undefined,
  startMs: number,
  endMs: number,
  ms: number,
  lane = 0,
): number {
  if (track === undefined || typeof track === 'number' || !('Keys' in track) || track.GlobalSeqId != null) return 1
  const keys = track.Keys.filter(key => key.Frame >= startMs && key.Frame <= endMs)
  if (keys.length === 0) return 1
  const valueOf = (index: number) => keys[index]!.Vector[lane] ?? 1
  if (ms <= keys[0]!.Frame) return valueOf(0)
  for (let index = 1; index < keys.length; index++) {
    const next = keys[index]!
    if (ms >= next.Frame) continue
    const previous = keys[index - 1]!
    if (track.LineType === 0 || next.Frame === previous.Frame) return valueOf(index - 1)
    return valueOf(index - 1) + ((valueOf(index) - valueOf(index - 1)) * (ms - previous.Frame)) / (next.Frame - previous.Frame)
  }
  return valueOf(keys.length - 1)
}

const ORIENTATION: Readonly<Record<PkRenderer['billboard'], War3PopcornBatch['orientation']>> = {
  'screen-aligned': 'camera',
  'viewpos-aligned': 'camera',
  'axis-aligned': 'axis',
  'axis-aligned-spheroid': 'axis',
  'axis-aligned-capsule': 'axis',
  'plane-aligned': 'plane',
}
/** PopcornFX blend → render-material blend mode (1 blend, 3 additive). */
const BLEND: Readonly<Record<PkRenderer['blend'], number>> = {
  additive: 3,
  'additive-no-alpha': 3,
  'alpha-blend': 1,
  premultiplied: 1,
}

/**
 * Marks the batches whose colour comes from the player's colour: a drawing layer that read
 * `__a_Game.TeamColor` itself, or, where only spawners read it (handing it to their children in a
 * payload), every drawing layer of the effect.
 */
function markTeamColored(
  effect: PkEffect,
  instance: PkEffectInstance,
  emitterIndex: number,
  batches: { teamColored: boolean }[],
  batchIndex: ReadonlyMap<string, number>,
): void {
  const readers = instance.slots.filter(state => state?.readsTeamColor === true).map(state => state!.layer)
  if (readers.length === 0) return
  const drawing = readers.filter(layer => layer.renderers.length > 0)
  const layers = new Set((drawing.length > 0 ? drawing : effect.layers).map(layer => effect.layers.indexOf(layer)))
  for (const [key, index] of batchIndex) {
    const [emitter, layer] = key.split(':').map(Number)
    if (emitter === emitterIndex && layers.has(layer!)) batches[index]!.teamColored = true
  }
}

/** A bake's texture path in the game's merged tree (`_HD.w3mod/Textures/x.tif` → `Textures/x.tif`). */
export function war3PopcornTexture(path: string): string {
  return path.replaceAll('\\', '/').replace(/^_hd\.w3mod[/:]/iu, '')
}

/**
 * Where a node puts its effect, for the VM (`PkEnvironment.localToWorld`): the node's model-space
 * transform in Warcraft III units, flat column-major, turned into the effect's metres — the effect's
 * local metres scaled to units, carried by the node, scaled back (rotation and scale as they are, the
 * translation divided by `PKB_UNITS_PER_METRE`).
 */
export function war3PopcornFrame(transform: ArrayLike<number>): number[] {
  const frame = Array.from(transform)
  for (const at of [12, 13, 14]) frame[at] = frame[at]! / PKB_UNITS_PER_METRE
  return frame
}

/**
 * The model-space transform of an emitter's node at `seconds` into clip `clip` (a Warcraft III unit
 * frame), undefined where the node is not posed; without one the emitter stands at its pivot.
 */
export type War3PopcornNodeFrames = (nodeId: string, clip: number, seconds: number) => ArrayLike<number> | undefined

/**
 * Bakes every emitter over every clip. `effects[i]` is emitter i's effect, undefined when its bake
 * did not read (left out with a note by the caller). Effects place their particles through the
 * effect's frame (`xform_l2w`; 797 of the game's 811 bakes), which follows the emitter's node each
 * step (`nodeFrames`). The seed is the emitter's index, so a model bakes the same every time.
 */
export function bakeWar3Popcorn(
  emitters: readonly War3PopcornEmitter[],
  effects: readonly (PkEffect | undefined)[],
  clips: readonly War3PopcornClip[],
  signal?: AbortSignal,
  nodeFrames?: War3PopcornNodeFrames,
): War3PopcornBake {
  const batches: { -readonly [K in keyof War3PopcornBatch]: War3PopcornBatch[K] }[] = []
  const batchIndex = new Map<string, number>()
  const tracks: War3PopcornBake['tracks'][number][] = []
  const notes: string[] = []
  let total = 0
  let capped = false
  const dt = 1 / (WAR3_POPCORN_FRAME_RATE * STEPS_PER_FRAME)
  emitters.forEach((emitter, emitterIndex) => {
    const effect = effects[emitterIndex]
    if (effect === undefined) return
    const batchOf = (sprites: PkSpriteBatch): number => {
      const key = `${String(emitterIndex)}:${String(sprites.layer)}:${String(sprites.renderer)}`
      let index = batchIndex.get(key)
      if (index === undefined) {
        const renderer = sprites.definition
        index = batches.length
        batchIndex.set(key, index)
        batches.push({
          materialId: `war3-popcorn-${key.replaceAll(':', '-')}`,
          name: `${emitter.name} ${effect.layers[sprites.layer]?.name ?? ''}`.trim(),
          // a ribbon's sprites are its strips' points (sprites.ts)
          orientation: renderer.kind === 'ribbon' ? 'ribbon' : ORIENTATION[renderer.billboard],
          atlas: [Math.max(1, renderer.atlas[0]), Math.max(1, renderer.atlas[1])],
          texture: war3PopcornTexture(renderer.texture),
          blendMode: BLEND[renderer.blend],
          teamColored: false,
        })
      }
      return index
    }
    const unsupported = new Set<string>()
    const pivotFrame = war3PopcornFrame([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...emitter.pivot, 1])
    for (const [clipIndex, clip] of clips.entries()) {
      signal?.throwIfAborted()
      if (!war3PopcornGuideOn(emitter.guide, clip.name)) continue
      const seconds = Math.max(0, clip.endMs - clip.startMs) / 1000
      if (seconds > MAX_CLIP_SECONDS) notes.push(`${emitter.name}: ${clip.name} baked for its first ${String(MAX_CLIP_SECONDS)} s`)
      const frameCount = Math.max(1, Math.ceil(Math.min(seconds, MAX_CLIP_SECONDS) * WAR3_POPCORN_FRAME_RATE))
      const environment = createPkEnvironment()
      const instance = new PkEffectInstance(effect, environment, emitterIndex + 1)
      const step = (clipSeconds: number) => {
        const node = nodeFrames?.(emitter.nodeId, clipIndex, clipSeconds)
        environment.localToWorld = node === undefined ? pivotFrame : war3PopcornFrame(node)
        const ms = clip.startMs + clipSeconds * 1000
        const at = (track: AnimVector | undefined, lane = 0) => war3PopcornTrackAt(track, clip.startMs, clip.endMs, ms, lane)
        environment.running = at(emitter.visibility) > 0
        // the multipliers reach the effect as the game hands them: its __a_Game attributes
        environment.emissionRateMultiplier = at(emitter.emissionRate)
        environment.colorMultiplier = [at(emitter.color, 0), at(emitter.color, 1), at(emitter.color, 2), at(emitter.alpha)]
        instance.update(dt)
      }
      // One cycle of the clip, frame by frame, from where the instance stands: per batch, frame
      // offsets and sprite values, how many sprites, and whether its last frame drew anything.
      const record = () => {
        const recorded = new Map<number, { offsets: number[]; values: number[] }>()
        let count = 0,
          lastDrawn = false
        for (let frame = 0; frame < frameCount; frame++) {
          for (let sub = 0; sub < STEPS_PER_FRAME; sub++) step((frame * STEPS_PER_FRAME + sub) * dt)
          const drawn = new Map<string, PkSpriteBatch>()
          collectPkSprites(instance, drawn)
          lastDrawn = false
          for (const sprites of drawn.values()) {
            const index = batchOf(sprites)
            let entry = recorded.get(index)
            if (entry === undefined) recorded.set(index, (entry = { offsets: new Array<number>(frame + 1).fill(0), values: [] }))
            for (const sprite of sprites.sprites) {
              if (total + count >= MAX_BAKED_SPRITES) {
                capped = true
                break
              }
              count++
              lastDrawn = true
              const m = PKB_UNITS_PER_METRE
              // an axis card spans its axis: the record's axis is the half extent from the centre; a
              // ribbon point's axis x is its strip number
              const orientation = batches[index]!.orientation
              const axisScale = orientation === 'axis' ? m / 2 : orientation === 'ribbon' ? 1 : m
              entry.values.push(
                sprite.position[0] * m, sprite.position[1] * m, sprite.position[2] * m,
                sprite.halfSize[0] * m, sprite.halfSize[1] * m,
                sprite.rotation,
                ...sprite.color,
                sprite.frame,
                sprite.axis[0] * axisScale, sprite.axis[1] * axisScale, sprite.axis[2] * axisScale,
                ...sprite.normal,
              )
            }
          }
          // every batch of this cycle closes the frame at its sprite count
          for (const entry of recorded.values()) entry.offsets.push(entry.values.length / SPRITE_FLOATS)
        }
        return { recorded, count, lastDrawn }
      }
      // The first cycle from the effect's start keeps a burst (a level-up flash) that a warmed-up
      // cycle would have lost. A looping clip whose effect still draws at the end of it is a
      // continuous effect: its second cycle, continuing, is what repeats without a pop.
      let cycle = record()
      let loop = false
      if (clip.looping && cycle.lastDrawn) {
        cycle = record()
        loop = true
      }
      total += cycle.count
      const recorded = cycle.recorded
      for (const name of instance.unsupported) unsupported.add(name)
      markTeamColored(effect, instance, emitterIndex, batches, batchIndex)
      for (const [batch, entry] of recorded) {
        if (entry.values.length === 0) continue
        tracks.push({
          clipId: clip.clipId,
          batch,
          loop,
          frames: Uint32Array.from(entry.offsets),
          sprites: Float32Array.from(entry.values),
        })
      }
    }
    if (unsupported.size > 0)
      notes.push(`${emitter.name}: PopcornFX functions answered zero: ${[...unsupported].sort().join(', ')}`)
  })
  if (capped) notes.push(`PopcornFX bake stopped at ${String(MAX_BAKED_SPRITES)} sprites; later frames draw fewer`)
  return { frameRate: WAR3_POPCORN_FRAME_RATE, batches, tracks, notes }
}

/**
 * Reads each CORN emitter's bake through `read` (paths in the game's tree, one result each,
 * undefined when it does not read) and bakes the model; undefined for a model without CORN. A bake
 * that does not read or parse is left out with a note.
 */
export async function readWar3PopcornBake(
  model: Model,
  clips: readonly War3PopcornClip[],
  read: (paths: readonly string[]) => Promise<readonly (Uint8Array | undefined)[]>,
  signal?: AbortSignal,
  nodeFrames?: War3PopcornNodeFrames,
): Promise<War3PopcornBake | undefined> {
  const emitters = war3PopcornEmitters(model)
  if (emitters.length === 0) return undefined
  const paths = [...new Set(emitters.map(emitter => war3PopcornBakePath(emitter.path)))]
  const bytes = await read(paths)
  const notes: string[] = []
  const parsed = new Map<string, PkEffect | undefined>()
  paths.forEach((path, index) => {
    const data = bytes[index]
    if (data === undefined) {
      notes.push(`PopcornFX bake ${path} did not read; its emitters draw nothing`)
      return
    }
    try {
      parsed.set(path, readPkEffect(data, signal))
    } catch (error) {
      if (signal?.aborted) throw error
      notes.push(`PopcornFX bake ${path} did not parse: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  const baked = bakeWar3Popcorn(
    emitters,
    emitters.map(emitter => parsed.get(war3PopcornBakePath(emitter.path))),
    clips,
    signal,
    nodeFrames,
  )
  return { ...baked, notes: [...notes, ...baked.notes] }
}

/**
 * The frames of the nodes `nodeIds` (the CORN emitters' nodes) over the model's clips, from the
 * scene's pose sampler (the one the viewer poses the model with): one geometry-free sampler a clip,
 * made when the clip is first asked for. A pose is sampled once a baked frame (1/15 s, the steps
 * between take its pose) and kept for every listed node, so later emitters reuse it; a node that the
 * clip does not move (no channel on it or an ancestor) is sampled once a clip. A full rig sampled
 * every step of every emitter took 200 s for Arthas.
 */
export function war3PopcornNodeFrames(model: RenderModel, nodeIds: readonly string[]): War3PopcornNodeFrames {
  let clips: ReturnType<typeof war3AnimationClips> | undefined
  let projection: Parameters<typeof createModelSceneSampler>[0] | undefined
  let parents: Map<string, string> | undefined
  const samplers = new Map<number, ReturnType<typeof createModelSceneSampler> | undefined>()
  const moving = new Map<number, ReadonlySet<string>>()
  const poses = new Map<string, ReadonlyMap<string, Float64Array>>()
  return (nodeId, clip, seconds) => {
    clips ??= war3AnimationClips(model)
    if (projection === undefined) {
      const nodes = war3SceneNodes(model)
      parents = new Map(nodes.flatMap(node => (node.childIds ?? []).map(child => [child, node.id] as const)))
      projection = { nodes: nodes.map(node => ({ ...node, meshIds: [] })), meshes: [], primitives: [], skeleton: war3SkeletonBindings(model) }
    }
    const source = clips[clip]
    if (source === undefined) return undefined
    let animated = moving.get(clip)
    if (animated === undefined) {
      const targets = new Set(source.channels.filter(channel => channel.kind !== 'visibility').map(channel => channel.target))
      // the listed nodes the clip moves: a channel on the node or any ancestor
      const moved = nodeIds.filter(id => {
        for (let at: string | undefined = id; at !== undefined; at = parents!.get(at)) if (targets.has(at)) return true
        return false
      })
      moving.set(clip, (animated = new Set(moved)))
    }
    const at = animated.has(nodeId) ? Math.floor(seconds * WAR3_POPCORN_FRAME_RATE + 1e-6) / WAR3_POPCORN_FRAME_RATE : 0
    const key = `${String(clip)}:${String(at)}`
    let pose = poses.get(key)
    if (pose === undefined) {
      if (!samplers.has(clip))
        samplers.set(
          clip,
          createModelSceneSampler(projection, {
            clip: { ...source, channels: source.channels.filter(channel => channel.kind !== 'visibility') },
          }),
        )
      const transforms = samplers.get(clip)!.sample(at).nodeTransforms
      pose = new Map(nodeIds.flatMap(id => {
        const transform = transforms.get(id)
        return transform === undefined ? [] : [[id, Float64Array.from(transform)] as const]
      }))
      poses.set(key, pose)
    }
    return pose.get(nodeId)
  }
}
