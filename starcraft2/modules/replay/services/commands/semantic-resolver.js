const DEFAULT_MAXIMUM_ABILITIES = 100_000
const DEFAULT_MAXIMUM_DEFINITIONS = 100_000
const DEFAULT_PAGE_SIZE = 1_000

const recordOf = value =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined

function positiveLimit(value, fallback, maximum, label) {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new RangeError(`${label} must be a positive integer no greater than ${maximum}`)
  }
  return resolved
}

function catalogLink(value) {
  if (typeof value === 'string') return value || undefined
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const link = catalogLink(value[index])
      if (link !== undefined) return link
    }
    return undefined
  }
  return catalogLink(recordOf(value)?.value)
}

function indexedInfo(fields, indexName) {
  const raw = fields.InfoArray
  const mapped = recordOf(raw)
  if (mapped !== undefined && mapped[indexName] !== undefined) return recordOf(mapped[indexName])
  for (const value of Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) {
    const entry = recordOf(value)
    if (entry?.index === indexName) return entry
  }
  return undefined
}

function numberedCommand(prefix, index, firstIndex) {
  const number = index - firstIndex + 1
  return number >= 1 && number <= 30 ? `${prefix}${number}` : undefined
}

function pointCommand(intent, kind, unitType) {
  if (intent.target.kind !== 'point') return undefined
  if (kind === 'move') {
    return { kind, unitTags: intent.unitTags, x: intent.target.x, y: intent.target.y }
  }
  return unitType === undefined
    ? undefined
    : {
        kind,
        unitTags: intent.unitTags,
        unitType,
        x: intent.target.x,
        y: intent.target.y,
      }
}

function smartCommand(intent, ability) {
  if (ability.name !== '' || ability.buttonName !== 'Smart') return undefined
  if (intent.target.kind === 'point') {
    return {
      kind: 'smart',
      unitTags: intent.unitTags,
      x: intent.target.x,
      y: intent.target.y,
    }
  }
  if (
    intent.target.kind === 'unit' &&
    intent.target.x !== undefined &&
    intent.target.y !== undefined
  ) {
    return {
      kind: 'smart',
      unitTags: intent.unitTags,
      targetTag: intent.target.tag,
      x: intent.target.x,
      y: intent.target.y,
    }
  }
  return undefined
}

function catalogCommand(intent, ability, entity) {
  if (entity === undefined) return undefined
  const fields = recordOf(entity.fields) ?? {}
  switch (entity.typeId) {
    case 'CAbilMove':
      if (ability.index === 0) return pointCommand(intent, 'move')
      return ability.index === 2 ? { kind: 'hold', unitTags: intent.unitTags } : undefined
    case 'CAbilStop':
      return ability.index === 0 ? { kind: 'stop', unitTags: intent.unitTags } : undefined
    case 'CAbilAttack':
      return ability.index === 0 && intent.target.kind === 'unit'
        ? { kind: 'attack', unitTags: intent.unitTags, targetTag: intent.target.tag }
        : undefined
    case 'CAbilHarvest':
      return ability.index === 0 && intent.target.kind === 'unit'
        ? { kind: 'harvest', unitTags: intent.unitTags, targetTag: intent.target.tag }
        : undefined
    case 'CAbilTrain':
    case 'CAbilWarpTrain': {
      const indexName = numberedCommand('Train', ability.index, 1)
      const unitType = catalogLink(indexedInfo(fields, indexName)?.Unit)
      return unitType === undefined
        ? undefined
        : { kind: 'train', structureTags: intent.unitTags, unitType }
    }
    case 'CAbilBuild': {
      const indexName = numberedCommand('Build', ability.index, 1)
      return pointCommand(intent, 'build', catalogLink(indexedInfo(fields, indexName)?.Unit))
    }
    case 'CAbilResearch': {
      const indexName = numberedCommand('Research', ability.index, 0)
      const upgrade = catalogLink(indexedInfo(fields, indexName)?.Upgrade)
      return upgrade === undefined
        ? undefined
        : { kind: 'research', structureTags: intent.unitTags, upgrade }
    }
    default:
      return undefined
  }
}

export function parseReplayStableAbilities(stableIds, options = {}) {
  const abilities = recordOf(stableIds)?.Abilities
  if (!Array.isArray(abilities)) throw new TypeError('stableIds must contain an Abilities array')
  const maximum = positiveLimit(
    options.maxStableAbilities,
    DEFAULT_MAXIMUM_ABILITIES,
    DEFAULT_MAXIMUM_ABILITIES,
    'maxStableAbilities',
  )
  if (abilities.length > maximum) throw new RangeError(`stableIds exceeds ${maximum} abilities`)
  const result = new Map()
  for (let entryIndex = 0; entryIndex < abilities.length; entryIndex += 1) {
    const raw = recordOf(abilities[entryIndex])
    const id = raw?.id
    const index = raw?.index
    if (
      !Number.isSafeInteger(id) ||
      id < 0 ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      typeof raw.name !== 'string'
    ) {
      throw new TypeError(`stableIds Abilities[${entryIndex}] is malformed`)
    }
    if (result.has(id)) throw new TypeError(`stableIds contains duplicate ability id ${id}`)
    result.set(
      id,
      Object.freeze({
        id,
        index,
        name: raw.name,
        ...(typeof raw.buttonname === 'string' && raw.buttonname.length > 0
          ? { buttonName: raw.buttonname }
          : {}),
      }),
    )
  }
  return result
}

export function createReplaySemanticCommandResolver(stableIds, catalog, options = {}) {
  const abilities = parseReplayStableAbilities(stableIds, options)
  const entities = catalog instanceof Map ? catalog : new Map()
  return Object.freeze({
    stableAbilityCount: abilities.size,
    catalogAbilityCount: entities.size,
    resolve(intent) {
      const reference = intent?.ability
      if (reference === undefined) return undefined
      const ability = abilities.get(reference.link)
      if (ability === undefined || ability.index !== reference.commandIndex) return undefined
      return smartCommand(intent, ability) ?? catalogCommand(intent, ability, entities.get(ability.name))
    },
  })
}

export async function loadReplayAbilityCatalog(workspace, request) {
  if (typeof workspace?.openDefinitionTable !== 'function') {
    throw new TypeError('resolved data workspace has no definition-table projection')
  }
  if (typeof request?.snapshotId !== 'string' || request.snapshotId.length === 0) {
    throw new TypeError('command semantics require snapshotId')
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
  const maxAbilities = positiveLimit(
    request.maxAbilities,
    DEFAULT_MAXIMUM_ABILITIES,
    DEFAULT_MAXIMUM_ABILITIES,
    'maxAbilities',
  )
  const lease = await workspace.openDefinitionTable({
    snapshotId: request.snapshotId,
    maxPageSize,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
  try {
    const source = lease?.value
    const shape = await source?.shape?.()
    if (!Number.isSafeInteger(shape?.rows) || shape.rows < 0 || shape.rows > maxDefinitions) {
      throw new RangeError(`resolved definition table exceeds ${maxDefinitions} rows`)
    }
    const header = Array.isArray(shape.header) ? shape.header : []
    const namespaceColumn = header.indexOf('namespace')
    const typeColumn = header.indexOf('type')
    const idColumn = header.indexOf('id')
    const fieldsColumn = header.indexOf('fields')
    if ([namespaceColumn, typeColumn, idColumn, fieldsColumn].some(index => index < 0)) {
      throw new TypeError('resolved definition table lacks ability columns')
    }
    const abilities = new Map()
    for (let from = 0; from < shape.rows; from += maxPageSize) {
      request.signal?.throwIfAborted()
      const page = await source.rows(
        { kind: 'range', from, count: Math.min(maxPageSize, shape.rows - from) },
        request.signal,
      )
      for (const row of page.items ?? []) {
        if (row?.cells?.[namespaceColumn] !== 'Abil') continue
        const entityId = row.cells[idColumn]
        const typeId = row.cells[typeColumn]
        if (typeof entityId !== 'string' || typeof typeId !== 'string') continue
        if (abilities.size >= maxAbilities) {
          throw new RangeError(`resolved catalog exceeds ${maxAbilities} Abil entries`)
        }
        abilities.set(entityId, {
          typeId,
          fields: JSON.parse(row.cells[fieldsColumn]),
        })
      }
    }
    return abilities
  } finally {
    await lease.release()
  }
}
