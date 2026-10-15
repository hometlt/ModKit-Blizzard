import { canonicalJsonStringify } from '@modkit/core'

import { SC2_PLAYABLE_RUNTIME_PROFILE } from './playable.js'

const GAME_ID = 'blizzard/starcraft-2'
const REQUIRED_FIELDS = Object.freeze(['LifeMax', 'Speed', 'Food'])
const encoder = new TextEncoder()

const recordOf = value =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined

function immutableJson(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableJson))
  const record = recordOf(value)
  if (record !== undefined) {
    return Object.freeze(
      Object.fromEntries(Object.entries(record).map(([key, item]) => [key, immutableJson(item)])),
    )
  }
  return value
}

export class Sc2PlayableCatalogBridgeError extends TypeError {
  constructor(code, subject, message) {
    super(message)
    this.name = 'Sc2PlayableCatalogBridgeError'
    this.code = code
    this.subject = subject
  }
}

function refusal(code, subject, message) {
  throw new Sc2PlayableCatalogBridgeError(code, subject, message)
}

function exactRequest(request) {
  const value = recordOf(request)
  if (
    value === undefined ||
    Object.keys(value).length !== 2 ||
    !('unitIds' in value) ||
    !('randomSeed' in value) ||
    !Array.isArray(value.unitIds) ||
    value.unitIds.length === 0 ||
    !value.unitIds.every(
      unitId => typeof unitId === 'string' && unitId.length > 0 && unitId.length <= 256,
    ) ||
    new Set(value.unitIds).size !== value.unitIds.length ||
    !Number.isSafeInteger(value.randomSeed) ||
    value.randomSeed < 0
  ) {
    refusal(
      'sc2-runtime.catalog/invalid-request',
      'request',
      'SC2 playable catalog bridge requires exact unique unitIds and a non-negative randomSeed',
    )
  }
  return value
}

function exactSource(source, unitKey) {
  const value = recordOf(source)
  if (
    value === undefined ||
    typeof value.rootId !== 'string' ||
    value.rootId.length === 0 ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    !Number.isSafeInteger(value.documentIndex) ||
    value.documentIndex < 0 ||
    (value.revision !== undefined && typeof value.revision !== 'string')
  ) {
    refusal(
      'sc2-runtime.catalog/provenance-missing',
      unitKey,
      `${unitKey} requires exact resolved rootId/path/documentIndex provenance`,
    )
  }
  return immutableJson({
    rootId: value.rootId,
    path: value.path,
    documentIndex: value.documentIndex,
    ...(value.revision === undefined ? {} : { revision: value.revision }),
  })
}

function exactField(entity, fieldId, sources, unitKey) {
  if (!(fieldId in entity.fields)) {
    refusal(
      'sc2-runtime.catalog/field-missing',
      `${unitKey}.${fieldId}`,
      `${unitKey}.${fieldId} is required by the playable runtime bridge`,
    )
  }
  const value = entity.fields[fieldId]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    refusal(
      'sc2-runtime.catalog/field-invalid',
      `${unitKey}.${fieldId}`,
      `${unitKey}.${fieldId} must be an exact finite resolved number`,
    )
  }
  if ((fieldId === 'LifeMax' || fieldId === 'Speed') && value < 0) {
    refusal(
      'sc2-runtime.catalog/field-invalid',
      `${unitKey}.${fieldId}`,
      `${unitKey}.${fieldId} must be non-negative`,
    )
  }
  return Object.freeze({ fieldId, value, sources })
}

/**
 * Product-owned seam from a host-produced dependency-merged SC2 snapshot to the bounded
 * playable definition. Only exact resolved Unit fields cross the seam. Life starts at
 * LifeMax as an engine spawn rule; no LifeStart catalog value is claimed or synthesized.
 */
export function createSc2PlayableCatalogDefinition(snapshot, request) {
  const value = recordOf(snapshot)
  const selection = exactRequest(request)
  if (
    value === undefined ||
    value.gameId !== GAME_ID ||
    typeof value.workspaceId !== 'string' ||
    value.workspaceId.length === 0 ||
    typeof value.snapshotId !== 'string' ||
    value.snapshotId.length === 0 ||
    typeof value.complete !== 'boolean' ||
    !Array.isArray(value.definitions) ||
    !Array.isArray(value.diagnostics) ||
    !value.diagnostics.every(item => recordOf(item) !== undefined && typeof item.code === 'string')
  ) {
    refusal(
      'sc2-runtime.catalog/invalid-snapshot',
      'snapshot',
      'SC2 playable catalog bridge requires a host resolved-workspace snapshot',
    )
  }

  const catalog = {}
  const units = []
  for (const unitId of [...selection.unitIds].sort()) {
    const unitKey = `Unit/${unitId}`
    const matches = value.definitions.filter(
      entity => entity.namespace === 'Unit' && entity.entityId === unitId,
    )
    if (matches.length !== 1) {
      refusal(
        'sc2-runtime.catalog/unit-missing',
        unitKey,
        `${unitKey} must resolve exactly once in the dependency-merged snapshot`,
      )
    }
    const entity = matches[0]
    if (
      entity.typeId !== 'CUnit' ||
      entity.complete !== true ||
      recordOf(entity.fields) === undefined
    ) {
      refusal(
        'sc2-runtime.catalog/unit-incomplete',
        unitKey,
        `${unitKey} must be one complete resolved CUnit`,
      )
    }
    if (!Array.isArray(entity.sources) || entity.sources.length === 0) {
      refusal(
        'sc2-runtime.catalog/provenance-missing',
        unitKey,
        `${unitKey} has no resolved source provenance`,
      )
    }
    const sources = Object.freeze(entity.sources.map(source => exactSource(source, unitKey)))
    const usedFields = Object.freeze(
      REQUIRED_FIELDS.map(fieldId => exactField(entity, fieldId, sources, unitKey)),
    )
    catalog[unitKey] = Object.fromEntries(usedFields.map(field => [field.fieldId, field.value]))
    units.push(
      Object.freeze({
        unitId,
        typeId: entity.typeId,
        entityComplete: true,
        usedFields,
      }),
    )
  }

  const definition = immutableJson({
    schemaVersion: 1,
    profile: SC2_PLAYABLE_RUNTIME_PROFILE,
    tickRate: 16,
    randomSeed: selection.randomSeed,
    catalog,
  })
  const receipt = immutableJson({
    schemaVersion: 1,
    gameId: value.gameId,
    workspaceId: value.workspaceId,
    snapshotId: value.snapshotId,
    workspaceStatus: value.complete ? 'complete' : 'partial',
    diagnosticCodes: value.diagnostics.map(item => item.code).sort(),
    units,
    spawnSemantics: 'full-life-from-LifeMax',
  })
  return Object.freeze({
    definition,
    bytes: encoder.encode(canonicalJsonStringify(definition)),
    receipt,
  })
}
