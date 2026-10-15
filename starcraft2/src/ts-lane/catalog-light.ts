/**
 * StarCraft II resolved CLight static-preview projection, shared by map and cutscene consumers.
 * Reads dependency-merged catalog fields; does not resolve CTerrain links, animate time of day,
 * project cutscene light nodes, or write native data. Invalid authored numeric fields refuse.
 */

interface CatalogRecord extends Record<string, unknown> {
  value?: unknown
  index?: unknown
  ToDInfoArray?: unknown
  DirectionalLight?: unknown
  Direction?: unknown
  AmbientColor?: unknown
  AmbientEnvironmentMultiplier?: unknown
  Color?: unknown
  ColorMultiplier?: unknown
  SpecularColor?: unknown
  SpecColorMultiplier?: unknown
  UseAmbientOcclusion?: unknown
  Param?: unknown
  OperatorHDR?: unknown
  Colorize?: unknown
  CorrectGamma?: unknown
}

export interface CatalogLightEntity {
  readonly entityId: string
  readonly fields?: Readonly<CatalogRecord>
}

export type CatalogLightProjection =
  | { readonly status: 'no-static-key' | 'no-ambient' | 'no-directional'; readonly stateCount: number }
  | { readonly status: 'ok'; readonly lighting: CatalogStaticLighting; readonly stateCount: number;
      readonly hasTimeOfDayStates: boolean }

export interface CatalogStaticLighting {
  readonly coordinateSpaceId: 'uvw-canonical'
  readonly ambientColor: readonly [number, number, number]
  readonly ambientIntensity: number
  readonly terrain: { readonly specularExponent: number; readonly diffuseMultiplier: number;
    readonly specularMultiplier: number }
  readonly directional: readonly {
    readonly id: string
    readonly direction: readonly [number, number, number]
    readonly color: readonly [number, number, number]
    readonly intensity: number
    readonly specularColor: readonly [number, number, number]
    readonly specularIntensity: number
    readonly useAmbientOcclusion: boolean
  }[]
  readonly toneMapping?: {
    readonly operator: string
    readonly exposure: number
    readonly whitePoint: number
    readonly contrast: number
    readonly correctGamma: boolean
    readonly colorization?: Readonly<CatalogRecord>
    readonly ambientOcclusion: Readonly<CatalogRecord>
  }
}

/** Narrow object guard for resolved catalog wrappers and indexed records. */
function recordOf(value: unknown): CatalogRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as CatalogRecord : undefined
}

/** Read a resolved field's value while retaining bare scalar compatibility. */
export function catalogFieldValue(value: unknown): unknown {
  const record = recordOf(value)
  return record !== undefined && Object.hasOwn(record, 'value') ? record.value : value
}

/** Unwrap a resolved structured field, preserving bare records. */
export function resolvedFieldRecord(value: unknown): CatalogRecord | undefined {
  const record = recordOf(value)
  return recordOf(record?.value) ?? record
}

/** Unwrap a resolved indexed record without losing an index kept on its wrapper. */
function resolvedIndexedFieldRecord(value: unknown): CatalogRecord | undefined {
  const record = recordOf(value)
  const nested = recordOf(record?.value)
  if (nested === undefined) return record
  return Object.freeze({
    ...nested,
    ...(nested.index === undefined && record?.index !== undefined ? { index: record.index } : {}),
  })
}

/** Parse native comma-separated finite components; map water fields reuse this exact parser. */
export function commaSeparatedVector(value: unknown, count: number, label: string): readonly number[] | undefined {
  if (value === undefined) return undefined
  const components = String(value).split(',').map(component => Number(component.trim()))
  if (components.length !== count || components.some(component => !Number.isFinite(component)))
    throw new TypeError(`${label} must contain ${String(count)} finite comma-separated numbers`)
  return Object.freeze(components)
}

/** Admit a catalog RGB vector in the native zero-to-one range. */
function catalogVector3(value: unknown, label: string): readonly [number, number, number] | undefined {
  const vector = commaSeparatedVector(catalogFieldValue(value), 3, label)
  if (vector === undefined) return undefined
  if (vector.some(component => component < 0 || component > 1))
    throw new TypeError(`${label} components must be between zero and one`)
  return Object.freeze([vector[0]!, vector[1]!, vector[2]!])
}

/** Convert a nonzero SC2 z-up light vector to the admitted UVW world basis. */
function sc2LightDirection(value: unknown, label: string): readonly [number, number, number] | undefined {
  const native = commaSeparatedVector(catalogFieldValue(value), 3, label)
  if (native === undefined) return undefined
  if (Math.hypot(...native) <= Number.EPSILON) throw new TypeError(`${label} must be non-zero`)
  return Object.freeze([native[0]!, native[2]!, -native[1]!])
}

/** Validate authored numeric light fields with the map resolver's existing default rule. */
function finiteNumber(value: unknown, label: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`)
  return number
}

/** Project the last static ToD state with a Key direction; no local scene lights are inferred. */
export function projectCatalogLight(light: CatalogLightEntity): CatalogLightProjection {
  const lightId = light.entityId
  const rawStates = Array.isArray(light.fields?.ToDInfoArray)
    ? light.fields.ToDInfoArray
    : light.fields?.ToDInfoArray === undefined ? [] : [light.fields.ToDInfoArray]
  const states = rawStates.map(resolvedFieldRecord).filter((state): state is CatalogRecord => state !== undefined)
  let selected: CatalogRecord | undefined
  for (const state of states) {
    const lights = Array.isArray(state.DirectionalLight)
      ? state.DirectionalLight : state.DirectionalLight === undefined ? [] : [state.DirectionalLight]
    const key = lights.map(resolvedIndexedFieldRecord)
      .find(item => String(item?.index ?? '').toLowerCase() === 'key')
    if (key !== undefined && catalogFieldValue(key.Direction) !== undefined) selected = state
  }
  if (selected === undefined) return Object.freeze({ status: 'no-static-key', stateCount: states.length })

  const ambientColor = catalogVector3(selected.AmbientColor,
    `catalog:Light[${lightId}].ToDInfoArray.AmbientColor`)
  if (ambientColor === undefined) return Object.freeze({ status: 'no-ambient', stateCount: states.length })

  const rawDirectional = Array.isArray(selected.DirectionalLight)
    ? selected.DirectionalLight : selected.DirectionalLight === undefined ? [] : [selected.DirectionalLight]
  const order = new Map([['key', 0], ['fill', 1], ['back', 2]])
  const directional = rawDirectional.map(resolvedIndexedFieldRecord).filter((item): item is CatalogRecord => item !== undefined)
    .map(item => {
      const role = String(item.index ?? '').trim()
      const direction = sc2LightDirection(item.Direction,
        `catalog:Light[${lightId}].DirectionalLight[${role}].Direction`)
      if (role.length === 0 || direction === undefined) return undefined
      const color = catalogVector3(item.Color, `catalog:Light[${lightId}].DirectionalLight[${role}].Color`)
        ?? Object.freeze([1, 1, 1] as const)
      const intensity = finiteNumber(catalogFieldValue(item.ColorMultiplier),
        `catalog:Light[${lightId}].DirectionalLight[${role}].ColorMultiplier`, 1)
      if (intensity < 0) throw new TypeError(
        `catalog:Light[${lightId}].DirectionalLight[${role}].ColorMultiplier must be non-negative`)
      const specularColor = catalogVector3(item.SpecularColor,
        `catalog:Light[${lightId}].DirectionalLight[${role}].SpecularColor`) ?? color
      const specularIntensity = finiteNumber(catalogFieldValue(item.SpecColorMultiplier), 'SpecColorMultiplier', 1)
      if (specularIntensity < 0) throw new TypeError('SpecColorMultiplier must be non-negative')
      return Object.freeze({ id: `${lightId}:${role}`, direction, color, intensity, specularColor, specularIntensity,
        useAmbientOcclusion: Number(catalogFieldValue(item.UseAmbientOcclusion) ?? 1) !== 0 })
    }).filter(item => item !== undefined)
    .sort((left, right) =>
      (order.get(left.id.slice(left.id.lastIndexOf(':') + 1).toLowerCase()) ?? 3) -
      (order.get(right.id.slice(right.id.lastIndexOf(':') + 1).toLowerCase()) ?? 3))
  if (directional.length === 0) return Object.freeze({ status: 'no-directional', stateCount: states.length })
  const ambientIntensity = finiteNumber(catalogFieldValue(selected.AmbientEnvironmentMultiplier),
    `catalog:Light[${lightId}].ToDInfoArray.AmbientEnvironmentMultiplier`, 1)
  if (ambientIntensity < 0) throw new TypeError(
    `catalog:Light[${lightId}].ToDInfoArray.AmbientEnvironmentMultiplier must be non-negative`)

  const hdr = new Map((Array.isArray(selected.Param) ? selected.Param : [])
    .map(entry => [String((entry as CatalogRecord).index), Number(catalogFieldValue(entry))] as const))
  const exposure = hdr.get('HDRExposure'), whitePoint = hdr.get('HDRWhitePoint')
  // PSTonemap.fx's contrast comes from ColorizationContrast; HDRContrast is not an SC2 key.
  const contrast = hdr.get('ColorizationContrast')
  const parameter = (name: string, fallback: number): number => Number.isFinite(hdr.get(name)) ? hdr.get(name)! : fallback
  const operatorId = String(catalogFieldValue(selected.OperatorHDR) ?? '0').toLowerCase()
  const operator = ({ '0': 'reinhard', '1': 'exponential', '2': 'logarithmic', '3': 'linear', '4': 'filmic',
    reinhard: 'reinhard', exponential: 'exponential', logarithmic: 'logarithmic', linear: 'linear', filmic: 'filmic'
  } as Record<string, string>)[operatorId] ?? 'reinhard'
  const colorization = Number(catalogFieldValue(selected.Colorize) ?? 0) !== 0 ? Object.freeze({
    inputLow: parameter('ColorizationInputLow', 0), inputHigh: parameter('ColorizationInputHigh', 1),
    inputGamma: parameter('ColorizationInputGamma', 1), outputLow: parameter('ColorizationOutputLow', 0),
    outputHigh: parameter('ColorizationOutputHigh', 1), brightness: parameter('ColorizationBrightness', 1),
    contrast: parameter('ColorizationContrast', 1), hue: parameter('ColorizationHue', 0),
    saturation: parameter('ColorizationSaturation', 0), lightness: parameter('ColorizationLightness', 0),
    blend: parameter('ColorizationBlend', 0),
  }) : undefined
  const toneMapping = Number.isFinite(exposure) && exposure! > 0 && Number.isFinite(whitePoint) && whitePoint! > 0
    ? Object.freeze({ operator, exposure: exposure!, whitePoint: whitePoint!,
        contrast: Number.isFinite(contrast) && contrast! > 0 ? contrast! : 1,
        correctGamma: Number(catalogFieldValue(selected.CorrectGamma) ?? 0) !== 0,
        ...(colorization === undefined ? {} : { colorization }),
        ambientOcclusion: Object.freeze({ radius: parameter('AOOcclusionRadius', 0),
          noOcclusion: parameter('AONoOcclusion', 0.6), fullOcclusion: parameter('AOFullOcclusion', 0.05),
          power: parameter('AOOcclusionPower', 2) }),
      }) : undefined
  return Object.freeze({ status: 'ok', stateCount: states.length, hasTimeOfDayStates: states.length > 1,
    lighting: Object.freeze({ coordinateSpaceId: 'uvw-canonical', ambientColor, ambientIntensity,
      terrain: Object.freeze({ specularExponent: parameter('TerrainSpecularExp', 16),
        diffuseMultiplier: parameter('TerrainHDRDiffuse', 1),
        specularMultiplier: parameter('TerrainHDRSpecular', 1) }),
      directional: Object.freeze(directional), ...(toneMapping === undefined ? {} : { toneMapping }) }) })
}
