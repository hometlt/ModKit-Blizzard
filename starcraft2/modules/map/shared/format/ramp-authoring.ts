/**
 * SC2 Maps owner: place a qualified native ramp patch on an existing cliff grid.
 * Transfers only authored ramp-cell support, never rectangular donor terrain.
 * Preserves separate HMAP levels and CLIF samples; rebases simple native layer
 * masks with the cliff band and rebuilds surrounding flat/wall cells. Translation follows the two-cell
 * wall lattice; vertical moves are whole cliff bands. No source-game inference,
 * rotation, stretching, binary parsing or navigation claims are made here.
 * widenDiagonalCliffRampTemplate repeats a qualified central two-cell profile
 * laterally, moving native side frames without stretching their meshes.
 * rankDiagonalCliffRampPlacements ranks lattice-aligned native widths/positions
 * from source crossing points; neither map identities nor source-game thresholds
 * enter its policy. The caller qualifies longitudinal profiles and native joins.
 * writeTerrainRampList serializes the same native TerrainRamp records consumed
 * by parseTerrainXml, including explicit zero frames and absent-variation sentinels.
 * Native template samples are supplied by the existing format readers.
 */
import { cliffTileCode, type CliffVertexLevels } from './cliff-tiles.js'
import type { CliffLevelResult } from './formats/sync-cliff-level.js'
import type { CliffCell, TerrainRamp, TerrainRampFrame } from './terrain-params.js'

export interface CliffRampGrid {
  vertices: CliffVertexLevels
  vertexMasks: readonly number[]
  cliffLevel: CliffLevelResult
  cliffCells: readonly CliffCell[]
}

export interface CliffRampPlacementCandidate {
  templateIndex: number
  extraHalfWidth: number
  center: [number, number]
  width: number
  centerError: number
}

/**
 * Rank native diagonal ramp placements against explicit crossing points in target
 * cell coordinates. Points come from authored or separately qualified inferred
 * passage facts; this owner does not discover source-game ramps. Smallest widths
 * that contain every crossing win, then proximity to their centroid. Translation
 * stays on the donor's two-cell lattice. The caller must test longitudinal support,
 * terrain joins and every passage lane before accepting a candidate.
 */
export function rankDiagonalCliffRampPlacements(
  templates: readonly CliffRampTemplate[],
  crossings: readonly (readonly [number, number])[],
  uphill: readonly [number, number],
): CliffRampPlacementCandidate[] {
  if (templates.length > 256 || crossings.length < 2 || crossings.length > 4096 ||
      !crossings.every(point => point.length === 2 && point.every(value => Number.isFinite(value) && value >= 0 && value <= 256)) ||
      uphill.length !== 2 || !uphill.every(Number.isFinite) || Math.abs(Math.hypot(...uphill) - 1) > 1e-5)
    throw new RangeError('Ramp fitting needs crossings inside the supported 256-cell map and a unit uphill direction')
  const centroid: [number, number] = [0, 0]
  for (const point of crossings) { centroid[0] += point[0] / crossings.length; centroid[1] += point[1] / crossings.length }
  const candidates: CliffRampPlacementCandidate[] = []
  templates.forEach((template, templateIndex) => {
    const mid = template.ramp.frames.mid
    if (!mid || ![5, 6].includes(template.ramp.dir) ||
        ![...mid.up, ...mid.right, ...mid.center, mid.width, mid.height].every(Number.isFinite) ||
        !mid.center.every(Number.isSafeInteger) ||
        mid.up.some(value => Math.abs(Math.abs(value) - Math.SQRT1_2) > 1e-5) ||
        Math.abs(Math.hypot(...mid.up) - 1) > 1e-5 || Math.abs(Math.hypot(...mid.right) - 1) > 1e-5 ||
        Math.abs(mid.up[0] * mid.right[0] + mid.up[1] * mid.right[1]) > 1e-5 ||
        Math.abs(mid.up[0] * uphill[0] + mid.up[1] * uphill[1] - 1) > 1e-5 || mid.width <= 0 || mid.height <= 0)
      return
    const offsetsX = [...new Set([Math.floor((centroid[0] - mid.center[0]) / 2), Math.ceil((centroid[0] - mid.center[0]) / 2)])]
    const offsetsY = [...new Set([Math.floor((centroid[1] - mid.center[1]) / 2), Math.ceil((centroid[1] - mid.center[1]) / 2)])]
    for (const x of offsetsX) for (const y of offsetsY) {
      const center: [number, number] = [mid.center[0] + x * 2, mid.center[1] + y * 2]
      if (!center.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 256)) continue
      const required = Math.max(...crossings.map(point => Math.abs((point[0] - center[0]) * mid.right[0] + (point[1] - center[1]) * mid.right[1])))
      // The widening owner adds extraHalfWidth * sqrt(2) to each half-width.
      const extraHalfWidth = Math.max(0, Math.ceil((required - mid.width - 1e-5) / (2 * Math.SQRT2))) * 2
      if (extraHalfWidth > 64) continue
      candidates.push({ templateIndex, extraHalfWidth, center, width: 2 * (mid.width + extraHalfWidth * Math.SQRT2),
        centerError: Math.hypot(center[0] - centroid[0], center[1] - centroid[1]) })
    }
  })
  return candidates.sort((a, b) => a.width - b.width || a.centerError - b.centerError ||
    a.templateIndex - b.templateIndex || a.center[0] - b.center[0] || a.center[1] - b.center[1])
}

/** Serialize native ramp records; every emitted attribute contains checked numbers only. */
export function writeTerrainRampList(ramps: readonly TerrainRamp[]): string {
  const frameKeys = ['leftLo', 'leftHi', 'rightLo', 'rightHi', 'base', 'mid'] as const
  const rows = ramps.map(ramp => {
    if (![ramp.dir, ramp.lo, ramp.hi, ramp.cliffSetIndex].every(Number.isSafeInteger) ||
        ramp.dir < 1 || ramp.dir > 8 || ramp.lo < 1 || ramp.hi !== ramp.lo + 1 || ramp.hi >= 8 || ramp.cliffSetIndex < 0)
      throw new RangeError('Invalid native ramp header')
    const attributes = [`dir="${ramp.dir}"`, `hi="${ramp.hi}"`, `lo="${ramp.lo}"`, `cid="${ramp.cliffSetIndex}"`]
    for (const key of frameKeys) {
      const frame = ramp.frames[key] ?? { up: [0, 0], right: [0, 0], center: [0, 0], width: 0, height: 0 }
      if (![...frame.up, ...frame.right, ...frame.center, frame.width, frame.height].every(Number.isFinite) ||
          frame.width < 0 || frame.height < 0) throw new RangeError('Invalid native ramp frame')
      attributes.push(`${key}="u(${frame.up.join(', ')}) r(${frame.right.join(', ')}) c=(${frame.center.join(', ')}) w=${frame.width} h=${frame.height}"`)
      if (key !== 'base' && key !== 'mid') {
        const variation = ramp.variations[key] ?? 0xffffffff
        if (!Number.isSafeInteger(variation) || variation < 0 || variation > 0xffffffff)
          throw new RangeError('Invalid native ramp variation')
        attributes.push(`${key}Var="${variation}"`)
      }
    }
    return `<ramp ${attributes.join(' ')}/>`
  })
  return `<rampList num="${ramps.length}">${rows.join('')}</rampList>`
}

export interface CliffRampTemplate extends CliffRampGrid {
  ramp: TerrainRamp
  /** Inclusive vertex bounds, aligned to the two-cell native wall lattice. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

/** Widen an admitted 45-degree native ramp by whole two-cell strips on each side. */
export function widenDiagonalCliffRampTemplate(template: CliffRampTemplate, extraHalfWidth: number): CliffRampTemplate {
  if (!Number.isSafeInteger(extraHalfWidth) || extraHalfWidth < 0 || extraHalfWidth % 2 !== 0)
    throw new RangeError('Ramp widening must use whole two-cell lateral strips')
  if (extraHalfWidth === 0) return template
  const mid = template.ramp.frames.mid
  if (!mid || ![5, 6].includes(template.ramp.dir) ||
      ![...mid.up, ...mid.right, ...mid.center, mid.width, mid.height].every(Number.isFinite) ||
      !mid.center.every(Number.isSafeInteger) || mid.width <= 0 || mid.height <= 0 ||
      mid.up.some(value => Math.abs(Math.abs(value) - Math.SQRT1_2) > 1e-5) ||
      mid.right.some(value => Math.abs(Math.abs(value) - Math.SQRT1_2) > 1e-5) ||
      Math.abs(mid.up[0] * mid.right[0] + mid.up[1] * mid.right[1]) > 1e-5)
    throw new RangeError('Ramp widening requires a qualified diagonal native profile')
  if (!Object.values(template.bounds).every(value => Number.isSafeInteger(value) && value % 2 === 0) ||
      template.bounds.minX >= template.bounds.maxX || template.bounds.minY >= template.bounds.maxY)
    throw new RangeError('Ramp widening requires ordered bounds on the two-cell lattice')
  const { sizeX, sizeY } = template.vertices
  if (!Number.isSafeInteger(sizeX) || !Number.isSafeInteger(sizeY) || sizeX < 3 || sizeY < 3 ||
      sizeX % 2 !== 1 || sizeY % 2 !== 1 || template.vertices.levels.length !== sizeX * sizeY ||
      template.vertexMasks.length !== sizeX * sizeY || template.cliffLevel.sizeX !== sizeX - 1 ||
      template.cliffLevel.sizeY !== sizeY - 1 || template.cliffLevel.heights.length !== (sizeX - 1) * (sizeY - 1))
    throw new RangeError('Ramp widening requires matching native grids')
  const [rx, ry] = mid.right.map(Math.sign), [cx, cy] = mid.center
  const bounds = { minX: template.bounds.minX - extraHalfWidth, minY: template.bounds.minY - extraHalfWidth,
    maxX: template.bounds.maxX + extraHalfWidth, maxY: template.bounds.maxY + extraHalfWidth }
  const vertices = { ...template.vertices, levels: [...template.vertices.levels] }
  const vertexMasks = [...template.vertexMasks]
  const cliffLevel = { ...template.cliffLevel, heights: [...template.cliffLevel.heights] }
  if (bounds.minX < 0 || bounds.minY < 0 || bounds.maxX >= vertices.sizeX || bounds.maxY >= vertices.sizeY)
    throw new RangeError('Widened ramp must fit entirely inside its template grid')
  // Repeat a central strip, preserving the integer two-cell wall lattice on both sides.
  const sourcePoint = (x: number, y: number) => {
    const lateral = ((x - cx) * rx! + (y - cy) * ry!) / 2
    const shift = Math.sign(lateral) * Math.min(extraHalfWidth, Math.floor(Math.abs(lateral) / 2) * 2)
    return [x - shift * rx!, y - shift * ry!] as const
  }
  for (let y = bounds.minY; y <= bounds.maxY; y++) for (let x = bounds.minX; x <= bounds.maxX; x++) {
    const [sx, sy] = sourcePoint(x, y)
    if (sx < 0 || sy < 0 || sx >= vertices.sizeX || sy >= vertices.sizeY)
      throw new RangeError('Ramp profile repeat exceeds the source grid')
    const index = y * vertices.sizeX + x, source = sy * vertices.sizeX + sx
    vertices.levels[index] = template.vertices.levels[source]!
    vertexMasks[index] = template.vertexMasks[source]!
    if (x < bounds.maxX && y < bounds.maxY)
      cliffLevel.heights[y * cliffLevel.sizeX + x] = template.cliffLevel.heights[sy * cliffLevel.sizeX + sx]!
  }
  const columns = cliffLevel.sizeX / 2
  const cells = new Map(template.cliffCells.map(cell => [cell.index, { ...cell }]))
  const sourceCells = new Map(template.cliffCells.map(cell => [cell.index, cell]))
  for (let y = bounds.minY; y < bounds.maxY; y += 2) for (let x = bounds.minX; x < bounds.maxX; x += 2) {
    const [sx, sy] = sourcePoint(x + 1, y + 1)
    const source = sourceCells.get(((sy - 1) / 2) * columns + (sx - 1) / 2)
    if (!source) throw new RangeError('Ramp widening requires complete authored cells')
    const index = (y / 2) * columns + x / 2
    cells.set(index, { ...source, index })
  }
  const frames: TerrainRamp['frames'] = {}
  for (const [key, frame] of Object.entries(template.ramp.frames)) {
    if (!frame || (frame.width === 0 && frame.height === 0)) continue
    if (![...frame.up, ...frame.right, ...frame.center, frame.width, frame.height].every(Number.isFinite) ||
        frame.width < 0 || frame.height < 0) throw new RangeError('Invalid native ramp frame')
    const lateral = (frame.center[0] - cx) * rx! + (frame.center[1] - cy) * ry!
    frames[key as keyof TerrainRamp['frames']] = {
      ...frame, up: [...frame.up], right: [...frame.right],
      center: key === 'mid' || key === 'base' ? [...frame.center] :
        [frame.center[0] + Math.sign(lateral) * extraHalfWidth * rx!, frame.center[1] + Math.sign(lateral) * extraHalfWidth * ry!],
      width: key === 'mid' || key === 'base' ? frame.width + extraHalfWidth * Math.SQRT2 : frame.width,
    }
  }
  return { vertices, vertexMasks, cliffLevel, cliffCells: [...cells.values()], bounds,
    ramp: { ...template.ramp, frames, variations: { ...template.ramp.variations } } }
}

/** Place one native ramp without mutating the target or its template. */
export function placeCliffRampTemplate(
  target: CliffRampGrid,
  template: CliffRampTemplate,
  placement: { offsetX: number; offsetY: number; levelOffset: number; cliffSetIndex: number },
): CliffRampGrid & { ramp: TerrainRamp; changedVertices: number; changedCells: number } {
  const { offsetX, offsetY, levelOffset, cliffSetIndex } = placement
  const { minX, minY, maxX, maxY } = template.bounds
  const integer = Number.isSafeInteger
  if (![offsetX, offsetY, minX, minY, maxX, maxY].every(v => integer(v) && v % 2 === 0) ||
      !integer(levelOffset) || levelOffset % 4 !== 0 || !integer(cliffSetIndex) || cliffSetIndex < 0)
    throw new RangeError('Ramp placement must preserve the two-cell lattice and whole cliff bands')
  for (const grid of [target, template]) {
    const { sizeX, sizeY, levels } = grid.vertices
    if (!integer(sizeX) || !integer(sizeY) || sizeX < 3 || sizeY < 3 || sizeX % 2 !== 1 || sizeY % 2 !== 1 ||
        levels.length !== sizeX * sizeY || grid.vertexMasks.length !== levels.length ||
        grid.cliffLevel.sizeX !== sizeX - 1 || grid.cliffLevel.sizeY !== sizeY - 1 ||
        grid.cliffLevel.heights.length !== (sizeX - 1) * (sizeY - 1))
      throw new RangeError('Ramp grids must contain matching vertex, mask and simulation cell arrays')
  }
  if (minX < 0 || minY < 0 || minX >= maxX || minY >= maxY ||
      maxX >= template.vertices.sizeX || maxY >= template.vertices.sizeY ||
      minX + offsetX < 0 || minY + offsetY < 0 ||
      maxX + offsetX >= target.vertices.sizeX || maxY + offsetY >= target.vertices.sizeY)
    throw new RangeError('Ramp patch must fit entirely inside both grids')
  const lo = template.ramp.lo + levelOffset / 4
  const hi = template.ramp.hi + levelOffset / 4
  if (!integer(lo) || !integer(hi) || lo < 1 || hi !== lo + 1 || hi >= 8 ||
      !template.ramp.frames.mid || !integer(template.ramp.dir) || template.ramp.dir < 1 || template.ramp.dir > 8)
    throw new RangeError('Ramp template must join two adjacent supported full levels')

  const vertices = { ...target.vertices, levels: [...target.vertices.levels] }
  const vertexMasks = [...target.vertexMasks]
  const cliffLevel = { ...target.cliffLevel, heights: [...target.cliffLevel.heights] }
  let changedVertices = 0
  let changedCells = 0
  const columns = cliffLevel.sizeX / 2
  const sourceColumns = template.cliffLevel.sizeX / 2
  const sourceCells = new Map(template.cliffCells.map(cell => [cell.index, cell]))
  const supportVertices = new Set<number>()
  const supportCells = new Set<number>()
  const rampCells: CliffCell[] = []
  for (let y = minY; y < maxY; y += 2) for (let x = minX; x < maxX; x += 2) {
    const source = sourceCells.get((y / 2) * sourceColumns + x / 2)
    if (!source) throw new RangeError('Ramp template patch has a missing authored cliff cell')
    if (source.flags !== 2) continue
    rampCells.push({ ...source, index: ((y + offsetY) / 2) * columns + (x + offsetX) / 2, cliffSetIndex })
    for (let dy = 0; dy <= 2; dy++) for (let dx = 0; dx <= 2; dx++) {
      supportVertices.add((y + dy) * template.vertices.sizeX + x + dx)
      if (dx < 2 && dy < 2) supportCells.add((y + dy) * template.cliffLevel.sizeX + x + dx)
    }
  }
  if (!rampCells.length) throw new RangeError('Ramp template has no authored ramp cells')
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const sourceIndex = y * template.vertices.sizeX + x
    if (!supportVertices.has(sourceIndex)) continue
    const index = (y + offsetY) * vertices.sizeX + x + offsetX
    const level = template.vertices.levels[sourceIndex]! + levelOffset
    const mask = template.vertexMasks[sourceIndex]!
    if (!integer(level) || level < 4 || level > 28 || !integer(mask) || mask < 0 || mask > 0xffff)
      throw new RangeError('Ramp template has an unsupported vertex level or mask')
    if (levelOffset !== 0 && mask !== template.ramp.lo && mask !== template.ramp.hi)
      throw new RangeError('Shifted ramp requires qualified simple native layer masks')
    vertices.levels[index] = level
    vertexMasks[index] = mask + levelOffset / 4
    changedVertices++
    if (supportCells.has(y * template.cliffLevel.sizeX + x)) {
      const raw = template.cliffLevel.heights[y * template.cliffLevel.sizeX + x]! + levelOffset * 16
      if (!integer(raw) || raw < 0 || raw > 0xffff) throw new RangeError('Ramp CLIF sample exceeds uint16')
      cliffLevel.heights[(y + offsetY) * cliffLevel.sizeX + x + offsetX] = raw
      changedCells++
    }
  }

  const cliffCells = new Map(target.cliffCells.map(cell => [cell.index, { ...cell }]))
  for (const cell of rampCells) {
    if (cliffCells.get(cell.index)?.flags === 2) throw new RangeError('Ramp patch overlaps an existing ramp')
    cliffCells.set(cell.index, cell)
  }
  const frames: TerrainRamp['frames'] = {}
  for (const [key, source] of Object.entries(template.ramp.frames)) {
    // Editor placeholders can have a nonzero center but zero basis/extents.
    if (!source || (source.width === 0 && source.height === 0)) continue
    const extentX = Math.abs(source.up[0] * source.height) + Math.abs(source.right[0] * source.width)
    const extentY = Math.abs(source.up[1] * source.height) + Math.abs(source.right[1] * source.width)
    if (source.center[0] - extentX < minX - 1e-5 || source.center[0] + extentX > maxX + 1e-5 ||
        source.center[1] - extentY < minY - 1e-5 || source.center[1] + extentY > maxY + 1e-5)
      throw new RangeError('Ramp patch clips an active native frame')
    const frame: TerrainRampFrame = { ...source, up: [...source.up], right: [...source.right],
      center: [source.center[0] + offsetX, source.center[1] + offsetY] }
    frames[key as keyof TerrainRamp['frames']] = frame
  }
  // Rebuild only cells touching transferred vertices, leaving the target outside
  // the ramp support intact. The donor's nearby plateaus are not part of a ramp.
  const placedRampIndices = new Set(rampCells.map(cell => cell.index))
  for (let y = minY + offsetY - 2; y <= maxY + offsetY; y += 2)
    for (let x = minX + offsetX - 2; x <= maxX + offsetX; x += 2) {
      if (x < 0 || y < 0 || x + 2 >= vertices.sizeX || y + 2 >= vertices.sizeY) continue
      const index = (y / 2) * columns + x / 2
      if (placedRampIndices.has(index)) continue
      if (![[x, y], [x + 2, y], [x + 2, y + 2], [x, y + 2]].some(([vx, vy]) => {
        const sx = vx! - offsetX, sy = vy! - offsetY
        return sx >= 0 && sy >= 0 && sx < template.vertices.sizeX && sy < template.vertices.sizeY &&
          supportVertices.has(sy * template.vertices.sizeX + sx)
      })) continue
      if (cliffCells.get(index)?.flags === 2) throw new RangeError('Ramp patch join overlaps an existing ramp')
      const corners = [vertices.levels[y * vertices.sizeX + x]!, vertices.levels[y * vertices.sizeX + x + 2]!,
        vertices.levels[(y + 2) * vertices.sizeX + x + 2]!, vertices.levels[(y + 2) * vertices.sizeX + x]!]
      if (corners.some(level => level % 4 !== 0) || cliffTileCode(corners) === undefined)
        throw new RangeError('Ramp patch join needs representable full cliff levels')
      cliffCells.set(index, { index, flags: corners.every(level => level === corners[0]) ? 0 : 1,
        cliffSetIndex, variation: 0 })
    }
  const ramp: TerrainRamp = { ...template.ramp, lo, hi, cliffSetIndex, frames,
    variations: { ...template.ramp.variations } }
  return { vertices, vertexMasks, cliffLevel, cliffCells: [...cliffCells.values()].sort((a, b) => a.index - b.index),
    ramp, changedVertices, changedCells }
}
