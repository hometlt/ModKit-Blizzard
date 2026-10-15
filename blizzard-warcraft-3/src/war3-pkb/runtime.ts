/**
 * Runs a PopcornFX effect: the compiled spawn and evolve scripts of every layer over its particles,
 * with events routed through the layer graph.
 *
 * Owner: GAME-WARCRAFT3. The instruction set, operand spaces, swizzles and graph wiring are what
 * Warcraft III Reforged's bakes were measured to hold, and the built-in functions are reimplemented
 * from their names and uses (W3ModelViewer `mdxres/research/popcornfx-vm.md`, MIT, reference only;
 * the code is written here). Scene queries — ray casts, view resolution — answer "nothing there",
 * what an effect previewed on its own sees. A function no table names answers zero and is listed
 * in `unsupported`.
 *
 * Values are four 32-bit lanes read as floats or integers by the operand's kind (booleans are
 * all-ones masks). The simulation runs in PopcornFX metres in the effect's frame, Z up; a matrix is
 * a flat column-major 4×4 (`@modkit/codec-kit/model-math/transform`). Randomness is a seeded
 * generator: the same seed gives the same effect. Bounded by `PK_MAX_PARTICLES_PER_SLOT` particles a
 * layer slot and the scripts' own length; nothing here reads files or the clock.
 */
import { invertAffine } from '@modkit/codec-kit/model-math/transform'
import { hsvToRgb, rgbToHsv } from '@modkit/codec-kit/raster'
import { samplePkCurve, type PkEffect, type PkLayer, type PkSampler, type PkShape } from './effect.js'
import { PK_OP, PK_SPACE, isPkBool, isPkInt, pkLaneCode, pkLanes, type PkInstruction, type PkOperand, type PkScript } from './script.js'

export const PK_MAX_PARTICLES_PER_SLOT = 4096
/**
 * Identities a layer slot numbers before they wrap (a parent's identity is slot × this + its number):
 * 2^16, so identities of 255 slots stay below 2^24, exact as floats too.
 */
const PK_IDS_PER_SLOT = 65536

type Vec3 = [number, number, number]
type Quat = [number, number, number, number]
const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

// One float32's bits, and back: a lane holds 32 bits read as a float or an integer by the kind.
const BITS_F32 = new Float32Array(1)
const BITS_I32 = new Int32Array(BITS_F32.buffer)
const toBits = (value: number): number => {
  BITS_F32[0] = value
  return BITS_I32[0]!
}
const fromBits = (bits: number): number => {
  BITS_I32[0] = bits
  return BITS_F32[0]!
}

/**
 * One VM value: four 32-bit lanes kept as their int32 bits (`w`), read as floats through
 * `fromBits`. A plain array, not typed arrays: the VM makes one a value, and three typed-array
 * allocations a value were most of a run's time.
 */
class Lanes {
  readonly w: number[] = [0, 0, 0, 0]
  static of(x = 0, y = 0, z = 0, w = 0): Lanes {
    const value = new Lanes()
    value.w[0] = toBits(x)
    value.w[1] = toBits(y)
    value.w[2] = toBits(z)
    value.w[3] = toBits(w)
    return value
  }
  copy(): Lanes {
    const value = new Lanes()
    for (let lane = 0; lane < 4; lane++) value.w[lane] = this.w[lane]!
    return value
  }
  xyz(): Vec3 {
    return [fromBits(this.w[0]!), fromBits(this.w[1]!), fromBits(this.w[2]!)]
  }
}

/** A shared zero, never written: what an absent operand reads. */
const ZERO = new Lanes()

/** What an effect instance knows of the world around it. Distances are metres. */
export interface PkEnvironment {
  /** Effect space to simulation space, a flat column-major 4×4. */
  localToWorld: readonly number[]
  cameraPosition: Vec3
  /** Whether the host wants the effect to keep emitting (its CORN node is gated on). */
  running: boolean
  emissionRateMultiplier: number
  colorMultiplier: [number, number, number, number]
  /** `__a_Game.TeamColor`: the player's colour, read by the scripts that ask for it. */
  teamColor: [number, number, number, number]
  /**
   * `__a_Game.TargetPosition`: where a beam (chain lightning, drains, links) ends, in simulation
   * space. The game sets the target unit's position; on its own an effect aims 6 m ahead, 1 m up.
   */
  targetPosition: Vec3
  time: number
}

export const createPkEnvironment = (): PkEnvironment => ({
  localToWorld: [...IDENTITY],
  cameraPosition: [0, -20, 10],
  running: true,
  emissionRateMultiplier: 1,
  colorMultiplier: [1, 1, 1, 1],
  teamColor: [1, 1, 1, 1],
  targetPosition: [6, 0, 1],
  time: 0,
})

/** The particles of one layer slot, field by field (four lanes a particle). */
export class PkLayerState {
  readonly layer: PkLayer
  readonly slot: number
  readonly lifeRatioField: number
  readonly invLifeField: number
  fields: Int32Array[] = []
  /** The same storage as `fields`, read as floats. */
  floats: Float32Array[] = []
  newborn: boolean[] = []
  killed: boolean[] = []
  /** Each particle's number in its layer, given at birth and kept for its life (`SelfID`). */
  ids: number[] = []
  private nextId = 0
  count = 0
  /** Set once a script of this layer reads `__a_Game.TeamColor`: the effect is team-coloured. */
  readsTeamColor = false

  constructor(layer: PkLayer, slot: number) {
    this.layer = layer
    this.slot = slot
    this.lifeRatioField = layer.fields.findIndex(field => field.name === 'self.lifeRatio')
    this.invLifeField = layer.fields.findIndex(field => field.name === 'self.invLife')
  }

  get capacity(): number {
    return this.newborn.length
  }

  /** A field of a particle as floats (`floatField`) or its raw lanes. */
  floatField(field: number, particle: number, lane = 0): number {
    return this.floats[field]![particle * 4 + lane]!
  }

  read(field: number, particle: number): Lanes {
    const value = new Lanes()
    const data = this.fields[field]!
    for (let lane = 0; lane < 4; lane++) value.w[lane] = data[particle * 4 + lane]!
    return value
  }

  write(field: number, particle: number, value: Lanes): void {
    const data = this.fields[field]!
    for (let lane = 0; lane < 4; lane++) data[particle * 4 + lane] = value.w[lane]!
  }

  allocate(): number {
    if (this.count === this.capacity) {
      const capacity = Math.max(16, this.capacity * 2)
      this.fields = this.layer.fields.map((_, index) => {
        const grown = new Int32Array(capacity * 4)
        const old = this.fields[index]
        if (old !== undefined) grown.set(old.subarray(0, this.count * 4))
        return grown
      })
      this.floats = this.fields.map(field => new Float32Array(field.buffer))
      this.newborn.length = capacity
      this.killed.length = capacity
    }
    const particle = this.count++
    for (const field of this.fields) field.fill(0, particle * 4, particle * 4 + 4)
    this.newborn[particle] = true
    this.killed[particle] = false
    this.ids[particle] = this.nextId++
    return particle
  }

  /**
   * Writes the particle's identity fields, the stream's own (PopcornFX fills them, no script does):
   * `SelfID` its number, `ParentID` the particle whose event spawned it — what joins a ribbon's
   * points and tells one ribbon from another. As integers or floats by the field's kind.
   */
  writeIdentity(particle: number, parent: number): void {
    this.layer.fields.forEach((field, index) => {
      const value = field.name === 'SelfID' ? this.ids[particle]! : field.name === 'ParentID' ? parent : undefined
      if (value === undefined) return
      if (isPkInt(field.kind)) this.fields[index]![particle * 4] = value
      else this.floats[index]![particle * 4] = value
    })
  }

  /** The particle's number across the effect: its layer slot and its number in the layer. */
  identity(particle: number): number {
    return (this.slot + 1) * PK_IDS_PER_SLOT + (this.ids[particle]! % PK_IDS_PER_SLOT)
  }

  /** Removes killed particles, keeping the survivors' order. */
  compact(): void {
    let write = 0
    for (let read = 0; read < this.count; read++) {
      if (this.killed[read] === true) continue
      if (write !== read) {
        for (const field of this.fields) field.copyWithin(write * 4, read * 4, read * 4 + 4)
        this.newborn[write] = this.newborn[read]!
        this.ids[write] = this.ids[read]!
      }
      this.killed[write] = false
      write++
    }
    this.count = write
  }
}

/** Mulberry32: a small seeded generator, the same sequence for the same seed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const transformPoint = (m: readonly number[], v: Vec3): Vec3 => [
  m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2] + m[12]!,
  m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2] + m[13]!,
  m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2] + m[14]!,
]
const transformDirection = (m: readonly number[], v: Vec3): Vec3 => [
  m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2],
  m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2],
  m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2],
]
const length = (v: readonly number[]) => Math.hypot(v[0]!, v[1]!, v[2]!)
const unitOr = (v: Vec3, fallback: Vec3): Vec3 => {
  const size = length(v)
  return size > 1e-6 ? [v[0] / size, v[1] / size, v[2] / size] : fallback
}
/** `v` rotated by the unit quaternion `q` (x, y, z, w). */
function rotateVector(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q
  const tx = 2 * (y * v[2] - z * v[1])
  const ty = 2 * (z * v[0] - x * v[2])
  const tz = 2 * (x * v[1] - y * v[0])
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)]
}
const normalizeQuat = (q: Quat): Quat => {
  const size = Math.hypot(...q)
  return size > 1e-6 ? [q[0] / size, q[1] / size, q[2] / size, q[3] / size] : [0, 0, 0, 1]
}
const axisAngle = (axis: Vec3, angle: number): Quat => {
  const s = Math.sin(angle / 2)
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]
}
const multiplyQuat = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]

/** A uniformly random unit vector. */
function randomUnit(random: () => number): Vec3 {
  const z = random() * 2 - 1
  const angle = random() * Math.PI * 2
  const s = Math.sqrt(Math.max(0, 1 - z * z))
  return [s * Math.cos(angle), s * Math.sin(angle), z]
}

/** A radius in [inner, outer] uniform over the volume of `dimensions` (2 a disc, 3 a ball). */
function radial(u: number, inner: number, outer: number, dimensions: 2 | 3): number {
  if (outer <= 0) return 0
  const clamped = Math.min(Math.max(inner, 0), outer)
  const base = (clamped / outer) ** dimensions
  const fraction = base + (1 - base) * u
  return outer * (dimensions === 3 ? Math.cbrt(fraction) : Math.sqrt(fraction))
}

/** A point in a shape's volume, in the effect's Z-up frame (the shape is authored Y up). */
export function samplePkShape(shape: PkShape, random: () => number): Vec3 {
  let p: Vec3
  switch (shape.type) {
    case 1:
    case 2: {
      const direction = randomUnit(random)
      const r = radial(random(), shape.innerRadius, shape.radius, 3)
      p = [direction[0] * r, direction[1] * r, direction[2] * r]
      break
    }
    case 3: {
      const angle = random() * Math.PI * 2
      const r = radial(random(), shape.innerRadius, shape.radius, 2)
      p = [Math.cos(angle) * r, (random() - 0.5) * shape.height, Math.sin(angle) * r]
      break
    }
    case 4: {
      const angle = random() * Math.PI * 2
      const r = radial(random(), shape.innerRadius, shape.radius, 2)
      p = [Math.cos(angle) * r, (random() - 0.5) * (shape.height + 2 * shape.radius), Math.sin(angle) * r]
      break
    }
    case 5: {
      const h = random()
      const angle = random() * Math.PI * 2
      const r = radial(random(), 0, shape.radius * h, 2)
      p = [Math.cos(angle) * r, h * shape.height, Math.sin(angle) * r]
      break
    }
    case 0:
      p = [(random() - 0.5) * shape.radius, (random() - 0.5) * shape.height, (random() - 0.5) * shape.radius]
      break
    default:
      p = [0, 0, 0]
  }
  const [ex, ey, ez] = shape.eulerDegrees.map(degrees => (degrees * Math.PI) / 180) as Vec3
  if (ex !== 0 || ey !== 0 || ez !== 0) {
    // yaw (about Y), then pitch (about X), then roll (about Z), as System.Numerics composes them
    const q = multiplyQuat(multiplyQuat(axisAngle([0, 1, 0], ey), axisAngle([1, 0, 0], ex)), axisAngle([0, 0, 1], ez))
    p = rotateVector(q, p)
  }
  p = [p[0] + shape.offset[0], p[1] + shape.offset[1], p[2] + shape.offset[2]]
  return [p[0], p[2], p[1]]
}

type Bind =
  | { kind: 'zero' | 'scene-dt' | 'scene-time' | 'pointer' | 'emission' | 'color' | 'team-color' | 'target' | 'one' }
  | { kind: 'field' | 'sampler' | 'event' | 'spatial'; index: number }

type Fn =
  | 'rand' | 'vrand' | 'sample-position' | 'sample-normal' | 'sample-curve' | 'sample-turbulence'
  | 'xform-l2w-f' | 'xform-l2w-d' | 'xform-w2l-f' | 'xform-w2l-d' | 'xform-w2w'
  | 'rgb2hsv' | 'hsv2rgb' | 'radians-rotate' | 'rotate' | 'axis-side' | 'axis-up' | 'axis-forward' | 'orientation-mult'
  | 'effect-position' | 'effect-axis-up' | 'effect-axis-side' | 'effect-axis-forward' | 'effect-age' | 'effect-running'
  | 'scene-orientation' | 'view-position' | 'view-distance' | 'scene-intersect'
  | 'kill' | 'generate' | 'event-stream-generate' | 'event-stream-duration' | 'trigger'
  | 'init-payload' | 'append-payload' | 'build-payload-element' | 'kick'
  | 'extract-f' | 'extract-i' | 'extract-o' | 'false' | 'zero'
  | 'spatial-allocate' | 'spatial-append' | 'spatial-insert' | 'spatial-closest'
  | null

interface ScriptPlan {
  readonly externals: readonly Bind[]
  readonly calls: readonly Fn[]
  readonly registers: readonly [Lanes[], Lanes[], Lanes[]]
  /** The script's constants as lanes, made once: no instruction writes into its inputs. */
  readonly constants: readonly Lanes[]
}

interface PendingSpawn {
  eventSlot: number
  /** The spawning particle's identity (`PkLayerState.identity`), 0 for the effect's own start. */
  parent: number
  count: number
  firstIndex: number
  names: readonly string[]
  readonly elements: Map<string, number>
}

interface PayloadElement {
  readonly from: Lanes
  readonly to: Lanes
  readonly flags: number
  readonly baseIndex: number
}

interface SpatialTable {
  current: { key: Vec3; values: Lanes[] }[]
  previous: { key: Vec3; values: Lanes[] }[]
}

/** The function each name (and the object it is called on) runs. */
function functionOf(name: string, objectType: string): Fn {
  switch (name) {
    case 'rand': return 'rand'
    case 'vrand': return 'vrand'
    case 'samplePosition': return 'sample-position'
    case 'sampleNormal': return 'sample-normal'
    case 'sample':
      return objectType.startsWith('samplerCurve') ? 'sample-curve' : objectType.startsWith('samplerTurbulence') ? 'sample-turbulence' : 'zero'
    case 'xform_l2w_f_masked': return 'xform-l2w-f'
    case 'xform_l2w_d_masked': return 'xform-l2w-d'
    case 'xform_w2l_f_masked': return 'xform-w2l-f'
    case 'xform_w2l_d_masked': return 'xform-w2l-d'
    case 'xform_w2w_f_masked':
    case 'xform_w2w_d_masked': return 'xform-w2w'
    case 'rgb2hsv': return 'rgb2hsv'
    case 'hsv2rgb': return 'hsv2rgb'
    case 'radians.rotate': return 'radians-rotate'
    case 'rotate': return 'rotate'
    case 'orientation_axisSide': return 'axis-side'
    case 'orientation_axisUp': return 'axis-up'
    case 'orientation_axisForward': return 'axis-forward'
    case 'orientation_mult': return 'orientation-mult'
    case 'effect.position': return 'effect-position'
    case 'effect.axisUp': return 'effect-axis-up'
    case 'effect.axisSide': return 'effect-axis-side'
    case 'effect.axisForward': return 'effect-axis-forward'
    case 'effect.age': return 'effect-age'
    case 'effect.isRunning': return 'effect-running'
    case 'scene.orientation_f_norm': return 'scene-orientation'
    case 'view.position': return 'view-position'
    case 'view.distance': return 'view-distance'
    case 'scene.intersect': return 'scene-intersect'
    case 'self.kill': return 'kill'
    case 'generate': return objectType === 'samplerEventStreamC' ? 'event-stream-generate' : 'generate'
    case 'duration': return 'event-stream-duration'
    case 'trigger': return 'trigger'
    case 'initPayload': return objectType === 'particleEvent' ? 'init-payload' : 'zero'
    case 'appendPayload': return objectType === 'particleEvent' ? 'append-payload' : objectType === 'SpatialLayerType' ? 'spatial-append' : 'zero'
    case 'kick': return objectType === 'particleEvent' ? 'kick' : 'zero'
    case 'buildPayloadElement': return 'build-payload-element'
    case 'extractPayloadElementF1':
    case 'extractPayloadElementF2':
    case 'extractPayloadElementF3':
    case 'extractPayloadElementF4': return 'extract-f'
    case 'extractPayloadElementI1': return 'extract-i'
    case 'extractPayloadElementO': return 'extract-o'
    case 'allocatePayload': return objectType === 'SpatialLayerType' ? 'spatial-allocate' : 'zero'
    case 'insert': return objectType === 'SpatialLayerType' ? 'spatial-insert' : 'zero'
    case 'closestF3': return objectType === 'SpatialLayerType' ? 'spatial-closest' : 'zero'
    case '_pksi_War3.HasTeleported_SI':
    case 'contains': return 'false'
    default: return 'zero'
  }
}

/**
 * One running PopcornFX effect. `update(dt)` advances it: the root slot's spawn runs once, then
 * each frame every live particle's life advances, its evolve script runs, the events it kicked
 * spawn into their target slots, and the dead are removed.
 */
export class PkEffectInstance {
  readonly effect: PkEffect
  readonly environment: PkEnvironment
  readonly slots: readonly (PkLayerState | undefined)[]
  /** The externals and functions this run met but cannot answer (zero). */
  readonly unsupported = new Set<string>()
  age = 0
  private started = false
  private readonly random: () => number
  private readonly plans = new Map<PkScript, ScriptPlan>()
  private readonly pending: PendingSpawn[] = []
  private readonly elements: PayloadElement[] = []
  private readonly spatial = new Map<string, SpatialTable>()
  private readonly spatialNames: string[] = []
  private readonly spatialPending: Lanes[][] = []

  constructor(effect: PkEffect, environment: PkEnvironment, seed: number) {
    this.effect = effect
    this.environment = environment
    this.random = seeded(seed)
    this.slots = effect.slots.map((slot, index) => {
      const layer = effect.layers[slot.layer]
      return layer === undefined ? undefined : new PkLayerState(layer, index)
    })
  }

  /** Until every particle has died (and the effect has started). */
  get alive(): boolean {
    return !this.started || this.slots.some(slot => slot !== undefined && slot.count > 0) || this.pending.length > 0
  }

  update(dt: number): void {
    if (!this.started) {
      this.started = true
      if (this.slots[0] !== undefined) this.spawnInto(0, { eventSlot: -1, parent: 0, count: 1, firstIndex: 0, names: [], elements: new Map() })
    }
    if (!(dt > 0)) return
    this.age += dt
    this.environment.time += dt
    for (const table of this.spatial.values()) {
      table.previous = table.current
      table.current = []
    }
    this.spatialPending.length = 0
    for (const state of this.slots) {
      if (state === undefined || state.count === 0) continue
      const script = state.layer.evolve
      // A layer with neither an evolve script nor a renderer only relays events from its spawn script.
      if (script === undefined && state.layer.renderers.length === 0) {
        for (let particle = 0; particle < state.count; particle++) if (state.newborn[particle] !== true) state.killed[particle] = true
        state.compact()
        continue
      }
      for (let particle = 0; particle < state.count; particle++) {
        if (state.newborn[particle] === true) continue
        if (state.lifeRatioField >= 0 && state.invLifeField >= 0) {
          const inverse = state.floatField(state.invLifeField, particle)
          if (inverse !== 0) {
            const ratio = state.read(state.lifeRatioField, particle)
            // saturates at 1, as PopcornFX's does: a spawner of no life (invLife ∞) ends at 1, and the
            // payloads it hands its children (LifeRatio) stay in 0..1 instead of running to ∞
            ratio.w[0] = toBits(Math.min(1, fromBits(ratio.w[0]!) + dt * inverse))
            state.write(state.lifeRatioField, particle, ratio)
          }
        }
        if (script !== undefined) this.run(script, state, particle, dt, undefined, 0, 0)
        if (state.lifeRatioField >= 0 && !(state.floatField(state.lifeRatioField, particle) < 1)) state.killed[particle] = true
      }
      state.compact()
      this.flushPending()
    }
    this.flushPending()
    for (const state of this.slots) if (state !== undefined) for (let particle = 0; particle < state.count; particle++) state.newborn[particle] = false
  }

  private flushPending(): void {
    // Spawn scripts kick no events, so one pass drains what the evolve pass queued.
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0)
      for (const spawn of batch) {
        const event = this.effect.events[spawn.eventSlot]
        if (event === undefined) continue
        for (const target of event.targetSlots) this.spawnInto(target, spawn)
      }
    }
    this.elements.length = 0
  }

  private spawnInto(slot: number, batch: PendingSpawn): void {
    const state = this.slots[slot]
    if (state === undefined) return
    const count = Math.min(batch.count, PK_MAX_PARTICLES_PER_SLOT - state.count)
    for (let index = 0; index < count; index++) {
      const particle = state.allocate()
      state.writeIdentity(particle, batch.parent)
      if (state.layer.spawn !== undefined) this.run(state.layer.spawn, state, particle, 0, batch, index, count)
      if (state.layer.evolveOnSpawn !== undefined) this.run(state.layer.evolveOnSpawn, state, particle, 0, batch, index, count)
    }
  }

  private plan(script: PkScript, state: PkLayerState): ScriptPlan {
    const known = this.plans.get(script)
    if (known !== undefined) return known
    const layer = state.layer
    const slot = this.effect.slots[state.slot]!
    const externals = script.externals.map(({ name, type }): Bind => {
      const field = layer.fields.findIndex(item => item.name === name)
      if (field >= 0) return { kind: 'field', index: field }
      if (name === 'scene.dt') return { kind: 'scene-dt' }
      if (name === 'scene.time') return { kind: 'scene-time' }
      if (type.startsWith('pCtx') || type === 'RandCtx' || type === 'SceneCtx') return { kind: 'pointer' }
      if (type.startsWith('sampler')) {
        const sampler = layer.samplers.findIndex(item => item.name === name)
        return sampler >= 0 ? { kind: 'sampler', index: sampler } : { kind: 'zero' }
      }
      const spatialIndex = /^__spatialLayer_(\d+)$/u.exec(name)?.[1]
      if (type === 'SpatialLayerType' && spatialIndex !== undefined) {
        const table = layer.spatialLayers[Number(spatialIndex)]
        if (table !== undefined) {
          if (!this.spatial.has(table)) this.spatial.set(table, { current: [], previous: [] })
          let index = this.spatialNames.indexOf(table)
          if (index < 0) index = this.spatialNames.push(table) - 1
          return { kind: 'spatial', index }
        }
      }
      if (type === 'particleEvent') {
        const event = slot.outputEvents.find(index => this.effect.events[index]?.name === name)
        return { kind: 'event', index: event ?? -1 }
      }
      if (name.startsWith('__a_')) {
        if (name === '__a_Game.EmissionRateMultiplier') return { kind: 'emission' }
        if (name === '__a_Game.ColorMultiplier') return { kind: 'color' }
        if (name === '__a_Game.TeamColor') return { kind: 'team-color' }
        if (name === '__a_Game.TargetPosition') return { kind: 'target' }
        // other attributes: a position or a wind is none, a multiplier is one
        return /Position|Center|Wind/u.test(name) ? { kind: 'zero' } : { kind: 'one' }
      }
      this.unsupported.add(`external ${name} (${type})`)
      return { kind: 'zero' }
    })
    const calls = script.code.map((instruction): Fn => {
      if (instruction.op !== PK_OP.call) return null
      const name = script.functions[instruction.slot] ?? ''
      const objectType = instruction.self !== 0xffff ? (script.externals[instruction.self]?.type ?? '') : ''
      const fn = functionOf(name, objectType)
      if (fn === 'zero') this.unsupported.add(`function ${objectType === '' ? '' : `${objectType}.`}${name}`)
      return fn
    })
    const registers: [Lanes[], Lanes[], Lanes[]] = [0, 1, 2].map(space =>
      Array.from({ length: script.registers[space]! }, () => new Lanes()),
    ) as [Lanes[], Lanes[], Lanes[]]
    const constants = script.constants.map(constant => {
      const value = new Lanes()
      for (let lane = 0; lane < 4; lane++) value.w[lane] = constant[lane]! | 0
      return value
    })
    const created = { externals, calls, registers, constants }
    this.plans.set(script, created)
    return created
  }

  /**
   * An operand's value. Registers and constants are returned as they are, not copied: every
   * instruction makes a new value for its result and never writes into the ones it read.
   */
  private get(plan: ScriptPlan, operand: PkOperand | undefined): Lanes {
    if (operand === undefined) return ZERO
    if (operand.space === PK_SPACE.const) return plan.constants[operand.index] ?? ZERO
    if (operand.space >= 1 && operand.space <= 3) return plan.registers[operand.space - 1]![operand.index] ?? ZERO
    return ZERO
  }

  private set(plan: ScriptPlan, operand: PkOperand, value: Lanes): void {
    if (operand.space >= 1 && operand.space <= 3) {
      const registers = plan.registers[operand.space - 1]!
      if (operand.index < registers.length) registers[operand.index] = value
    }
  }

  private run(script: PkScript, state: PkLayerState, particle: number, dt: number, spawn: PendingSpawn | undefined, spawnIndex: number, spawnCount: number): void {
    const plan = this.plan(script, state)
    const environment = this.environment
    for (let pc = 0; pc < script.code.length; pc++) {
      const instruction = script.code[pc]!
      switch (instruction.op) {
        case PK_OP.load: {
          const bind = plan.externals[instruction.slot] ?? { kind: 'zero' }
          if (bind.kind === 'team-color') state.readsTeamColor = true
          const value =
            bind.kind === 'field'
              ? state.read(bind.index, particle)
              : bind.kind === 'scene-dt'
                ? Lanes.of(dt)
                : bind.kind === 'scene-time'
                  ? Lanes.of(environment.time)
                  : bind.kind === 'emission'
                    ? Lanes.of(environment.emissionRateMultiplier)
                    : bind.kind === 'color'
                      ? Lanes.of(...environment.colorMultiplier)
                      : bind.kind === 'team-color'
                        ? Lanes.of(...environment.teamColor)
                        : bind.kind === 'target'
                          ? Lanes.of(...environment.targetPosition)
                        : bind.kind === 'one'
                          ? Lanes.of(1, 1, 1, 1)
                          : new Lanes()
          this.set(plan, instruction.dst, value)
          break
        }
        case PK_OP.store: {
          const bind = plan.externals[instruction.slot]
          if (bind?.kind === 'field') state.write(bind.index, particle, this.get(plan, instruction.dst))
          break
        }
        case PK_OP.binary:
          this.set(plan, instruction.dst, binary(instruction.sub, this.get(plan, instruction.a), instruction.a!.kind, this.get(plan, instruction.b), instruction.dst))
          break
        case PK_OP.unary:
          this.set(plan, instruction.dst, unary(instruction.sub, this.get(plan, instruction.a), instruction.a!, instruction.dst))
          break
        case PK_OP.binary2:
          this.set(plan, instruction.dst, binary2(instruction.sub, this.get(plan, instruction.a), this.get(plan, instruction.b), instruction.a!, instruction.dst))
          break
        case PK_OP.ternary: {
          const a = this.get(plan, instruction.a)
          const b = this.get(plan, instruction.b)
          const t = this.get(plan, instruction.c)
          const out = new Lanes()
          for (let lane = 0; lane < pkLanes(instruction.dst.kind); lane++) {
            const weight = pkLanes(instruction.c!.kind) === 1 ? fromBits(t.w[0]!) : fromBits(t.w[lane]!)
            out.w[lane] = toBits(fromBits(a.w[lane]!) + (fromBits(b.w[lane]!) - fromBits(a.w[lane]!)) * weight)
          }
          this.set(plan, instruction.dst, out)
          break
        }
        case PK_OP.select: {
          const a = this.get(plan, instruction.a)
          const b = this.get(plan, instruction.b)
          const c = this.get(plan, instruction.c)
          const out = new Lanes()
          const scalar = pkLanes(instruction.c!.kind) === 1
          for (let lane = 0; lane < 4; lane++) out.w[lane] = (scalar ? c.w[0]! : c.w[lane]!) !== 0 ? b.w[lane]! : a.w[lane]!
          this.set(plan, instruction.dst, out)
          break
        }
        case PK_OP.swizzle: {
          const a = this.get(plan, instruction.a)
          const scalar = pkLanes(instruction.a!.kind) === 1
          const integer = isPkInt(instruction.dst.kind) || isPkBool(instruction.dst.kind)
          const out = new Lanes()
          for (let lane = 0; lane < pkLanes(instruction.dst.kind); lane++) {
            const code = pkLaneCode(instruction.swizzle, lane)
            if (code <= 3) out.w[lane] = a.w[scalar ? 0 : code]!
            else if (integer) out.w[lane] = code === 5 ? 1 : 0
            else out.w[lane] = toBits(code === 5 ? 1 : 0)
          }
          this.set(plan, instruction.dst, out)
          break
        }
        case PK_OP.vector: {
          const out = new Lanes()
          let lane = 0
          for (const component of instruction.components ?? []) {
            const value = this.get(plan, component)
            for (let index = 0; index < pkLanes(component.kind) && lane < 4; index++) out.w[lane++] = value.w[index]!
          }
          this.set(plan, instruction.dst, out)
          break
        }
        case PK_OP.castBits:
          this.set(plan, instruction.dst, this.get(plan, instruction.a))
          break
        case PK_OP.cast:
          this.set(plan, instruction.dst, cast(this.get(plan, instruction.a), instruction.a!.kind, instruction.dst.kind))
          break
        case PK_OP.call:
          this.call(script, plan, plan.calls[pc] ?? null, instruction, state, particle, spawn, spawnIndex, spawnCount)
          break
      }
    }
  }

  private call(
    script: PkScript,
    plan: ScriptPlan,
    fn: Fn,
    instruction: PkInstruction,
    state: PkLayerState,
    particle: number,
    spawn: PendingSpawn | undefined,
    spawnIndex: number,
    spawnCount: number,
  ): void {
    const arg = (index: number): Lanes => this.get(plan, instruction.args?.[index])
    const self = instruction.self === 0xffff ? undefined : plan.externals[instruction.self]
    const sampler = (): PkSampler | undefined => (self?.kind === 'sampler' ? state.layer.samplers[self.index] : undefined)
    const eventOf = (): number => (self?.kind === 'event' ? self.index : -1)
    const spatialOf = (): SpatialTable | undefined => (self?.kind === 'spatial' ? this.spatial.get(this.spatialNames[self.index] ?? '') : undefined)
    // The frame local space maps to: the parent particle's while a spawn carries one, else the effect's.
    let frame: readonly number[] | undefined
    const worldFrame = (): readonly number[] => (frame ??= this.spawnFrame(spawn, spawnIndex, spawnCount) ?? this.environment.localToWorld)
    let out = new Lanes()
    const argCount = instruction.args?.length ?? 0
    switch (fn) {
      case 'rand': {
        const low = arg(0)
        const high = arg(1)
        const lanes = Math.max(1, pkLanes(instruction.dst.kind))
        if (isPkInt(instruction.dst.kind))
          for (let lane = 0; lane < lanes; lane++) out.w[lane] = low.w[lane]! + Math.trunc((high.w[lane]! - low.w[lane]!) * this.random())
        else for (let lane = 0; lane < lanes; lane++) out.w[lane] = toBits(fromBits(low.w[lane]!) + (fromBits(high.w[lane]!) - fromBits(low.w[lane]!)) * this.random())
        break
      }
      case 'vrand': {
        let unit = randomUnit(this.random)
        if (argCount >= 3) {
          const a = fromBits(arg(0).w[0]!)
          const b = fromBits(arg(1).w[0]!)
          const scale = a + (b - a) * Math.cbrt(this.random())
          unit = [unit[0] * scale, unit[1] * scale, unit[2] * scale]
        }
        out = Lanes.of(...unit)
        break
      }
      case 'sample-position': {
        const shape = sampler()
        if (shape?.kind === 'shape') out = Lanes.of(...samplePkShape(shape.shape, this.random))
        break
      }
      case 'sample-normal': {
        const shape = sampler()
        const point: Vec3 = shape?.kind === 'shape' ? samplePkShape(shape.shape, this.random) : [0, 0, 1]
        out = Lanes.of(...unitOr(point, [0, 0, 1]))
        break
      }
      case 'sample-curve': {
        const curve = sampler()
        if (curve?.kind === 'curve') out = Lanes.of(...samplePkCurve(curve.curve, fromBits(arg(0).w[0]!)))
        break
      }
      case 'sample-turbulence': {
        const noise = sampler()
        const wavelength = noise?.kind === 'turbulence' && noise.wavelength > 1e-4 ? noise.wavelength : 1
        const strength = noise?.kind === 'turbulence' ? noise.strength : 1
        const [x, y, z] = arg(0).xyz().map(component => component / wavelength) as Vec3
        const t = this.environment.time
        // A cheap smooth noise stand-in, scaled by the sampler's own wavelength and strength.
        out = Lanes.of(
          strength * Math.sin(y * 1.7 + t * 0.9) * Math.cos(z * 1.3),
          strength * Math.sin(z * 1.9 + t * 0.7) * Math.cos(x * 1.1),
          strength * Math.sin(x * 1.5 + t * 0.8) * Math.cos(y * 1.6),
        )
        break
      }
      case 'xform-l2w-f':
        out = Lanes.of(...transformPoint(worldFrame(), arg(0).xyz()))
        break
      case 'xform-l2w-d':
        out = Lanes.of(...transformDirection(worldFrame(), arg(0).xyz()))
        break
      case 'xform-w2l-f':
        out = Lanes.of(...transformPoint(invertAffine(worldFrame()), arg(0).xyz()))
        break
      case 'xform-w2l-d':
        out = Lanes.of(...transformDirection(invertAffine(worldFrame()), arg(0).xyz()))
        break
      case 'xform-w2w':
        out = arg(0)
        break
      case 'rgb2hsv':
        out = rgbToHsvLanes(arg(0))
        break
      case 'hsv2rgb':
        out = hsvToRgbLanes(arg(0))
        break
      case 'radians-rotate': {
        const axis = arg(1).xyz()
        out = length(axis) > 1e-6 ? Lanes.of(...rotateVector(axisAngle(unitOr(axis, [0, 0, 1]), fromBits(arg(2).w[0]!)), arg(0).xyz())) : arg(0)
        break
      }
      case 'rotate': {
        const q = arg(1)
        out = Lanes.of(...rotateVector([fromBits(q.w[0]!), fromBits(q.w[1]!), fromBits(q.w[2]!), fromBits(q.w[3]!)], arg(0).xyz()))
        break
      }
      case 'axis-side':
      case 'axis-up':
      case 'axis-forward': {
        const q = arg(0)
        const axis: Vec3 = fn === 'axis-side' ? [1, 0, 0] : fn === 'axis-forward' ? [0, 1, 0] : [0, 0, 1]
        const quat: Quat = [fromBits(q.w[0]!), fromBits(q.w[1]!), fromBits(q.w[2]!), fromBits(q.w[3]!)]
        out = Lanes.of(...(Math.hypot(...quat) > 1e-6 ? rotateVector(normalizeQuat(quat), axis) : axis))
        break
      }
      case 'orientation-mult': {
        const a = arg(0)
        const b = arg(1)
        out = Lanes.of(...multiplyQuat([fromBits(a.w[0]!), fromBits(a.w[1]!), fromBits(a.w[2]!), fromBits(a.w[3]!)], [fromBits(b.w[0]!), fromBits(b.w[1]!), fromBits(b.w[2]!), fromBits(b.w[3]!)]))
        break
      }
      case 'effect-position':
        out = Lanes.of(worldFrame()[12]!, worldFrame()[13]!, worldFrame()[14]!)
        break
      case 'effect-axis-up':
        out = Lanes.of(...unitOr(transformDirection(worldFrame(), [0, 0, 1]), [0, 0, 1]))
        break
      case 'effect-axis-side':
        out = Lanes.of(...unitOr(transformDirection(worldFrame(), [1, 0, 0]), [0, 0, 1]))
        break
      case 'effect-axis-forward':
        out = Lanes.of(...unitOr(transformDirection(worldFrame(), [0, 1, 0]), [0, 0, 1]))
        break
      case 'effect-age':
        out = Lanes.of(this.age)
        break
      case 'effect-running':
        out.w[0] = this.environment.running ? -1 : 0
        break
      case 'scene-orientation':
        out = pkLanes(instruction.dst.kind) >= 4 ? Lanes.of(0, 0, 0, 1) : Lanes.of(0, 0, 1)
        break
      case 'view-position':
        out = Lanes.of(...this.environment.cameraPosition)
        break
      case 'view-distance': {
        const p = arg(0).xyz()
        const c = this.environment.cameraPosition
        out = Lanes.of(Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]))
        break
      }
      case 'kill':
        if (arg(0).w[0] !== 0) state.killed[particle] = true
        return
      case 'generate': {
        // generate(state, amount, step): one particle per `step` of accumulated amount; the state
        // keeps the fraction left over (seeded at 0.99999, so the first comes on the first frame).
        const accumulated = arg(0)
        let step = fromBits(arg(2).w[0]!)
        if (!(step > 1e-6)) step = 1
        let total = fromBits(accumulated.w[0]!) + fromBits(arg(1).w[0]!) / step
        if (!Number.isFinite(total)) total = 0
        const count = Math.floor(Math.max(total, 0))
        out = Lanes.of(total - count, fromBits(accumulated.w[1]!) + count, count)
        break
      }
      case 'event-stream-generate': {
        const done = Math.max(0, Math.trunc(fromBits(arg(0).w[0]!)))
        const age = fromBits(arg(2).w[0]!)
        const stream = sampler()
        const times = stream?.kind === 'event-stream' ? stream.times : []
        let fire = 0
        while (done + fire < times.length && times[done + fire]! <= age + 1e-6) fire++
        out = Lanes.of(done + fire, 0, fire)
        break
      }
      case 'event-stream-duration': {
        const stream = sampler()
        const times = stream?.kind === 'event-stream' ? stream.times : []
        out = Lanes.of(times.length === 0 ? 0 : Math.max(...times))
        break
      }
      case 'trigger':
        out = Lanes.of(0, 0, arg(0).w[0] !== 0 ? Math.max(1, fromBits(arg(1).w[0]!)) : 0)
        break
      case 'init-payload': {
        const generated = arg(1)
        const count = Math.max(0, Math.min(Math.trunc(fromBits(generated.w[2]!)), PK_MAX_PARTICLES_PER_SLOT))
        const event = eventOf()
        const name = this.effect.events[event]?.name ?? ''
        this.pending.push({
          eventSlot: event,
          parent: state.identity(particle),
          count,
          firstIndex: Math.max(0, Math.trunc(fromBits(generated.w[1]!) - fromBits(generated.w[2]!))),
          names: state.layer.outputPayloads[name] ?? [],
          elements: new Map(),
        })
        out.w[0] = this.pending.length // 1-based handle
        break
      }
      case 'build-payload-element': {
        const generated = arg(0)
        this.elements.push({ from: arg(1), to: arg(2), flags: arg(3).w[0]!, baseIndex: Math.max(0, Math.trunc(fromBits(generated.w[1]!) - fromBits(generated.w[2]!))) })
        out.w[0] = this.elements.length
        break
      }
      case 'append-payload': {
        const handle = arg(0).w[0]! - 1
        const index = arg(1).w[0]!
        const element = arg(2).w[0]! - 1
        const pending = this.pending[handle]
        if (pending !== undefined) pending.elements.set(pending.names[index] ?? `#${String(index)}`, element)
        out = arg(0)
        break
      }
      case 'kick': {
        const pending = this.pending[arg(0).w[0]! - 1]
        if (pending !== undefined && pending.count <= 0) pending.eventSlot = -1
        return
      }
      case 'extract-f':
      case 'extract-i':
      case 'extract-o': {
        const index = arg(0).w[0]!
        const name = state.layer.inputPayloads[index] ?? `#${String(index)}`
        const element = spawn === undefined ? undefined : this.elements[spawn.elements.get(name) ?? -1]
        if (element !== undefined) {
          if (fn === 'extract-i') out.w[0] = element.baseIndex + spawnIndex
          else {
            const t = spawnCount > 1 ? (spawnIndex + 1) / spawnCount : 1
            for (let lane = 0; lane < 4; lane++) out.w[lane] = toBits(fromBits(element.from.w[lane]!) + (fromBits(element.to.w[lane]!) - fromBits(element.from.w[lane]!)) * t)
          }
        } else if (fn === 'extract-o') out = Lanes.of(0, 0, 0, 1)
        break
      }
      case 'false':
        out.w[0] = 0
        break
      case 'spatial-allocate':
        this.spatialPending.push([new Lanes(), new Lanes(), new Lanes(), new Lanes()])
        out.w[0] = this.spatialPending.length
        break
      case 'spatial-append': {
        // appendPayload(handle, value, index)
        const values = this.spatialPending[arg(0).w[0]! - 1]
        const index = arg(2).w[0]!
        if (values !== undefined && index >= 0 && index < 4) values[index] = arg(1)
        out = arg(0)
        break
      }
      case 'spatial-insert': {
        const values = this.spatialPending[arg(0).w[0]! - 1]
        const table = spatialOf()
        if (values !== undefined && table !== undefined) table.current.push({ key: arg(1).xyz(), values })
        return
      }
      case 'spatial-closest': {
        // closestF3(key, radius, payloadIndex): the value published under the nearest key.
        const key = arg(0).xyz()
        const index = Math.min(3, Math.max(0, arg(2).w[0]!))
        const table = spatialOf()
        if (table !== undefined)
          for (const list of [table.current, table.previous]) {
            let best = Infinity
            for (const entry of list) {
              const distance = (entry.key[0] - key[0]) ** 2 + (entry.key[1] - key[1]) ** 2 + (entry.key[2] - key[2]) ** 2
              if (distance < best) {
                best = distance
                out = entry.values[index]!.copy()
              }
            }
            if (best < Infinity) break
          }
        break
      }
      default:
        out = new Lanes()
    }
    if (instruction.dst.space !== PK_SPACE.none) this.set(plan, instruction.dst, out)
  }

  /**
   * While a spawn script runs for an event carrying a `Position` payload (and an `Orientation`), the
   * effect's frame is the parent particle's: Lightning Shield's sparks sample their shape around the
   * orb that fired them.
   */
  private spawnFrame(spawn: PendingSpawn | undefined, index: number, count: number): number[] | undefined {
    if (spawn === undefined) return undefined
    const position = this.elements[spawn.elements.get('Position') ?? -1]
    if (position === undefined) return undefined
    const t = count > 1 ? (index + 1) / count : 1
    const p = [0, 1, 2].map(lane => fromBits(position.from.w[lane]!) + (fromBits(position.to.w[lane]!) - fromBits(position.from.w[lane]!)) * t) as Vec3
    let q: Quat = [0, 0, 0, 1]
    const orientation = this.elements[spawn.elements.get('Orientation') ?? -1]
    if (orientation !== undefined) {
      const raw: Quat = [fromBits(orientation.to.w[0]!), fromBits(orientation.to.w[1]!), fromBits(orientation.to.w[2]!), fromBits(orientation.to.w[3]!)]
      if (Math.hypot(...raw) > 1e-4) q = normalizeQuat(raw)
    }
    const x = rotateVector(q, [1, 0, 0])
    const y = rotateVector(q, [0, 1, 0])
    const z = rotateVector(q, [0, 0, 1])
    return [...x, 0, ...y, 0, ...z, 0, ...p, 1]
  }
}

function binary(sub: number, a: Lanes, aKind: number, b: Lanes, dst: PkOperand): Lanes {
  const out = new Lanes()
  const lanes = Math.min(4, Math.max(pkLanes(dst.kind), pkLanes(aKind)))
  const integer = isPkInt(aKind) || isPkBool(aKind)
  for (let lane = 0; lane < lanes; lane++) {
    if (integer) {
      const x = a.w[lane]!
      const y = b.w[lane]!
      const mask = (value: boolean) => (value ? -1 : 0)
      out.w[lane] = (
        sub === 0x00 ? x + y
        : sub === 0x01 ? x - y
        : sub === 0x02 ? Math.imul(x, y)
        : sub === 0x03 ? (y !== 0 ? Math.trunc(x / y) : 0)
        : sub === 0x04 ? (y !== 0 ? x % y : 0)
        : sub === 0x05 ? -x
        : sub === 0x08 ? x & y
        : sub === 0x09 ? x | y
        : sub === 0x0b ? ~x
        : sub === 0x0c ? mask(x < y)
        : sub === 0x0d ? mask(x <= y)
        : sub === 0x0e ? mask(x > y)
        : sub === 0x0f ? mask(x >= y)
        : sub === 0x10 ? mask(x === y)
        : sub === 0x11 ? mask(x !== y)
        : 0
      ) | 0
      continue
    }
    const x = fromBits(a.w[lane]!)
    const y = fromBits(b.w[lane]!)
    switch (sub) {
      case 0x00: out.w[lane] = toBits(x + y); break
      case 0x01: out.w[lane] = toBits(x - y); break
      case 0x02: out.w[lane] = toBits(x * y); break
      case 0x03: out.w[lane] = toBits(x / y); break
      case 0x04: out.w[lane] = toBits(y !== 0 ? x % y : 0); break
      case 0x05: out.w[lane] = toBits(-x); break
      case 0x0c: out.w[lane] = x < y ? -1 : 0; break
      case 0x0d: out.w[lane] = x <= y ? -1 : 0; break
      case 0x0e: out.w[lane] = x > y ? -1 : 0; break
      case 0x0f: out.w[lane] = x >= y ? -1 : 0; break
      case 0x10: out.w[lane] = x === y ? -1 : 0; break
      case 0x11: out.w[lane] = x !== y ? -1 : 0; break
      default: out.w[lane] = toBits(0)
    }
  }
  return out
}

function unary(sub: number, a: Lanes, source: PkOperand, dst: PkOperand): Lanes {
  const out = new Lanes()
  switch (sub) {
    case 0x07: // angle → (sin, cos)
      return Lanes.of(Math.sin(fromBits(a.w[0]!)), Math.cos(fromBits(a.w[0]!)))
    case 0x24: { // float3 normalize
      const v = a.xyz()
      const size = length(v)
      return size > 1e-12 ? Lanes.of(v[0] / size, v[1] / size, v[2] / size) : out
    }
    case 0x31: { // any lane set
      let any = false
      for (let lane = 0; lane < pkLanes(source.kind); lane++) any ||= a.w[lane] !== 0
      out.w[0] = any ? -1 : 0
      return out
    }
    case 0x33: // lane is non-zero
      for (let lane = 0; lane < pkLanes(dst.kind); lane++) out.w[lane] = fromBits(a.w[lane]!) !== 0 && Number.isFinite(fromBits(a.w[lane]!)) ? -1 : 0
      return out
  }
  for (let lane = 0; lane < Math.min(4, Math.max(pkLanes(dst.kind), pkLanes(source.kind))); lane++) {
    const x = fromBits(a.w[lane]!)
    out.w[lane] = toBits(
      sub === 0x00 ? Math.sqrt(Math.max(x, 0))
      : sub === 0x01 ? (x > 0 ? 1 / Math.sqrt(x) : 0)
      : sub === 0x0d || sub === 0x2c ? Math.exp(x)
      : sub === 0x11 ? 1 / x
      : sub === 0x12 ? Math.abs(x)
      : sub === 0x13 ? Math.sign(x)
      // An ever-growing age into a curve sample only makes sense as a wrap (the hero glow's pulse).
      : sub === 0x16 || sub === 0x17 ? x - Math.floor(x)
      : sub === 0x18 ? Math.min(1, Math.max(0, x))
      : x,
    )
  }
  return out
}

function binary2(sub: number, a: Lanes, b: Lanes, aOperand: PkOperand, dst: PkOperand): Lanes {
  if (sub === 0x1d) {
    let dot = 0
    for (let lane = 0; lane < pkLanes(aOperand.kind); lane++) dot += fromBits(a.w[lane]!) * fromBits(b.w[lane]!)
    return Lanes.of(dot)
  }
  if (sub === 0x1e) {
    const [ax, ay, az] = a.xyz()
    const [bx, by, bz] = b.xyz()
    return Lanes.of(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx)
  }
  const out = new Lanes()
  const integer = isPkInt(aOperand.kind)
  for (let lane = 0; lane < pkLanes(dst.kind); lane++) {
    if (integer) {
      const x = a.w[lane]!
      const y = b.w[lane]!
      out.w[lane] = sub === 0x1b ? Math.min(x, y) : sub === 0x1c ? Math.max(x, y) : x
    } else {
      const x = fromBits(a.w[lane]!)
      const y = fromBits(b.w[lane]!)
      out.w[lane] = toBits(sub === 0x19 ? Math.max(x, 0) ** y : sub === 0x1b ? Math.min(x, y) : sub === 0x1c ? Math.max(x, y) : x)
    }
  }
  return out
}

function cast(a: Lanes, from: number, to: number): Lanes {
  const out = new Lanes()
  for (let lane = 0; lane < pkLanes(to); lane++) {
    if (isPkBool(from)) {
      const value = (pkLanes(from) === 1 ? a.w[0]! : a.w[lane]!) !== 0
      if (isPkInt(to)) out.w[lane] = value ? 1 : 0
      else if (isPkBool(to)) out.w[lane] = value ? -1 : 0
      else out.w[lane] = toBits(value ? 1 : 0)
    } else if (isPkInt(from)) {
      if (isPkInt(to)) out.w[lane] = a.w[lane]!
      else if (isPkBool(to)) out.w[lane] = a.w[lane] !== 0 ? -1 : 0
      else out.w[lane] = toBits(a.w[lane]!)
    } else if (isPkInt(to)) out.w[lane] = Math.trunc(fromBits(a.w[lane]!))
    else if (isPkBool(to)) out.w[lane] = fromBits(a.w[lane]!) !== 0 ? -1 : 0
    else out.w[lane] = toBits(fromBits(a.w[lane]!))
  }
  return out
}

/** RGB → HSV, hue 0..1, alpha kept (PopcornFX's `rgb2hsv`), by codec-kit's conversion. */
function rgbToHsvLanes(c: Lanes): Lanes {
  const [h, s, v] = rgbToHsv([fromBits(c.w[0]!), fromBits(c.w[1]!), fromBits(c.w[2]!)])
  return Lanes.of(h, s, v, fromBits(c.w[3]!))
}

/** HSV → RGB, hue wrapped, saturation clamped, alpha kept (PopcornFX's `hsv2rgb`). */
function hsvToRgbLanes(c: Lanes): Lanes {
  const [r, g, b] = hsvToRgb(fromBits(c.w[0]!), Math.min(1, Math.max(0, fromBits(c.w[1]!))), fromBits(c.w[2]!))
  return Lanes.of(r, g, b, fromBits(c.w[3]!))
}
