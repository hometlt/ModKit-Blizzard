/** Refine movement only; expansion placement and strategic area detection keep their source grid. */
import { centreOf, clearanceField, descend, distanceField, inside, type Point } from './grid.js'
import type { AreaConnection, NavigationEdge, NavigationNode } from './analyze.js'
import type { MapSpatialData } from './spatial.js'

export function refineGroundNavigation(
  data: MapSpatialData,
  areaLabels: Int32Array,
  hubIds: readonly string[],
  nodes: NavigationNode[],
  edges: NavigationEdge[],
  connections: AreaConnection[],
  anchorCells?: ReadonlyMap<string, number>,
): void {
  const fine = data.groundSampling
  if (fine === undefined) return
  const step = fine.cellSize
  if (
    !Number.isFinite(step) ||
    step <= 0 ||
    fine.width * step !== data.width ||
    fine.height * step !== data.height ||
    fine.walkable.length !== fine.width * fine.height ||
    fine.level.length !== fine.walkable.length ||
    fine.ramp.length !== fine.walkable.length
  )
    throw new RangeError('Ground sampling must match map bounds and array dimensions')
  const pointOf = (cell: number): Point => {
    const point = centreOf(fine, cell)
    return [point[0] * step, point[1] * step]
  }
  const canStep = (a: number, b: number) =>
    Math.abs(fine.level[a]! - fine.level[b]!) < 0.75 || fine.ramp[a] === 1 || fine.ramp[b] === 1
  const passageAt = (cell: number): { point: Point; width: number } => {
    const x = cell % fine.width,
      y = Math.floor(cell / fine.width)
    const extent = (dx: number, dy: number) => {
      let previous = cell,
        count = 0
      for (let offset = 1; offset <= Math.ceil(1 / step); offset++) {
        const nx = x + dx * offset,
          ny = y + dy * offset
        if (!inside(fine, nx, ny)) break
        const next = ny * fine.width + nx
        if (
          fine.walkable[next] !== 1 ||
          !canStep(previous, next) ||
          Math.abs(fine.level[next]! - fine.level[cell]!) >= 0.25
        )
          break
        count = offset
        previous = next
      }
      return count
    }
    const left = extent(-1, 0),
      right = extent(1, 0),
      down = extent(0, -1),
      up = extent(0, 1)
    const point = pointOf(cell)
    return {
      point:
        left + right < down + up
          ? [point[0] + ((right - left) * step) / 2, point[1]]
          : down + up < left + right
            ? [point[0], point[1] + ((up - down) * step) / 2]
            : point,
      width: Math.min(left + right + 1, down + up + 1) * step,
    }
  }
  const owners = new Int32Array(fine.walkable.length)
  const queue: number[] = []
  for (let cell = 0; cell < owners.length; cell++) {
    if (fine.walkable[cell] !== 1 || fine.ramp[cell] === 1) continue
    const point = pointOf(cell)
    const coarse = Math.floor(point[1]) * data.width + Math.floor(point[0])
    if (Math.abs(fine.level[cell]! - data.level[coarse]!) >= 0.5) continue
    owners[cell] = areaLabels[coarse]!
    if (owners[cell]! > 0) queue.push(cell)
  }
  // Extend territory ownership into previously missed sub-cell corridors, never across a cliff.
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head]!,
      x = cell % fine.width,
      y = Math.floor(cell / fine.width)
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      if (!inside(fine, x + dx!, y + dy!)) continue
      const next = (y + dy!) * fine.width + x + dx!
      if (
        owners[next] === 0 &&
        fine.walkable[next] === 1 &&
        fine.ramp[next] !== 1 &&
        canStep(cell, next)
      ) {
        owners[next] = owners[cell]!
        queue.push(next)
      }
    }
  }
  const cellsByNode = new Map<string, number>()
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!
    const area = node.area === undefined ? 0 : Number(node.area.slice(1))
    let target = node.position
    const at = Math.floor(target[1] / step) * fine.width + Math.floor(target[0] / step)
    const anchor = anchorCells?.get(node.id)
    // A blocked building location is still an expansion: route to its accessible approach,
    // while the expansion record/marker keeps the exact placement position and blocker state.
    if (node.type === 'EXPANSION' && fine.walkable[at] !== 1 && anchor !== undefined)
      target = centreOf(data, anchor)
    const x = Math.floor(target[0] / step),
      y = Math.floor(target[1] / step)
    const reach = Math.ceil(1 / step)
    let selected = -1,
      best = Infinity
    for (let dy = -reach; dy <= reach; dy++)
      for (let dx = -reach; dx <= reach; dx++) {
        if (!inside(fine, x + dx, y + dy)) continue
        const cell = (y + dy) * fine.width + x + dx
        if (fine.walkable[cell] !== 1 || (area !== 0 && owners[cell] !== area)) continue
        const point = pointOf(cell)
        const distance = Math.hypot(point[0] - target[0], point[1] - target[1])
        if (distance < best) {
          best = distance
          selected = cell
        }
      }
    if (selected < 0) continue
    cellsByNode.set(node.id, selected)
    if (node.type !== 'EXPANSION' || target !== node.position)
      nodes[index] = { ...node, position: passageAt(selected).point }
  }
  const byId = new Map(nodes.map(node => [node.id, node]))
  const segmentValid = (a: Point, b: Point) => {
    const count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (step / 2)))
    let previous = -1
    for (let sample = 0; sample <= count; sample++) {
      const x = Math.floor((a[0] + ((b[0] - a[0]) * sample) / count) / step)
      const y = Math.floor((a[1] + ((b[1] - a[1]) * sample) / count) / step)
      if (!inside(fine, x, y)) return false
      const cell = y * fine.width + x
      if (fine.walkable[cell] !== 1 || (previous >= 0 && !canStep(previous, cell))) return false
      if (previous >= 0 && x !== previous % fine.width && y !== Math.floor(previous / fine.width)) {
        const horizontal = Math.floor(previous / fine.width) * fine.width + x
        const vertical = y * fine.width + (previous % fine.width)
        if (
          fine.walkable[horizontal] !== 1 ||
          fine.walkable[vertical] !== 1 ||
          !canStep(previous, horizontal) ||
          !canStep(horizontal, cell) ||
          !canStep(previous, vertical) ||
          !canStep(vertical, cell)
        )
          return false
      }
      previous = cell
    }
    return true
  }
  const pathValid = (path: readonly Point[]) =>
    path.every((point, index) => index === 0 || segmentValid(path[index - 1]!, point))
  const compactPath = (path: readonly Point[]) => {
    const points: Point[] = []
    for (const point of path) {
      while (points.length >= 2) {
        const a = points[points.length - 2]!,
          b = points[points.length - 1]!
        const ux = b[0] - a[0],
          uy = b[1] - a[1],
          vx = point[0] - b[0],
          vy = point[1] - b[1]
        if (Math.abs(ux * vy - uy * vx) > 1e-9 || ux * vx + uy * vy < 0) break
        points.pop()
      }
      points.push(point)
    }
    return points
  }
  const ownerBounds = new Map<number, number[]>()
  for (let cell = 0; cell < owners.length; cell++) {
    const owner = owners[cell]!
    if (owner === 0) continue
    const x = cell % fine.width,
      y = Math.floor(cell / fine.width)
    const box = ownerBounds.get(owner) ?? [x, y, x, y]
    box[0] = Math.min(box[0]!, x)
    box[1] = Math.min(box[1]!, y)
    box[2] = Math.max(box[2]!, x)
    box[3] = Math.max(box[3]!, y)
    ownerBounds.set(owner, box)
  }
  const fields = new Map<string, { costs: Float32Array; field: Float64Array }>()
  const pathBetween = (from: string, to: string, ramp: boolean): Point[] | undefined => {
    const a = cellsByNode.get(from),
      b = cellsByNode.get(to)
    if (a === undefined || b === undefined) return undefined
    const ownerA = owners[a]!,
      ownerB = owners[b]!
    // Crop searches to the participating territories: no full-map field for every graph edge.
    const ax = a % fine.width,
      ay = Math.floor(a / fine.width)
    const bx = b % fine.width,
      by = Math.floor(b / fine.width)
    const padding = Math.ceil(2 / step)
    const rampBox = [
      Math.max(0, Math.min(ax, bx) - padding),
      Math.max(0, Math.min(ay, by) - padding),
      Math.min(fine.width - 1, Math.max(ax, bx) + padding),
      Math.min(fine.height - 1, Math.max(ay, by) + padding),
    ]
    const boxes = [
      ownerBounds.get(ownerA),
      ownerBounds.get(ownerB),
      ramp ? rampBox : undefined,
    ].filter((box): box is number[] => box !== undefined)
    if (boxes.length === 0) return undefined
    const x0 = Math.min(...boxes.map(box => box[0]!)),
      y0 = Math.min(...boxes.map(box => box[1]!))
    const x1 = Math.max(...boxes.map(box => box[2]!)),
      y1 = Math.max(...boxes.map(box => box[3]!))
    const allowed = (cell: number) =>
      fine.walkable[cell] === 1 &&
      ((owners[cell]! > 0 && (owners[cell] === ownerA || owners[cell] === ownerB)) ||
        (ramp &&
          fine.ramp[cell] === 1 &&
          cell % fine.width >= rampBox[0]! &&
          cell % fine.width <= rampBox[2]! &&
          Math.floor(cell / fine.width) >= rampBox[1]! &&
          Math.floor(cell / fine.width) <= rampBox[3]!))
    const size = { width: x1 - x0 + 1, height: y1 - y0 + 1 }
    if (size.width <= 0 || size.height <= 0) return undefined
    const globalCell = (cell: number) =>
      (Math.floor(cell / size.width) + y0) * fine.width + (cell % size.width) + x0
    const localCell = (cell: number) =>
      (Math.floor(cell / fine.width) - y0) * size.width + (cell % fine.width) - x0
    const legal = (a: number, b: number) => canStep(globalCell(a), globalCell(b))
    const key = `${a}|${ownerA}|${ownerB}|${ramp ? b : -1}`
    let saved = fields.get(key)
    if (saved === undefined) {
      const mask = Uint8Array.from({ length: size.width * size.height }, (_, cell) =>
        allowed(globalCell(cell)) ? 1 : 0,
      )
      const clearance = clearanceField(size, mask)
      const costs = Float32Array.from(clearance, value => 1 + 2 / Math.max(step, value * step))
      saved = {
        costs,
        field: distanceField(size, mask, [localCell(a)], Infinity, costs, undefined, legal),
      }
      fields.set(key, saved)
    }
    const { costs, field } = saved
    if (!Number.isFinite(field[localCell(b)]!)) return undefined
    const cells = descend(size, field, localCell(b), costs, legal).reverse()
    // Exact strategic points may lie between samples; keep both links instead of replacing a
    // single-sample path and accidentally losing its start endpoint.
    const path = [
      byId.get(from)!.position,
      ...cells.map(cell => pointOf(globalCell(cell))),
      byId.get(to)!.position,
    ].filter(
      (point, index, path) =>
        index === 0 || point[0] !== path[index - 1]![0] || point[1] !== path[index - 1]![1],
    )
    return pathValid(path) ? compactPath(path) : undefined
  }
  const lengthOf = (path: readonly Point[]) =>
    Math.round(
      path
        .slice(1)
        .reduce(
          (sum, point, i) => sum + Math.hypot(point[0] - path[i]![0], point[1] - path[i]![1]),
          0,
        ) * 100,
    ) / 100
  const retained: NavigationEdge[] = []
  for (const edge of edges) {
    const entryPoint = byId.get(edge.from)!.position,
      exitPoint = byId.get(edge.to)!.position
    if (edge.type === 'GROUND' || edge.type === 'RAMP') {
      const path = pathBetween(edge.from, edge.to, edge.type === 'RAMP')
      if (path !== undefined)
        retained.push({ ...edge, entryPoint, exitPoint, path, distance: lengthOf(path) })
    } else
      retained.push({
        ...edge,
        entryPoint,
        exitPoint,
        ...(edge.path === undefined ? {} : { path: [entryPoint, ...edge.path, exitPoint] }),
        ...(edge.type === 'CLIFF' || edge.type === 'PREDROP'
          ? { distance: lengthOf([entryPoint, exitPoint]) }
          : {}),
      })
  }
  edges.splice(0, edges.length, ...retained)
  const retainedIds = new Set(edges.map(edge => edge.id))
  for (let index = connections.length - 1; index >= 0; index--)
    if (connections[index]!.edgeIds.some(id => !retainedIds.has(id))) connections.splice(index, 1)
  const connected = new Set(
    connections
      .filter(c => c.type === 'GROUND')
      .map(c =>
        [Number(c.areaA.slice(1)), Number(c.areaB.slice(1))].sort((a, b) => a - b).join('|'),
      ),
  )
  let nextId = Math.max(0, ...edges.map(edge => Number(edge.id.slice(1)))) + 1
  const pairs = new Map<string, readonly [number, number]>()
  for (let cell = 0; cell < owners.length; cell++) {
    const x = cell % fine.width,
      y = Math.floor(cell / fine.width)
    for (const next of [
      x + 1 < fine.width ? cell + 1 : -1,
      y + 1 < fine.height ? cell + fine.width : -1,
    ]) {
      if (
        next < 0 ||
        owners[cell] === 0 ||
        owners[next] === 0 ||
        owners[cell] === owners[next] ||
        !canStep(cell, next)
      )
        continue
      const key = [owners[cell]!, owners[next]!].sort((a, b) => a - b).join('|')
      if (!pairs.has(key)) pairs.set(key, [cell, next])
    }
  }
  let passageId = 1
  for (const [key, boundary] of pairs) {
    if (connected.has(key)) continue
    const [a, b] = key.split('|').map(Number)
    const from = hubIds[a! - 1]!,
      to = hubIds[b! - 1]!
    const path = pathBetween(from, to, false)
    if (path === undefined) continue
    const left = passageAt(boundary[0]),
      right = passageAt(boundary[1])
    const point: Point = [
      (left.point[0] + right.point[0]) / 2,
      (left.point[1] + right.point[1]) / 2,
    ]
    let pivot = 0,
      nearest = Infinity
    for (let index = 0; index < path.length; index++) {
      const distance = Math.hypot(path[index]![0] - point[0], path[index]![1] - point[1])
      if (distance < nearest) {
        nearest = distance
        pivot = index
      }
    }
    const leftPath = [...path.slice(0, pivot + 1), point]
    const rightPath = [point, ...path.slice(pivot + 1)]
    if (!pathValid(leftPath) || !pathValid(rightPath)) continue
    const nodeId = `NARROW${passageId++}`
    nodes.push({ id: nodeId, type: 'CHOKE', position: point, region: null })
    const edgeIds: string[] = []
    for (const [source, target, points] of [
      [from, nodeId, leftPath],
      [nodeId, to, rightPath],
    ] as const) {
      const id = `G${nextId++}`
      edgeIds.push(id)
      edges.push({
        id,
        from: source,
        to: target,
        type: 'GROUND',
        entryPoint: points[0]!,
        exitPoint: points[points.length - 1]!,
        path: points,
        distance: lengthOf(points),
        traversalWidth: Math.min(left.width, right.width),
        blockerIds: [],
        destructionHP: 0,
        mineralAmount: 0,
        requiredCapabilities: [],
        enabledCondition: 'always',
      })
    }
    connections.push({ areaA: `A${a}`, areaB: `A${b}`, type: 'GROUND', edgeIds })
  }
}
