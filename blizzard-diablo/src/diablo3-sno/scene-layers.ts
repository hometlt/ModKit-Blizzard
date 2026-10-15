/**
 * A scene's navigation mesh as the common map-layer grids (`map.layers`, `map.layer-read` of
 * `@modkit/sdk/maps`): the height and the flags of each navigation square.
 *
 * The mesh is the `NavMeshDef` member of the scene root: the square counts across and down, then
 * the squares ({ float height, int flags }) with x running fastest. Rows are laid out as the map
 * panel expects — row 0 at the north edge, taken as the scene's largest y. Heights are floats, so
 * the layer states them to 1/100 of a world unit above the scene's lowest square; flags are the
 * game's bits as stored (their meanings are not in the data). SNO files are not written, so the
 * layers are read-only.
 */
import { mapLayerWindow, type MapLayerDescriptor, type MapLayerGrid, type MapLayerReadRequest } from '@modkit/sdk/maps'
import type { SnoValue } from './decode.js'

export interface Square {
  readonly height: number
  readonly flags: number
}

export interface NavigationMesh {
  readonly width: number
  readonly rows: number
  /** World units along a square's side. */
  readonly squareSize: number
  readonly squares: readonly Square[]
}

/** The navigation mesh of a decoded scene root, if it holds a complete one. */
export function navigationMesh(root: SnoValue): NavigationMesh | undefined {
  if (root.kind !== 'structure') return undefined
  const mesh = root.members.find(member => member.value.kind === 'structure' && member.value.type === 'NavMeshDef')?.value
  if (mesh?.kind !== 'structure') return undefined
  const ints = mesh.members.filter(member => member.value.kind === 'number' && member.value.type === 'DT_INT')
  const width = ints[0]?.value.kind === 'number' ? ints[0].value.value : 0
  const rows = ints[1]?.value.kind === 'number' ? ints[1].value.value : 0
  const size = mesh.members.find(member => member.value.kind === 'number' && member.value.type === 'DT_FLOAT')?.value
  // client files store the side as 0; the game's squares are 2.5 units (96 of them span a 240-unit scene)
  const squareSize = size?.kind === 'number' && size.value > 0 ? size.value : 2.5
  const array = mesh.members.find(member => member.value.kind === 'array' && member.value.element === 'NavMeshSquare')?.value
  if (array?.kind !== 'array' || width <= 0 || rows <= 0 || array.items.length !== width * rows) return undefined
  const squares = array.items.map(item => {
    const values = item.kind === 'structure' ? item.members.map(member => member.value) : []
    const height = values.find(value => value.kind === 'number' && value.type === 'DT_FLOAT')
    const flags = values.find(value => value.kind === 'number' && value.type === 'DT_INT')
    return { height: height?.kind === 'number' ? height.value : 0, flags: flags?.kind === 'number' ? flags.value : 0 }
  })
  return { width, rows, squareSize, squares }
}

export interface SceneLayers {
  readonly layers: readonly MapLayerDescriptor[]
  read(input: unknown): MapLayerGrid
}

export function sceneLayers(root: SnoValue): SceneLayers | undefined {
  const mesh = navigationMesh(root)
  if (mesh === undefined) return undefined
  const lowest = Math.min(...mesh.squares.map(square => square.height))
  const highest = Math.max(...mesh.squares.map(square => square.height))
  const step = Math.max(0.01, (highest - lowest) / 65535)
  const base = Math.floor(lowest * 100) / 100
  const heightSample = (square: Square) => Math.min(65535, Math.max(0, Math.round((square.height - base) / step)))
  const maximumFlags = Math.max(...mesh.squares.map(square => square.flags >>> 0))
  const layers: MapLayerDescriptor[] = [
    {
      id: 'height',
      label: 'Navigation height',
      meaning: 'height',
      width: mesh.width,
      height: mesh.rows,
      minimum: 0,
      maximum: 65535,
      editable: false,
      valueScale: step,
      valueOffset: base,
      unit: 'diablo3-world-unit',
      sampling: 'cell',
    },
  ]
  // flags wider than a 16-bit sample cannot be shown as a layer
  if (maximumFlags <= 65535)
    layers.push({ id: 'flags', label: 'Navigation flags', meaning: 'flags', width: mesh.width, height: mesh.rows, minimum: 0, maximum: 65535, editable: false, sampling: 'cell' })
  return {
    layers,
    read(input: unknown): MapLayerGrid {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('map.layer-read request must be an object')
      const request = input as MapLayerReadRequest
      const layer = layers.find(item => item.id === request.layer)
      if (layer === undefined) throw new RangeError(`the scene has no layer «${String(request.layer)}»`)
      const window = mapLayerWindow(layer, request)
      const values: number[] = []
      for (let row = window.y; row < window.y + window.height; row += 1)
        for (let x = window.x; x < window.x + window.width; x += 1) {
          const square = mesh.squares[(mesh.rows - 1 - row) * mesh.width + x]!
          values.push(layer.id === 'height' ? heightSample(square) : square.flags >>> 0)
        }
      return {
        layer: layer.id,
        ...(request.x === undefined ? {} : { x: window.x, y: window.y }),
        width: window.width,
        height: window.height,
        values,
      }
    },
  }
}

