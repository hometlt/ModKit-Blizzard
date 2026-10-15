/** SC2 point values enter Runtime only through the Core-materialized canonical UVW world. */
export type Sc2SpawnPoint = Readonly<{ kind: 'literal'; x: string; y: string }>
  | Readonly<{ kind: 'placed'; id: string }>

export class Sc2WorldPointError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

type Quantize = (decimal: string) => string
type Position = Readonly<{ x: string; y: string; z: string }>

function refuse(code: string, message: string): never {
  throw new Sc2WorldPointError(code, message)
}

function fixed(value: number, quantize: Quantize): bigint {
  if (!Number.isFinite(value)) refuse('sc2-runtime/world-point-invalid', 'UVW point coordinate is not finite')
  try { return BigInt(quantize(String(value))) }
  catch { refuse('sc2-runtime/world-point-invalid', 'UVW point coordinate is outside signed fixed64') }
}

/** Match the kernel's signed Q32.32 surface interpolation before creating a ground unit. */
function groundHeight(layer: Record<string, unknown>, x: bigint, z: bigint,
  quantize: Quantize): bigint {
  const { columns, rows, cellSize, origin, samples, noDataValue } = layer
  if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows)
      || (columns as number) < 2 || (rows as number) < 2
      || typeof cellSize !== 'number' || cellSize <= 0
      || !Array.isArray(origin) || origin.length !== 3 || !Array.isArray(samples))
    refuse('sc2-runtime/heightfield-unavailable', 'Selected UVW heightfield is incomplete')
  const size = fixed(cellSize, quantize)
  const dx = x - fixed(origin[0], quantize), dz = z - fixed(origin[2], quantize)
  const width = columns as number, height = rows as number
  if (size <= 0n || dx < 0n || dz < 0n
      || dx > BigInt(width - 1) * size || dz > BigInt(height - 1) * size)
    refuse('sc2-runtime/point-outside-world', 'Galaxy Point is outside the selected UVW heightfield')
  const col = Number(dx / size), row = Number(dz / size)
  const sample = (r: number, c: number): bigint => {
    const value = (samples as unknown[])[r]
    if (!Array.isArray(value) || typeof value[c] !== 'number')
      refuse('sc2-runtime/heightfield-unavailable', 'Selected UVW heightfield has a missing sample')
    if (noDataValue !== undefined && value[c] === noDataValue)
      refuse('sc2-runtime/heightfield-unavailable', 'Galaxy Point falls on UVW no-data terrain')
    return fixed(value[c], quantize)
  }
  const nextCol = Math.min(col + 1, width - 1), nextRow = Math.min(row + 1, height - 1)
  const rx = dx % size, rz = dz % size
  const lerp = (a: bigint, b: bigint, remainder: bigint) =>
    a + (b - a) * remainder / size
  const topLeft = sample(row, col)
  const upper = rx === 0n ? topLeft : lerp(topLeft, sample(row, nextCol), rx)
  const bottomLeft = rz === 0n ? undefined : sample(nextRow, col)
  const lower = bottomLeft === undefined ? undefined : rx === 0n ? bottomLeft
    : lerp(bottomLeft, sample(nextRow, nextCol), rx)
  const value = lower === undefined ? upper : lerp(upper, lower, rz)
  if (value < -(1n << 63n) || value > (1n << 63n) - 1n)
    refuse('sc2-runtime/world-point-invalid', 'Sampled terrain height exceeds signed fixed64')
  return value
}

export function resolveSc2WorldPoint(world: unknown, spaceId: string,
  point: Sc2SpawnPoint, quantize: Quantize): Position {
  const spaces = (world as { spaces?: unknown } | null)?.spaces
  if (!Array.isArray(spaces))
    refuse('sc2-runtime/world-unavailable', 'A Core-materialized UVW world is required')
  const space = spaces.find(value => value?.id === spaceId)
  if (!space || !Array.isArray(space.layers))
    refuse('sc2-runtime/space-ambiguous', `UVW space ${spaceId} is unavailable`)
  if (point.kind === 'placed') {
    // Core maps the native Objects Id to its canonical local object instance ID.
    const localId = `instance-${point.id}`
    const matches = space.layers.filter((layer: { kind?: string }) => layer.kind === 'objects')
      .flatMap((layer: { instances?: unknown }) => Array.isArray(layer.instances) ? layer.instances : [])
      .filter((instance: { id?: string }) => instance.id === localId)
    if (matches.length !== 1 || matches[0]?.objectKind !== 'point'
        || !Array.isArray(matches[0].position) || matches[0].position.length !== 3)
      refuse('sc2-runtime/point-id-unresolved', `PointFromId(${point.id}) has no unique ObjectPoint in ${spaceId}`)
    const [x, y, z] = matches[0].position as number[]
    return { x: fixed(x!, quantize).toString(), y: fixed(y!, quantize).toString(),
      z: fixed(z!, quantize).toString() }
  }
  // SC2 map-native (x,y,z-up) -> UVW (x,z,-y). Galaxy Point has no authored elevation.
  const x = BigInt(point.x), z = -BigInt(point.y)
  const surface = space.layers.find((layer: { kind?: string }) => layer.kind === 'heightfield')
  if (!surface)
    refuse('sc2-runtime/heightfield-unavailable', 'Galaxy Point requires a UVW ground surface')
  return { x: x.toString(), y: groundHeight(surface, x, z, quantize).toString(), z: z.toString() }
}
