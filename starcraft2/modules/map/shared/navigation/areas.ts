/** Connected strategic territories, seeded by bases and passage approaches, bounded by ground radius. */
import {
  centreOf,
  clearanceField,
  distanceField,
  inside,
  type GridSize,
  type Point,
} from './grid.js'

export interface NavigationArea {
  readonly id: string
  readonly regionId: string
  readonly center: Point
  readonly cellCount: number
  /** Maximum ground distance from the seed, not a Euclidean circle through obstacles. */
  readonly radius: number
  readonly expansionId?: string
}

export interface AreaSeed {
  readonly cell: number
  readonly expansionId?: string
}

export interface AreaOptions {
  readonly maxRadius: number
  /** Protected base surroundings: other seeds cannot subdivide this ground neighbourhood. */
  readonly resourceRadius: number
}

export function partitionNavigationAreas(
  size: GridSize,
  components: Int32Array,
  regionIds: readonly string[],
  inputSeeds: readonly AreaSeed[],
  options: AreaOptions,
  legalStep?: (from: number, to: number) => boolean,
): { areas: NavigationArea[]; labels: Int32Array; runs: number[] } {
  if (
    !Number.isFinite(options.maxRadius) ||
    options.maxRadius <= 0 ||
    !Number.isFinite(options.resourceRadius) ||
    options.resourceRadius < 0 ||
    options.resourceRadius > options.maxRadius
  )
    throw new RangeError(
      'Area radius must be finite and positive; resource radius must be within it',
    )
  const mask = Uint8Array.from(components, label => (label > 0 ? 1 : 0))
  const canStep = (a: number, b: number) =>
    components[a] === components[b] && (legalStep?.(a, b) ?? true)
  const clearance = clearanceField(size, mask)
  const seeds: AreaSeed[] = []
  const used = new Set<number>()
  const add = (seed: AreaSeed) => {
    if (mask[seed.cell] !== 1 || used.has(seed.cell)) return
    used.add(seed.cell)
    seeds.push(seed)
  }
  for (const seed of inputSeeds) if (seed.expansionId !== undefined) add(seed)
  const protectedOwners = new Int32Array(mask.length)
  if (seeds.length > 0) {
    const owners = new Int32Array(mask.length)
    const distance = distanceField(
      size,
      mask,
      seeds.map(seed => seed.cell),
      options.resourceRadius,
      undefined,
      { owners },
      canStep,
    )
    for (let cell = 0; cell < mask.length; cell += 1)
      if (distance[cell]! <= options.resourceRadius) protectedOwners[cell] = owners[cell]!
  }
  for (const seed of inputSeeds)
    if (seed.expansionId === undefined && protectedOwners[seed.cell] === 0) add(seed)
  const seededComponents = new Set(seeds.map(seed => components[seed.cell]!))
  const componentCenters = new Map<number, { x: number; y: number; count: number }>()
  for (let cell = 0; cell < mask.length; cell += 1) {
    const label = components[cell]!
    if (label === 0) continue
    const sum = componentCenters.get(label) ?? { x: 0, y: 0, count: 0 }
    const point = centreOf(size, cell)
    sum.x += point[0]
    sum.y += point[1]
    sum.count += 1
    componentCenters.set(label, sum)
  }
  const componentSeeds = new Map<number, number>()
  for (let cell = 0; cell < mask.length; cell += 1)
    if (components[cell]! > 0 && !seededComponents.has(components[cell]!)) {
      const label = components[cell]!,
        sum = componentCenters.get(label)!
      const score = (at: number) => {
        const point = centreOf(size, at)
        return (
          (clearance[at]! >= 2 ? 0 : 1000000) +
          Math.hypot(point[0] - sum.x / sum.count, point[1] - sum.y / sum.count)
        )
      }
      const current = componentSeeds.get(label)
      if (current === undefined || score(cell) < score(current)) componentSeeds.set(label, cell)
    }
  for (const cell of componentSeeds.values()) add({ cell })
  let labels: Int32Array
  let distance: Float64Array
  // Farthest-point coverage supplies additional territories in large open ground. Each source
  // owns a shortest-path tree, so an area never becomes a disconnected collection of cells.
  for (;;) {
    labels = new Int32Array(mask.length)
    distance = distanceField(
      size,
      mask,
      seeds.map(seed => seed.cell),
      Infinity,
      undefined,
      { owners: labels, protected: protectedOwners },
      canStep,
    )
    let farthest = -1,
      radius = options.maxRadius
    for (let cell = 0; cell < mask.length; cell += 1)
      if (mask[cell] === 1 && distance[cell]! > radius) {
        farthest = cell
        radius = distance[cell]!
      }
    if (farthest < 0) break
    // Place new centres on nearby roomy ground, rather than exactly on a cliff-tip extremum.
    const nearby = distanceField(size, mask, [farthest], 3, undefined, undefined, canStep)
    let selected = farthest
    const x = farthest % size.width,
      y = Math.floor(farthest / size.width)
    const score = (cell: number) => Math.min(3, clearance[cell]!) - nearby[cell]! * 0.15
    for (let dy = -3; dy <= 3; dy += 1)
      for (let dx = -3; dx <= 3; dx += 1) {
        if (!inside(size, x + dx, y + dy)) continue
        const cell = (y + dy) * size.width + x + dx
        if (
          nearby[cell]! <= 3 &&
          protectedOwners[cell] === 0 &&
          !used.has(cell) &&
          score(cell) > score(selected)
        )
          selected = cell
      }
    add({ cell: selected })
  }
  const counts = new Int32Array(seeds.length)
  const radii = new Float64Array(seeds.length)
  const runs: number[] = []
  for (let cell = 0; cell < labels.length; cell += 1) {
    const owner = labels[cell]! - 1
    if (owner < 0) continue
    counts[owner] = counts[owner]! + 1
    radii[owner] = Math.max(radii[owner]!, distance[cell]!)
  }
  for (let cell = 0; cell < labels.length;) {
    const owner = labels[cell]!
    let end = cell + 1
    while (end < labels.length && end % size.width !== 0 && labels[end] === owner) end += 1
    if (owner > 0) runs.push(cell, end - cell, owner)
    cell = end
  }
  return {
    labels,
    runs,
    areas: seeds.map((seed, index) => ({
      id: `A${index + 1}`,
      regionId: regionIds[components[seed.cell]! - 1]!,
      center: centreOf(size, seed.cell),
      cellCount: counts[index]!,
      radius: Math.round(radii[index]! * 100) / 100,
      ...(seed.expansionId === undefined ? {} : { expansionId: seed.expansionId }),
    })),
  }
}
