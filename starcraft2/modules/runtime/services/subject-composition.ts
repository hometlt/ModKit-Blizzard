/** SC2-specific input projection for the universal runtime. Data and Map retain their schemas;
 * this service only coordinates their public resolved views for one ModContext closure.
 */
import { createModContextDataWorkspaceInputs } from '@modkit/host'
import { analyzeResolvedDataWorkspace } from '@modkit/host/data'
import { analyzeResolvedMapWorkspace } from '@modkit/host/maps'
import { materializeWorldToUvw, materializeWorldToUvpMap } from '@modkit/uv/world'
import { lowerSc2UnitSlice, lowerSc2UnitSlices } from '@modkit/blizzard-starcraft2/data/runtime-unit-slice'
import { analyzeGalaxySingleUnitSpawn, bindGalaxySingleUnitSpawn } from './galaxy-spawn-lowering.js'

type DataRequest = Parameters<typeof analyzeResolvedDataWorkspace>[0]
type MapRequest = Parameters<typeof analyzeResolvedMapWorkspace>[0]
type ModContext = Parameters<typeof createModContextDataWorkspaceInputs>[0]
type NestedRoot = NonNullable<Parameters<typeof createModContextDataWorkspaceInputs>[1]>['nestedRoot']
type Quantize = (decimal: string) => string
interface RuntimeDiagnostic { readonly message: string; readonly code?: string }

export interface Sc2RuntimeResolveRequest {
  readonly context: ModContext
  readonly services: DataRequest['services'] & MapRequest['services']
  readonly budgets: DataRequest['budgets']
  readonly unit: DataRequest['queries'][number]
  readonly additionalUnits?: readonly DataRequest['queries'][number][] | undefined
  readonly quantizeFixed64Decimal: Quantize
  readonly nestedRoot?: NestedRoot | undefined
  readonly locales?: readonly string[] | undefined
  readonly onStage?: ((stage: { name: string; elapsedMs: number }) => void) | undefined
  readonly signal?: AbortSignal | undefined
}
export interface Sc2RuntimeGalaxySource {
  readonly text: string
  readonly fileName: string
  readonly functionName: string
  readonly layerId?: string
}
export interface Sc2RuntimePrepareRequest extends Sc2RuntimeResolveRequest {
  readonly galaxy: Sc2RuntimeGalaxySource
  readonly spaceId?: string | undefined
  readonly playerSlots?: readonly { readonly slot: string; readonly address: string }[]
}
export interface Sc2RuntimeProjectionRequest extends Omit<Sc2RuntimePrepareRequest, 'galaxy'> {
  readonly galaxy: Sc2RuntimeGalaxySource | { readonly path: string; readonly functionName: string }
}

export class Sc2RuntimeCompositionError extends Error {
  constructor(readonly code: string, readonly diagnostics: readonly RuntimeDiagnostic[]) {
    super(diagnostics.map(item => item.message).join('; ') || code)
  }
}

/** Core materializes the exact world for simulation. Portable presentation is an explicit,
 * separately fallible request to the same Core package writer used by ordinary map export.
 */
export async function materializeSc2RuntimeWorld(
  source: Parameters<typeof materializeWorldToUvw>[0],
  options: { readonly presentation?: 'deferred' | 'required'; readonly signal?: AbortSignal } = {},
) {
  if (options.presentation !== undefined && options.presentation !== 'deferred'
      && options.presentation !== 'required')
    throw new TypeError('Unknown Runtime world presentation policy')
  const limits = { maxPageItems: 512, maxTerrainItems: 1_000_000,
    maxFacetItems: 1_000_000, maxOutputBytes: 64 * 1024 * 1024,
    ...(options.signal === undefined ? {} : { signal: options.signal }) }
  // Simulation consumes exact world semantics, not decoded presentation assets. Preserve the
  // authored visual references and report them as deferred, never as verified model witnesses.
  // UVD gameplay/socket dependencies still go through the universal compositor and may refuse.
  if (options.presentation !== 'required') {
    const materialized = await materializeWorldToUvw(source, limits)
    options.signal?.throwIfAborted()
    if (materialized.state !== 'materialized')
      throw new Sc2RuntimeCompositionError('sc2-runtime/uvw-unresolved', materialized.refusals)
    return { world: materialized.document, media: [], models: [],
      worldReceipt: { artifactDigest: materialized.artifactDigest,
        sourceSnapshotId: materialized.sourceSnapshotId,
        excludedFacetIds: materialized.excludedFacetIds,
        observedTerrainItems: materialized.observedTerrainItems,
        packagedTextureCount: 0, packagedModelCount: 0,
        presentation: { state: 'deferred' as const,
          reason: 'Visual resources were not read; this is not a portable presentation package.' } } }
  }

  const materialized = await materializeWorldToUvpMap(source, {
    packageId: 'sc2-runtime/selected-map', packageVersion: '1.0.0',
    ...limits,
    maxTextureBytes: 16 * 1024 * 1024, maxMediaBytes: 256 * 1024 * 1024,
    maxModelBytes: 128 * 1024 * 1024, maxModelResourceBytes: 16 * 1024 * 1024,
    maxModels: 4096,
  })
  options.signal?.throwIfAborted()
  if (materialized.state !== 'materialized')
    throw new Sc2RuntimeCompositionError('sc2-runtime/uvw-unresolved',
      materialized.refusals ?? [])
  if (materialized.unpackagedModelResourceIds.length
      || materialized.unpackagedWaterResourceIds.length) {
    const unresolved = [...materialized.unpackagedModelResourceIds,
      ...materialized.unpackagedWaterResourceIds]
    throw new Sc2RuntimeCompositionError('sc2-runtime/world-resource-unpackaged', [{
      message: `Selected map has ${unresolved.length} unresolved portable resources: ${
        unresolved.slice(0, 16).join(', ')}${unresolved.length > 16 ? ', …' : ''}`,
    }])
  }
  const artifacts = (family: 'media' | 'uvm') => materialized.manifest.contents
    .filter(item => item.family === family)
    .map(item => {
      const bytes = materialized.entries.get(item.path)
      if (!(bytes instanceof Uint8Array))
        throw new Sc2RuntimeCompositionError('sc2-runtime/world-package-incomplete', [{
          message: `Core world package is missing ${item.path}`,
        }])
      return { path: item.path, bytes }
    })
  return {
    world: materialized.document,
    media: artifacts('media'), models: artifacts('uvm'),
    worldReceipt: {
      presentation: { state: 'packaged' as const },
      artifactDigest: materialized.artifactDigest,
      sourceSnapshotId: materialized.sourceSnapshotId,
      excludedFacetIds: materialized.excludedFacetIds,
      packagedTextureCount: materialized.packagedTextureCount,
      packagedModelCount: materialized.packagedModelCount,
      ...('observedTerrainItems' in materialized && typeof materialized.observedTerrainItems === 'number'
        ? { observedTerrainItems: materialized.observedTerrainItems } : {}),
    },
  }
}

/** Read Galaxy relative to the selected package, or an explicitly nested campaign map.
 * The loaded ModContext alone chooses the source layer and its original path.
 */
export async function readSc2RuntimeGalaxySource({ context, nestedRoot, path, functionName }: {
  readonly context: ModContext; readonly nestedRoot?: NestedRoot | undefined
  readonly path: string; readonly functionName: string
}): Promise<Sc2RuntimeGalaxySource & { readonly layerId: string }> {
  if (!context || typeof context.locate !== 'function'
      || (nestedRoot !== undefined && (typeof nestedRoot?.path !== 'string' || !nestedRoot.path))
      || typeof path !== 'string' || !path || path.startsWith('/') || path.includes('..')
      || path.includes('\\') || typeof functionName !== 'string' || !functionName)
    throw new TypeError('SC2 runtime Galaxy source requires a relative path and function name')
  const logicalPath = nestedRoot === undefined ? path
    : `${nestedRoot.path.replace(/\/$/u, '')}/${path}`
  const located = await context.locate(logicalPath)
  if (!located)
    throw new Sc2RuntimeCompositionError('sc2-runtime/galaxy-source-missing', [{
      message: `Galaxy source ${logicalPath} is not in the selected mod closure`,
    }])
  let bytes
  try { bytes = await context.read(located.layerId, located.path, 1_048_577) }
  catch (error) {
    throw new Sc2RuntimeCompositionError('sc2-runtime/galaxy-source-unreadable', [{
      message: error instanceof Error ? error.message : String(error),
    }])
  }
  if (bytes.length > 1_048_576)
    throw new Sc2RuntimeCompositionError('sc2-runtime/galaxy-source-budget', [{
      message: `Galaxy source ${logicalPath} exceeds 1 MiB`,
    }])
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    fileName: located.path, functionName, layerId: located.layerId } }
  catch {
    throw new Sc2RuntimeCompositionError('sc2-runtime/galaxy-source-encoding', [{
      message: `Galaxy source ${logicalPath} is not valid UTF-8`,
    }])
  }
}

/** The context belongs to the caller; all temporary analyzer and resource leases belong here. */
export async function resolveSc2RuntimeSubject({
  context, services, budgets, unit, additionalUnits = [], quantizeFixed64Decimal,
  nestedRoot, locales = ['enUS'], onStage, signal,
}: Sc2RuntimeResolveRequest) {
  const units = Array.isArray(additionalUnits) ? [unit, ...additionalUnits] : []
  if (!context || !services || !budgets || unit?.namespace !== 'Unit'
    || typeof unit.entityId !== 'string' || !unit.entityId
    || !Array.isArray(additionalUnits) || units.length > 256
    || units.some(ref => ref?.namespace !== 'Unit' || typeof ref.entityId !== 'string' || !ref.entityId)
    || new Set(units.map(ref => ref.entityId)).size !== units.length
    || typeof quantizeFixed64Decimal !== 'function'
    || (onStage !== undefined && typeof onStage !== 'function'))
    throw new TypeError('SC2 runtime composition requires distinct Units, ModContext, host services and exact quantizer')
  let dataInputs
  let mapInputs
  let analyzed
  let mapAnalysis
  const started = performance.now()
  const stage = (name: string) => onStage?.({ name, elapsedMs: Math.round(performance.now() - started) })
  try {
    dataInputs = createModContextDataWorkspaceInputs(context)
    analyzed = await analyzeResolvedDataWorkspace({
      ...(signal === undefined ? {} : { signal }),
      services, grant: { id: 'sc2-runtime-data', classes: [] }, budgets,
      workspace: dataInputs.workspace, resources: dataInputs.resources, locales,
      queries: units, localizationKeys: [],
      limits: { maxRequirements: 512, maxDocumentBytes: 16_777_216,
        maxTextBytes: 268_435_456, maxEntities: 100_000, maxDepth: 128, maxPageSize: 128 },
    })
    if (analyzed.state !== 'resolved')
      throw new Sc2RuntimeCompositionError('sc2-runtime/data-unresolved', analyzed.diagnostics)
    stage('data')
    const unitSlice = lowerSc2UnitSlice(analyzed.snapshot, unit, quantizeFixed64Decimal)
    const unitSlices = additionalUnits.length
      ? lowerSc2UnitSlices(analyzed.snapshot, units, quantizeFixed64Decimal)
      : { kindSchema: unitSlice.kindSchema, definitions: unitSlice.definitions,
          receipts: [unitSlice.receipt] }

    mapInputs = createModContextDataWorkspaceInputs(context,
      nestedRoot === undefined ? {} : { nestedRoot })
    mapAnalysis = await analyzeResolvedMapWorkspace({
      ...(signal === undefined ? {} : { signal }),
      services, grant: { id: 'sc2-runtime-map', classes: [] }, budgets,
      workspace: mapInputs.workspace, resources: mapInputs.resources,
      catalog: analyzed.snapshot,
      limits: { maxRequirements: 16, maxDocumentBytes: 33_554_432,
        maxTotalBytes: 67_108_864, maxObjects: 100_000,
        maxRegions: 10_000, maxTerrainCells: 100_000, maxTerrainSamples: 100_000,
        maxDepth: 64, maxPageSize: 4096, maxDiagnostics: 100 },
    })
    if (mapAnalysis.state !== 'resolved')
      throw new Sc2RuntimeCompositionError('sc2-runtime/map-unresolved', mapAnalysis.diagnostics)
    stage('map')
    const materialized = await materializeSc2RuntimeWorld(mapAnalysis.world.value,
      signal === undefined ? {} : { signal })
    stage('uvw')
    return {
      unitSlice,
      unitSlices,
      ...materialized,
    }
  } finally {
    await Promise.all([
      mapAnalysis?.state === 'resolved' ? mapAnalysis.release() : undefined,
      mapInputs?.resources.dispose(),
      analyzed?.state === 'resolved' ? analyzed.release() : undefined,
      dataInputs?.resources.dispose(),
    ])
    stage('released')
  }
}

/** Join authored native slots to portable player identities; the UVW owner validates other fields. */
export function resolveSc2RuntimePlayerSlots(published: unknown,
  provided?: readonly { readonly slot: string; readonly address: string }[]) {
  const valid = (slots: readonly { readonly slot: string; readonly address: string }[]) =>
    Array.isArray(slots) && slots.length > 0
      && slots.every(item => typeof item?.slot === 'string'
        && /^(?:0|[1-9][0-9]*)$/u.test(item.slot) && Number(item.slot) <= 15
        && typeof item.address === 'string' && !!item.address)
      && new Set(slots.map(item => item.slot)).size === slots.length
      && new Set(slots.map(item => item.address)).size === slots.length
  if (provided !== undefined && !valid(provided))
    throw new TypeError('SC2 runtime preparation requires a unique explicit native-slot roster')
  let authored: { slot: string; address: string }[] | undefined
  if (published !== undefined) {
    if (!Array.isArray(published) || published.some(item => !item || typeof item !== 'object'
        || !Number.isInteger(item.slot) || typeof item.address !== 'string'))
      throw new Sc2RuntimeCompositionError('sc2-runtime/player-roster-invalid', [{ message: 'UVW must publish native slots and portable player addresses.' }])
    authored = published.map(item => ({ slot: String(item.slot), address: item.address as string }))
    if (!valid(authored))
      throw new Sc2RuntimeCompositionError('sc2-runtime/player-roster-invalid', [{ message: 'The admitted SC2 spawn profile needs unique player slots in 0..15.' }])
    const bySlot = new Map(authored.map(item => [item.slot, item.address]))
    if (provided !== undefined && (provided.length !== authored.length
        || provided.some(item => bySlot.get(item.slot) !== item.address)))
      throw new Sc2RuntimeCompositionError('sc2-runtime/player-roster-mismatch', [{ message: 'Explicit SC2 setup must match the selected UVW slot-to-player table.' }])
  }
  const resolved = authored ?? provided
  if (!resolved)
    throw new Sc2RuntimeCompositionError('sc2-runtime/player-roster-missing', [{ message: 'The selected world has no player table; supply an explicit native-slot roster.' }])
  return Object.freeze(resolved.map(item => Object.freeze({ slot: item.slot, address: item.address })))
}

/** Game-owned preparation for one admitted script action and one resolved data/world slice.
 * The caller still compiles Luau and verifies UVP with the universal Multiverse toolchain.
 */
export async function prepareSc2RuntimeInputs({
  context, services, budgets, unit, additionalUnits, quantizeFixed64Decimal, nestedRoot, locales,
  galaxy, spaceId, playerSlots, onStage, signal,
}: Sc2RuntimePrepareRequest) {
  if (typeof galaxy?.text !== 'string' || !galaxy.fileName || !galaxy.functionName)
    throw new TypeError('SC2 runtime preparation requires a selected Galaxy function')
  const suppliedSlots = playerSlots === undefined ? undefined : resolveSc2RuntimePlayerSlots(undefined, playerSlots)
  const analyzed = analyzeGalaxySingleUnitSpawn({
    text: galaxy.text, fileName: galaxy.fileName, functionName: galaxy.functionName,
    quantizeFixed64Decimal,
  })
  const resolved = await resolveSc2RuntimeSubject({
    context, services, budgets, unit, additionalUnits,
    quantizeFixed64Decimal, nestedRoot, locales, onStage, signal,
  })
  const spaces = resolved.world.spaces ?? []
  const space = spaceId ?? (spaces.length === 1 ? spaces[0]?.id : undefined)
  if (!space || !spaces.some(item => item.id === space))
    throw new Sc2RuntimeCompositionError('sc2-runtime/space-ambiguous', [{
      message: 'Select one UVW space for this Galaxy Point before runtime preparation',
    }])
  const selectedSpace = spaces.find(item => item.id === space)!
  const slots = resolveSc2RuntimePlayerSlots((selectedSpace as { readonly players?: unknown }).players, suppliedSlots)
  const lowered = bindGalaxySingleUnitSpawn(analyzed, space, resolved.world, quantizeFixed64Decimal)
  if (lowered.invocation.unit.namespace !== unit.namespace
      || lowered.invocation.unit.entityId !== unit.entityId)
    throw new Sc2RuntimeCompositionError('sc2-runtime/unit-mismatch', [{
      message: `Galaxy creates ${lowered.invocation.unit.entityId}; selected Data unit is ${unit.entityId}`,
    }])
  const playerAddress = slots.find(item => item.slot === lowered.invocation.playerId)?.address
  if (!playerAddress)
    throw new Sc2RuntimeCompositionError('sc2-runtime/player-unmapped', [{
      message: `Galaxy player slot ${lowered.invocation.playerId} has no runtime address`,
    }])
  return { ...resolved,
    playerAddresses: slots.map(item => item.address).sort(),
    lowered: { ...lowered, invocation: { ...lowered.invocation, playerAddress } },
  }
}

/** SC2's contribution to the game-neutral selected-subject Runtime workflow. */
export async function prepareSc2RuntimeProjection(request: Sc2RuntimeProjectionRequest) {
  const sourceFromContext = !('text' in request.galaxy)
  const source = !('text' in request.galaxy)
    ? await readSc2RuntimeGalaxySource({ context: request.context,
      nestedRoot: request.nestedRoot, path: request.galaxy?.path,
      functionName: request.galaxy?.functionName }) : request.galaxy
  const nestedRoot = request.nestedRoot?.path && !request.nestedRoot.parentLayerId
    ? { ...request.nestedRoot,
      ...(sourceFromContext && source.layerId ? { parentLayerId: source.layerId }
        : request.context.layers.at(-1)?.id ? { parentLayerId: request.context.layers.at(-1)!.id } : {}) }
    : request.nestedRoot
  const prepared = await prepareSc2RuntimeInputs({ ...request, nestedRoot, galaxy: source })
  const definitions = prepared.unitSlice.definitions as {
    readonly namespace?: unknown
    readonly definitions?: readonly { readonly kind?: unknown; readonly name?: unknown }[]
  }
  const authored = definitions.definitions?.[0]
  if (typeof definitions.namespace !== 'string' || definitions.definitions?.length !== 1
      || authored?.kind !== 'unit' || typeof authored.name !== 'string')
    throw new Sc2RuntimeCompositionError('sc2-runtime/unit-address-unresolved', [{
      message: 'The resolved Data slice did not publish one addressable Unit definition',
    }])
  const definitionAddress = `${definitions.namespace}/${authored.kind}/${authored.name}`
  const invocation = prepared.lowered.invocation
  return {
    definitions: [
      { path: 'schema.uvd.json', layer: 0, document: prepared.unitSlices.kindSchema },
      { path: 'unit.uvd.json', layer: 1, document: prepared.unitSlices.definitions },
    ],
    world: { path: 'world.uvw.json', document: prepared.world },
    scenarios: prepared.lowered.scenarios,
    media: prepared.media, models: prepared.models,
    scripts: [{ path: 'native.uvb', namespace: 'sc2.native',
      source: { name: source.fileName, language: 'galaxy', text: source.text },
      projection: prepared.lowered }],
    intrinsics: ['entity.create@1', 'scenario.set-var@1', 'scenario.var@1'],
    capabilities: ['mutate', 'read', 'control'],
    playerAddresses: prepared.playerAddresses,
    initialInvocations: [{ entrypoint: 'sc2.native/spawn', arguments: [
      { kind: 'definition', address: definitionAddress },
      { kind: 'player', address: invocation.playerAddress },
    ] }],
    evidence: { data: prepared.unitSlice.receipt, unitData: prepared.unitSlices.receipts,
      world: prepared.worldReceipt,
      invocation },
  }
}
