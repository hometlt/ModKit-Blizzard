/**
 * The executable content of a PopcornFX bake: its layers — the particle fields they keep, their
 * samplers (curves, shapes, event streams, turbulence), compiled scripts and renderers — and the
 * graph that says which layer's events spawn which.
 *
 * Owner: GAME-WARCRAFT3. Read-only, over `bake.ts` and `script.ts`. The record classes and fields
 * are the ones Warcraft III Reforged's bakes were measured to use (W3ModelViewer
 * `mdxres/research/popcornfx-bake.md` and `popcornfx-vm.md`, MIT, reference only):
 *
 * - `CLayerCompileCache`: 2 fields, 5 events fired (with their payload names), 6 spatial layers,
 *   7 samplers, 8 renderers, 10 scripts, 12 the event whose payloads this layer reads.
 * - `CLayerGraphCompileCache`: 2 layer slots (`…_LayerSlot`: 0 layer, 1 input events, 2 output events),
 *   3 event slots (`…_EventSlot`: 0 name, 2 target layer slots). Slot 0 is the effect root.
 * - Renderers (`CLayerCompileCacheRenderer`): 1 inputs (id 0 Position, 1 Size, 2 Enabled, 3/6
 *   Rotation, 4 Axis, 5 NormalAxis, 7 Size2, 9 SelfID, 10 ParentID, ≥100 named), 2 properties
 *   (`BillboardingMode`, `Transparent.Type`, `Diffuse.DiffuseMap`, `Atlas.SubDiv`, …), 3 material.
 *
 * Units are PopcornFX's metres; Reforged's art is 1 m = 50 Warcraft III units (`PKB_UNITS_PER_METRE`).
 * A layer that fails to read is kept, named, with a warning instead of its content.
 */
import { PkbBake } from './bake.js'
import { decodePkScript, type PkScript } from './script.js'

/** Warcraft III units per PopcornFX metre (1 m = 50 units: three independent checks agree). */
export const PKB_UNITS_PER_METRE = 50

/** A curve sampler: knots in 0..1, `dimension` values a knot, cubic Hermite by in/out tangents. */
export interface PkCurve {
  readonly dimension: number
  readonly times: readonly number[]
  readonly values: readonly number[]
  /** knots × 2 × dimension: each knot's in tangent, then its out tangent; empty for linear. */
  readonly tangents: readonly number[]
}

/** A shape sampler, PopcornFX 2 types: 0 box, 1 sphere, 2 ellipsoid, 3 cylinder, 4 capsule, 5 cone, 6 mesh. */
export interface PkShape {
  readonly type: number
  readonly radius: number
  readonly innerRadius: number
  readonly height: number
  /** In PopcornFX's Y-up shape frame. */
  readonly offset: readonly [number, number, number]
  readonly eulerDegrees: readonly [number, number, number]
}

export type PkSampler =
  | { readonly name: string; readonly kind: 'curve'; readonly curve: PkCurve }
  | { readonly name: string; readonly kind: 'shape'; readonly shape: PkShape }
  | { readonly name: string; readonly kind: 'event-stream'; readonly times: readonly number[] }
  | { readonly name: string; readonly kind: 'turbulence'; readonly wavelength: number; readonly strength: number }
  | { readonly name: string; readonly kind: 'spectrum' | 'unknown'; readonly className: string }

/** PopcornFX billboarding: screen, view-position, axis, axis spheroid, axis capsule, plane aligned. */
export const PK_BILLBOARD_MODES = Object.freeze([
  'screen-aligned',
  'viewpos-aligned',
  'axis-aligned',
  'axis-aligned-spheroid',
  'axis-aligned-capsule',
  'plane-aligned',
] as const)
export type PkBillboardMode = (typeof PK_BILLBOARD_MODES)[number]

/** PopcornFX transparency: additive, additive without alpha, alpha blend, premultiplied. */
export const PK_BLENDS = Object.freeze(['additive', 'additive-no-alpha', 'alpha-blend', 'premultiplied'] as const)
export type PkBlend = (typeof PK_BLENDS)[number]

export interface PkRenderer {
  readonly kind: 'billboard' | 'ribbon' | 'distortion' | 'light' | 'other'
  readonly material: string
  /** The diffuse (or distortion) map, as the bake names it (`_HD.w3mod/Textures/FX/…tif`). */
  readonly texture: string
  readonly billboard: PkBillboardMode
  readonly blend: PkBlend
  readonly atlas: readonly [number, number]
  readonly size2d: boolean
  readonly flipUvs: boolean
  /** The particle field bound to each input (`Position`, `Size`, `Color`, `Axis`, …). */
  readonly inputs: Readonly<Record<string, number>>
}

export interface PkLayer {
  readonly record: number
  /** The graph node of its fields (`n20_8`), or `spawnerN`/`layerN`. */
  readonly name: string
  /** The particle stream fields, with the operand kind each holds. */
  readonly fields: readonly { readonly name: string; readonly kind: number }[]
  readonly spawn?: PkScript
  readonly evolveOnSpawn?: PkScript
  readonly evolve?: PkScript
  readonly samplers: readonly PkSampler[]
  readonly renderers: readonly PkRenderer[]
  /** For each event this layer fires, its payload names in append order. */
  readonly outputPayloads: Readonly<Record<string, readonly string[]>>
  /** The payloads this layer reads, in `extractPayloadElement` order. */
  readonly inputPayloads: readonly string[]
  /** The spatial layers `__spatialLayer_N` names, in N order. */
  readonly spatialLayers: readonly string[]
  readonly warnings: readonly string[]
}

export interface PkLayerSlot {
  /** Index into `layers`, -1 when the slot names none. */
  readonly layer: number
  readonly inputEvents: readonly number[]
  readonly outputEvents: readonly number[]
}

export interface PkEventSlot {
  readonly name: string
  readonly targetSlots: readonly number[]
}

export interface PkEffect {
  readonly version: number
  readonly layers: readonly PkLayer[]
  readonly slots: readonly PkLayerSlot[]
  readonly events: readonly PkEventSlot[]
  readonly classes: readonly { readonly name: string; readonly count: number }[]
  readonly warnings: readonly string[]
}

/** The effect in `bytes`: its bake read, its layers and graph resolved. */
export function readPkEffect(bytes: Uint8Array, signal?: AbortSignal): PkEffect {
  const bake = PkbBake.read(bytes, signal)
  return pkEffectOf(bake, signal)
}

/** The effect a bake holds. */
export function pkEffectOf(bake: PkbBake, signal?: AbortSignal): PkEffect {
  const warnings: string[] = []
  const layerByRecord = new Map<number, number>()
  const layers: PkLayer[] = []
  for (const record of bake.ofClass('CLayerCompileCache')) {
    signal?.throwIfAborted()
    layerByRecord.set(record, layers.length)
    layers.push(readLayer(bake, record))
  }
  const graph = bake.ofClass('CLayerGraphCompileCache')[0]
  const slots: PkLayerSlot[] = []
  const events: PkEventSlot[] = []
  if (graph === undefined) warnings.push('the bake has no layer graph')
  else {
    for (const slot of bake.refs(graph, 2)) {
      if (slot < 0) continue
      slots.push({
        layer: layerByRecord.get(bake.ref(slot, 0)) ?? -1,
        inputEvents: bake.u32s(slot, 1),
        outputEvents: bake.u32s(slot, 2),
      })
    }
    for (const event of bake.refs(graph, 3))
      events.push(event < 0 ? { name: '', targetSlots: [] } : { name: bake.text(event, 0), targetSlots: bake.u32s(event, 2) })
  }
  return {
    version: bake.version,
    layers,
    slots,
    events,
    classes: bake.classes(),
    warnings,
  }
}

function readLayer(bake: PkbBake, record: number): PkLayer {
  const warnings: string[] = []
  const fields = bake
    .refs(record, 2)
    .filter(field => field >= 0)
    // A field record stores its operand kind less one.
    .map(field => ({ name: bake.text(field, 0), kind: bake.u32(field, 1) + 1 }))
  const samplers: PkSampler[] = []
  for (const sampler of bake.refs(record, 7)) {
    if (sampler < 0) continue
    samplers.push(readSampler(bake, bake.text(sampler, 0), bake.ref(sampler, 1)))
  }
  const scripts: { spawn?: PkScript; evolveOnSpawn?: PkScript; evolve?: PkScript } = {}
  for (const blob of bake.refs(record, 10)) {
    if (blob < 0 || bake.classOf(blob) !== 'CCompilerBlobCache') continue
    try {
      const script = decodePkScript(bake, blob)
      if (script.kind === null) scripts.spawn ??= script
      else if (script.kind === 3) scripts.evolveOnSpawn ??= script
      else if (script.kind === 4) scripts.evolve ??= script
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error))
    }
  }
  const renderers = bake
    .refs(record, 8)
    .filter(renderer => renderer >= 0)
    .map(renderer => readRenderer(bake, renderer, fields.length))
  const payloadNames = (event: number) => bake.refs(event, 2).map(payload => (payload < 0 ? '' : bake.text(payload, 0)))
  const outputPayloads: Record<string, readonly string[]> = {}
  for (const event of bake.refs(record, 5)) if (event >= 0 && bake.has(event, 0)) outputPayloads[bake.text(event, 0)] = payloadNames(event)
  const input = bake.ref(record, 12)
  const node = fields.map(field => field.name).find(name => name.startsWith('n') && name.includes('__'))
  return {
    record,
    name: node === undefined ? `${renderers.length === 0 ? 'spawner' : 'layer'}${String(record)}` : node.slice(0, node.indexOf('__')),
    fields,
    ...scripts,
    samplers,
    renderers,
    outputPayloads,
    inputPayloads: input >= 0 && bake.classOf(input) === 'CLayerCompileCacheEvent' ? payloadNames(input) : [],
    spatialLayers: bake.refs(record, 6).filter(spatial => spatial >= 0).map(spatial => bake.text(spatial, 0)),
    warnings,
  }
}

function readSampler(bake: PkbBake, name: string, data: number): PkSampler {
  const className = data >= 0 ? bake.classOf(data) : ''
  switch (className) {
    case 'CParticleNodeSamplerData_Curve': {
      const dimension = bake.has(data, 9) ? bake.i32(data, 9) : 1
      let times = bake.f32s(data, 16)
      let values = bake.f32s(data, 17)
      if (dimension < 1 || dimension > 4 || values.length < times.length * dimension) {
        times = []
        values = []
      }
      return {
        name,
        kind: 'curve',
        curve: { dimension: Math.min(4, Math.max(1, dimension)), times, values, tangents: bake.f32s(data, 18) },
      }
    }
    case 'CParticleNodeSamplerData_Shape':
      return {
        name,
        kind: 'shape',
        shape: {
          type: bake.i32(data, 15, 0),
          radius: bake.f32(data, 17, 1),
          innerRadius: bake.f32(data, 18, 0),
          height: bake.f32(data, 20, 1),
          offset: bake.v3(data, 13),
          eulerDegrees: bake.v3(data, 14),
        },
      }
    case 'CParticleNodeSamplerData_EventStream':
      return { name, kind: 'event-stream', times: bake.f32s(data, 10) }
    case 'CParticleNodeSamplerData_Turbulence':
      // Only the fields a bake overrides are written; neither is ever exactly 1 in the game's bakes.
      return { name, kind: 'turbulence', wavelength: bake.f32(data, 11, 1), strength: bake.f32(data, 12, 1) }
    default:
      return className.includes('Turbulence')
        ? { name, kind: 'turbulence', wavelength: 1, strength: 1 }
        : { name, kind: className.includes('Spectrum') ? 'spectrum' : 'unknown', className }
  }
}

const RENDERER_INPUTS: Readonly<Record<number, string>> = {
  0: 'Position',
  1: 'Size',
  2: 'Enabled',
  3: 'Rotation',
  4: 'Axis',
  5: 'NormalAxis',
  6: 'Rotation',
  7: 'Size2',
  9: 'SelfID',
  10: 'ParentID',
}

function readRenderer(bake: PkbBake, record: number, fieldCount: number): PkRenderer {
  const material = bake.text(record, 3)
  let texture = ''
  let billboard: PkBillboardMode = 'screen-aligned'
  let blend: PkBlend = 'additive'
  let atlas: [number, number] = [1, 1]
  let size2d = false
  let flipUvs = false
  for (const property of bake.refs(record, 2)) {
    if (property < 0) continue
    const raw = bake.raw(property, 2)
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    const v0 = raw.byteLength >= 4 ? view.getInt32(0, true) : 0
    const v1 = raw.byteLength >= 8 ? view.getInt32(4, true) : 0
    switch (bake.text(property, 0)) {
      case 'Diffuse.DiffuseMap':
      case 'Distortion.DistortionMap':
        if (texture === '' && bake.has(property, 3)) texture = bake.text(property, 3)
        break
      case 'BillboardingMode':
        billboard = PK_BILLBOARD_MODES[Math.min(5, Math.max(0, v0))]!
        break
      case 'Transparent.Type':
        blend = PK_BLENDS[Math.min(3, Math.max(0, v0))]!
        break
      case 'Atlas.SubDiv':
        atlas = [Math.max(1, v0), Math.max(1, v1)]
        break
      case 'EnableSize2D':
        size2d = raw.byteLength > 0
        break
      case 'FlipUVs':
        flipUvs = raw.byteLength > 0
        break
    }
  }
  const inputs: Record<string, number> = {}
  for (const input of bake.refs(record, 1)) {
    if (input < 0) continue
    const id = bake.i32(input, 0, 0)
    const field = bake.i32(input, 1, 0)
    const name = RENDERER_INPUTS[id] ?? (bake.has(input, 2) ? bake.text(input, 2) : `input${String(id)}`)
    if (field >= 0 && field < fieldCount) inputs[name] = field
  }
  const lower = material.toLowerCase()
  return {
    kind: lower.includes('ribbon')
      ? 'ribbon'
      : lower.includes('distortion')
        ? 'distortion'
        : lower.includes('light')
          ? 'light'
          : lower.includes('billboard')
            ? 'billboard'
            : 'other',
    material,
    texture,
    billboard,
    blend,
    atlas,
    size2d,
    flipUvs,
    inputs,
  }
}

/**
 * The value of curve `curve` at `t` (clamped to its knots): cubic Hermite by its tangents when it
 * has them, linear otherwise. Up to four components.
 */
export function samplePkCurve(curve: PkCurve, t: number): number[] {
  const out = [0, 0, 0, 0]
  const count = curve.times.length
  if (count === 0) return out
  const knot = (index: number) => {
    for (let lane = 0; lane < curve.dimension && lane < 4; lane++) out[lane] = curve.values[index * curve.dimension + lane] ?? 0
    return out
  }
  const at = Number.isFinite(t) ? t : 0
  if (count === 1 || at <= curve.times[0]!) return knot(0)
  if (at >= curve.times[count - 1]!) return knot(count - 1)
  let k = 0
  while (k + 2 < count && curve.times[k + 1]! <= at) k++
  const span = curve.times[k + 1]! - curve.times[k]!
  const u = span > 1e-9 ? (at - curve.times[k]!) / span : 0
  const u2 = u * u
  const u3 = u2 * u
  const hermite = curve.tangents.length >= count * 2 * curve.dimension
  for (let lane = 0; lane < curve.dimension && lane < 4; lane++) {
    const p0 = curve.values[k * curve.dimension + lane] ?? 0
    const p1 = curve.values[(k + 1) * curve.dimension + lane] ?? 0
    if (!hermite) {
      out[lane] = p0 + (p1 - p0) * u
      continue
    }
    // The out tangent of knot k and the in tangent of knot k + 1.
    const m0 = curve.tangents[k * 2 * curve.dimension + curve.dimension + lane] ?? 0
    const m1 = curve.tangents[(k + 1) * 2 * curve.dimension + lane] ?? 0
    out[lane] = (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 * span + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1 * span
  }
  return out
}
