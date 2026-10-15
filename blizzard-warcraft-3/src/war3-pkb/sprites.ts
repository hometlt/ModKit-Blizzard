/**
 * What a running PopcornFX effect draws: the sprites of each billboard (and distortion) renderer,
 * read off the particle fields its inputs name.
 *
 * Owner: GAME-WARCRAFT3. Over `runtime.ts`. PopcornFX sizes are radii; a sprite keeps its half
 * extents. Positions, sizes and axes stay in the simulation's metres here; the caller scales them
 * (`PKB_UNITS_PER_METRE`). A particle whose `Enabled` input is off, or whose colour has no alpha
 * (outside additive-no-alpha), or whose size is none, draws nothing. A ribbon's sprites are the
 * points of its strips (ribbonPoints): the particles of one ribbon share a `ParentID` and follow each
 * other by `SelfID`. Light renderers draw nothing.
 */
import type { PkRenderer } from './effect.js'
import type { PkEffectInstance, PkLayerState } from './runtime.js'

export interface PkSprite {
  readonly position: readonly [number, number, number]
  /** Half extents across and along the card. */
  readonly halfSize: readonly [number, number]
  /** Axis-aligned modes: the full axis vector. Plane-aligned: the in-plane up vector. */
  readonly axis: readonly [number, number, number]
  /** Plane-aligned: the card's normal. */
  readonly normal: readonly [number, number, number]
  /** Rotation in the card's plane, radians. */
  readonly rotation: number
  readonly color: readonly [number, number, number, number]
  /** The atlas cell (`TextureID`). */
  readonly frame: number
}

export interface PkSpriteBatch {
  /** The layer's index in the effect, and the renderer's index in the layer. */
  readonly layer: number
  readonly renderer: number
  readonly definition: PkRenderer
  readonly sprites: PkSprite[]
}

/** Every billboard, distortion and ribbon renderer's sprites in `instance` now, appended to `batches` by (layer, renderer). */
export function collectPkSprites(instance: PkEffectInstance, batches: Map<string, PkSpriteBatch>): void {
  for (const state of instance.slots) {
    if (state === undefined || state.count === 0) continue
    const layerIndex = instance.effect.layers.indexOf(state.layer)
    state.layer.renderers.forEach((renderer, rendererIndex) => {
      if (renderer.kind !== 'billboard' && renderer.kind !== 'distortion' && renderer.kind !== 'ribbon') return
      const key = `${String(layerIndex)}:${String(rendererIndex)}`
      let batch = batches.get(key)
      if (batch === undefined) batches.set(key, (batch = { layer: layerIndex, renderer: rendererIndex, definition: renderer, sprites: [] }))
      const input = (name: string) => renderer.inputs[name] ?? -1
      const position = input('Position')
      const size = input('Size')
      const size2 = input('Size2')
      const axis = input('Axis')
      const normal = input('NormalAxis')
      const rotation = input('Rotation')
      const color = input('Color')
      const enabled = input('Enabled')
      const texture = input('TextureID')
      const lanes = (field: number, particle: number, fallback: readonly number[]) =>
        field < 0 ? fallback : [0, 1, 2, 3].map(lane => state.floatField(field, particle, lane))
      if (renderer.kind === 'ribbon') {
        ribbonPoints(state, renderer, batch.sprites, lanes)
        return
      }
      for (let particle = 0; particle < state.count; particle++) {
        if (enabled >= 0 && state.fields[enabled]![particle * 4] === 0) continue
        let tint = lanes(color, particle, [1, 1, 1, 1])
        if (renderer.kind === 'distortion') tint = [1, 1, 1, 0.15]
        if (tint[3]! <= 0.002 && renderer.blend !== 'additive-no-alpha') continue
        let half: [number, number]
        if (renderer.size2d && size2 >= 0) half = [state.floatField(size2, particle, 0), state.floatField(size2, particle, 1)]
        else {
          const radius = size >= 0 ? state.floatField(size, particle) : 1
          half = [radius, radius]
        }
        if (!(half[0] > 0) && !(half[1] > 0)) continue
        const p = lanes(position, particle, [0, 0, 0])
        const a = lanes(axis, particle, [0, 0, 1])
        const n = lanes(normal, particle, [0, 0, 1])
        batch.sprites.push({
          position: [p[0]!, p[1]!, p[2]!],
          halfSize: half,
          axis: [a[0]!, a[1]!, a[2]!],
          normal: [n[0]!, n[1]!, n[2]!],
          rotation: rotation < 0 ? 0 : (state.floatField(rotation, particle) * Math.PI) / 180,
          color: [tint[0]!, tint[1]!, tint[2]!, tint[3]!],
          frame: texture < 0 ? 0 : Math.max(0, Math.trunc(state.floatField(texture, particle))),
        })
      }
    })
  }
}

/**
 * A ribbon renderer's points (SPEC_UVM §13.4 ribbon batches): particles grouped by `ParentID`, each
 * group ordered by `SelfID` (their 32 bits compared as stored — the same order for ints and positive
 * floats) and numbered as one strip in `axis` x; a point keeps its position, its size as the half
 * width and its `TextureU` as `rotation`. The consumer joins a strip's points into a strip.
 */
function ribbonPoints(
  state: PkLayerState,
  renderer: PkRenderer,
  out: PkSprite[],
  lanes: (field: number, particle: number, fallback: readonly number[]) => readonly number[],
): void {
  const input = (name: string) => renderer.inputs[name] ?? -1
  const position = input('Position'),
    size = input('Size'),
    color = input('Color'),
    enabled = input('Enabled'),
    texture = input('TextureID'),
    self = input('SelfID'),
    parent = input('ParentID')
  if (position < 0) return
  const ribbons = new Map<number, number[]>()
  for (let particle = 0; particle < state.count; particle++) {
    if (enabled >= 0 && state.fields[enabled]![particle * 4] === 0) continue
    const key = parent < 0 ? 0 : state.fields[parent]![particle * 4]!
    let list = ribbons.get(key)
    if (list === undefined) ribbons.set(key, (list = []))
    list.push(particle)
  }
  const order = (particle: number) => (self < 0 ? particle : state.fields[self]![particle * 4]!)
  const textureU = input('TextureU')
  let strip = 0
  for (const list of ribbons.values()) {
    if (list.length < 2) continue
    list.sort((a, b) => order(a) - order(b))
    for (const particle of list) {
      const p = lanes(position, particle, [0, 0, 0])
      const tint = lanes(color, particle, [1, 1, 1, 1])
      out.push({
        position: [p[0]!, p[1]!, p[2]!],
        halfSize: [size < 0 ? 1 : state.floatField(size, particle), 0],
        axis: [strip, 0, 0],
        normal: [0, 0, 1],
        rotation: textureU < 0 ? 0 : state.floatField(textureU, particle),
        color: [tint[0]!, tint[1]!, tint[2]!, tint[3]!],
        frame: texture < 0 ? 0 : Math.max(0, Math.trunc(state.floatField(texture, particle))),
      })
    }
    strip++
  }
}
