const DEFAULT_MAXIMUM_UNITS = 10_000
const DEFAULT_MAXIMUM_DEFINITIONS = 100_000
const DEFAULT_PAGE_SIZE = 1_000

function recordOf(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function positiveLimit(value, fallback, maximum, label) {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new RangeError(`${label} must be a positive integer no greater than ${maximum}`)
  }
  return resolved
}

function indexedEntries(value) {
  if (Array.isArray(value)) return value
  const record = recordOf(value)
  return record === undefined ? [] : [record]
}

function enabledFlag(value, name) {
  return indexedEntries(value).some(entry => {
    const item = recordOf(entry)
    return item?.index === name && item.value !== 0 && item.value !== '0' && item.removed !== true
  })
}

function hasWeapon(value) {
  if (Array.isArray(value)) return value.some(item => item !== null && item !== undefined)
  return recordOf(value) !== undefined
}

function indexedNumber(value, name) {
  for (const entry of indexedEntries(value)) {
    const item = recordOf(entry)
    if (item?.index !== name || item.removed === true) continue
    const number = Number(item.value ?? 0)
    return Number.isFinite(number) && number >= 0 ? number : 0
  }
  return 0
}

/** Classify one resolved CUnit without depending on the SC2 Data implementation. */
export function classifyResolvedReplayUnit(fields) {
  const unit = recordOf(fields)
  if (unit === undefined) return 'other'
  if (enabledFlag(unit.FlagArray, 'Worker')) return 'worker'
  if (enabledFlag(unit.Attributes, 'Structure')) return 'building'
  if (hasWeapon(unit.WeaponArray)) return 'army'
  return 'other'
}

/**
 * Convert the public resolved-data snapshot shape into the bounded lookup maps accepted by
 * analyzeReplay. Format-specific catalog resolution stays in the Data provider.
 */
export function replayCatalogLookups(snapshot, options = {}) {
  const value = recordOf(snapshot)
  if (value === undefined || !Array.isArray(value.definitions)) {
    throw new TypeError('resolved data snapshot must contain definitions')
  }
  if (value.gameId !== undefined && value.gameId !== 'blizzard/starcraft-2') {
    throw new TypeError(`replay catalog enrichment cannot consume ${String(value.gameId)}`)
  }
  const maxUnits = positiveLimit(
    options.maxUnits,
    DEFAULT_MAXIMUM_UNITS,
    DEFAULT_MAXIMUM_UNITS,
    'maxUnits',
  )
  const unitClass = Object.create(null)
  const unitCost = Object.create(null)
  let units = 0
  let completeUnits = 0
  let pricedUnits = 0
  for (const definition of value.definitions) {
    const entity = recordOf(definition)
    if (entity?.namespace !== 'Unit' || typeof entity.entityId !== 'string') continue
    units += 1
    if (units > maxUnits) throw new RangeError(`resolved catalog exceeds ${maxUnits} Unit entries`)
    if (entity.complete !== false) completeUnits += 1
    const fields = recordOf(entity.fields) ?? {}
    unitClass[entity.entityId] = classifyResolvedReplayUnit(fields)
    const minerals = indexedNumber(fields.CostResource, 'Minerals')
    const gas = indexedNumber(fields.CostResource, 'Vespene')
    if (minerals !== 0 || gas !== 0) {
      unitCost[entity.entityId] = Object.freeze({ minerals, gas })
      pricedUnits += 1
    }
  }
  const frozenClasses = Object.freeze(unitClass)
  const frozenCosts = Object.freeze(unitCost)
  return Object.freeze({
    unitClass: frozenClasses,
    unitCost: frozenCosts,
    summary: Object.freeze({
      ...(typeof value.snapshotId === 'string' ? { snapshotId: value.snapshotId } : {}),
      units,
      completeUnits,
      pricedUnits,
      complete: value.complete !== false && completeUnits === units,
    }),
  })
}

/** Read the same lookups through common.data/resolved-workspace@1's public definition table. */
export async function loadReplayCatalogLookups(workspace, request) {
  if (typeof workspace?.openDefinitionTable !== 'function') {
    throw new TypeError('resolved data workspace has no definition-table projection')
  }
  if (typeof request?.snapshotId !== 'string' || request.snapshotId.length === 0) {
    throw new TypeError('catalog enrichment requires snapshotId')
  }
  const maxDefinitions = positiveLimit(
    request.maxDefinitions,
    DEFAULT_MAXIMUM_DEFINITIONS,
    DEFAULT_MAXIMUM_DEFINITIONS,
    'maxDefinitions',
  )
  const maxPageSize = positiveLimit(
    request.maxPageSize,
    DEFAULT_PAGE_SIZE,
    DEFAULT_PAGE_SIZE,
    'maxPageSize',
  )
  const lease = await workspace.openDefinitionTable({
    snapshotId: request.snapshotId,
    maxPageSize,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
  try {
    const source = lease?.value
    if (typeof source?.shape !== 'function' || typeof source?.rows !== 'function') {
      throw new TypeError('resolved definition table is unavailable')
    }
    const shape = await source.shape()
    if (!Number.isSafeInteger(shape?.rows) || shape.rows < 0 || shape.rows > maxDefinitions) {
      throw new RangeError(`resolved definition table exceeds ${maxDefinitions} rows`)
    }
    const header = Array.isArray(shape.header) ? shape.header : []
    const namespaceColumn = header.indexOf('namespace')
    const idColumn = header.indexOf('id')
    const fieldsColumn = header.indexOf('fields')
    const completeColumn = header.indexOf('complete')
    if ([namespaceColumn, idColumn, fieldsColumn].some(index => index < 0)) {
      throw new TypeError('resolved definition table lacks namespace, id or fields columns')
    }
    const definitions = []
    for (let from = 0; from < shape.rows; from += maxPageSize) {
      request.signal?.throwIfAborted()
      const page = await source.rows(
        { kind: 'range', from, count: Math.min(maxPageSize, shape.rows - from) },
        request.signal,
      )
      for (const row of page.items ?? []) {
        if (row?.cells?.[namespaceColumn] !== 'Unit') continue
        const entityId = row.cells[idColumn]
        if (typeof entityId !== 'string' || entityId.length === 0) continue
        let fields
        try {
          fields = JSON.parse(row.cells[fieldsColumn])
        } catch (error) {
          throw new TypeError(
            `resolved Unit/${entityId} fields are not JSON: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        definitions.push({
          namespace: 'Unit',
          entityId,
          fields,
          complete: completeColumn < 0 || row.cells[completeColumn] === 'true',
        })
      }
    }
    return replayCatalogLookups(
      {
        schemaVersion: 1,
        gameId: 'blizzard/starcraft-2',
        snapshotId: request.snapshotId,
        definitions,
        complete: true,
      },
      { maxUnits: request.maxUnits },
    )
  } finally {
    await lease.release()
  }
}
