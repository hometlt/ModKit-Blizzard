import { createRelationGraphSource, fact, provenanceOf } from '@modkit/codec-kit'
import {
  createTableDataSource,
  parseXmlElements,
} from '../../../shared/inspection/structured-text.js'
import {
  insertCatalogEntityDeclaration,
  patchCatalogField,
  patchCatalogIndexedEntry,
  patchCatalogIndexedEntryRemoval,
} from '../../data/services/editing/catalog-field-patch.js'

const MAP_SUFFIX = '.sc2map'
const MOD_SUFFIX = '.sc2mod'
const CAMPAIGN_DATA_SUFFIX = '/gamedata/campaigndata.xml'
const MAX_CAMPAIGN_DATA_FILES = 16
const MAX_CAMPAIGN_FIELD_CHARS = 4_096

const CAMPAIGN_FIELD = Object.freeze({
  name: Object.freeze({ path: 'Name', property: 'name' }),
  shortName: Object.freeze({ path: 'ShortName', property: 'shortName' }),
  launchMap: Object.freeze({ path: 'CampaignData.LaunchMap', property: 'launchMap' }),
  progressLaunchMap: Object.freeze({ path: 'CampaignData.ProgressLaunchMap', property: 'progressLaunchMap' }),
  tutorialMap: Object.freeze({ path: 'CampaignData.TutorialMap', property: 'tutorialMap' }),
  prerequisiteCampaignId: Object.freeze({ path: 'CampaignData.PrerequisiteCampaignId', property: 'prerequisiteCampaignId' }),
  progressAchievement: Object.freeze({ path: 'CampaignData.ProgressAchievement', property: 'progressAchievement' }),
  saveName: Object.freeze({ path: 'CampaignData.SaveName', property: 'saveName' }),
  completedSaveName: Object.freeze({ path: 'CampaignData.CompletedSaveName', property: 'completedSaveName' }),
  campaignBanks: Object.freeze({ path: 'CampaignData.CampaignBanks', property: 'campaignBanks', array: true }),
  transitionBanks: Object.freeze({ path: 'CampaignData.TransitionBanks', property: 'transitionBanks', array: true }),
})

const normalize = value => String(value).replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
const fold = value => normalize(value).toLowerCase()
const basename = value => normalize(value).split('/').at(-1) ?? value

function decodeXmlAttribute(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
}

function packageRoot(path, suffix) {
  const parts = normalize(path).split('/')
  const index = parts.findIndex(part => part.toLowerCase().endsWith(suffix))
  return index < 0 ? undefined : parts.slice(0, index + 1).join('/')
}

function packages(entries, suffix) {
  const byId = new Map()
  for (const entry of entries) {
    const root = packageRoot(entry.path, suffix)
    if (root === undefined) continue
    const id = fold(root)
    const current = byId.get(id) ?? {
      path: root,
      files: 0,
      directories: 0,
      packed: false,
      markers: new Set(),
    }
    if (entry.kind === 'file') current.files += 1
    else current.directories += 1
    if (fold(entry.path) === id && entry.kind === 'file') current.packed = true
    const relative = normalize(entry.path).slice(root.length).replace(/^\//u, '').toLowerCase()
    if (relative !== '') current.markers.add(relative.split('/').at(-1))
    byId.set(id, current)
  }
  return [...byId.values()]
    .sort((left, right) => fold(left.path).localeCompare(fold(right.path)))
    .map(item => Object.freeze({
      id: `${suffix === MAP_SUFFIX ? 'campaign-mission' : 'campaign-layer'}:${encodeURIComponent(fold(item.path))}`,
      path: item.path,
      label: basename(item.path).replace(new RegExp(`${suffix}$`, 'iu'), ''),
      topology: item.packed ? 'packed' : 'directory',
      files: item.files,
      directories: item.directories,
      ...(suffix === MAP_SUFFIX
        ? {
            documents: Object.freeze({
              mapInfo: item.markers.has('mapinfo'),
              objects: item.markers.has('objects') || item.markers.has('mapobjects'),
              regions: item.markers.has('regions') || item.markers.has('mapregions'),
              height: item.markers.has('t3heightmap') || item.markers.has('mapheightmap'),
            }),
          }
        : {
            role: basename(item.path).toLowerCase() === 'campaign.sc2mod'
              ? 'campaign-data'
              : 'shared-layer',
          }),
    }))
}

function values(elements, name, depth) {
  return elements
    .filter(element => element.depth === depth && element.name === name)
    .map(element => element.attributes.value)
    .filter(value => value !== undefined)
    .map(decodeXmlAttribute)
}

function field(elements, name, depth, owner) {
  const nested = values(elements, name, depth).at(-1)
  if (nested !== undefined) return nested
  const attribute = owner?.attributes?.[name]
  return attribute === undefined ? undefined : decodeXmlAttribute(attribute)
}

function campaignRecords(elements, sourcePath) {
  const records = []
  for (let index = 0; index < elements.length; index += 1) {
    const declaration = elements[index]
    if (declaration.depth !== 1 || declaration.name !== 'CCampaign') continue
    const id = declaration.attributes.id === undefined
      ? undefined
      : decodeXmlAttribute(declaration.attributes.id)
    if (id === undefined || id === '') continue
    let end = index + 1
    while (end < elements.length && elements[end].depth > declaration.depth) end += 1
    const body = elements.slice(index + 1, end)
    const campaignDataIndex = body.findIndex(
      element => element.depth === 2 && element.name === 'CampaignData',
    )
    const campaignDataElement = campaignDataIndex < 0 ? undefined : body[campaignDataIndex]
    let campaignData = []
    if (campaignDataIndex >= 0) {
      let campaignDataEnd = campaignDataIndex + 1
      while (
        campaignDataEnd < body.length &&
        body[campaignDataEnd].depth > body[campaignDataIndex].depth
      ) campaignDataEnd += 1
      campaignData = body.slice(campaignDataIndex + 1, campaignDataEnd)
    }
    records.push(Object.freeze({
      id,
      sourcePath,
      ...(declaration.attributes.parent === undefined
        ? {}
        : { parent: decodeXmlAttribute(declaration.attributes.parent) }),
      ...(field(body, 'Name', 2, declaration) === undefined
        ? {}
        : { name: field(body, 'Name', 2, declaration) }),
      ...(field(body, 'ShortName', 2, declaration) === undefined
        ? {}
        : { shortName: field(body, 'ShortName', 2, declaration) }),
      ...(field(campaignData, 'LaunchMap', 3, campaignDataElement) === undefined
        ? {}
        : { launchMap: field(campaignData, 'LaunchMap', 3, campaignDataElement) }),
      ...(field(campaignData, 'ProgressLaunchMap', 3, campaignDataElement) === undefined
        ? {}
        : { progressLaunchMap: field(campaignData, 'ProgressLaunchMap', 3, campaignDataElement) }),
      ...(field(campaignData, 'TutorialMap', 3, campaignDataElement) === undefined
        ? {}
        : { tutorialMap: field(campaignData, 'TutorialMap', 3, campaignDataElement) }),
      campaignBanks: Object.freeze(values(campaignData, 'CampaignBanks', 3)),
      transitionBanks: Object.freeze(values(campaignData, 'TransitionBanks', 3)),
      ...(field(campaignData, 'PrerequisiteCampaignId', 3, campaignDataElement) === undefined
        ? {}
        : { prerequisiteCampaignId: field(campaignData, 'PrerequisiteCampaignId', 3, campaignDataElement) }),
      ...(field(campaignData, 'ProgressAchievement', 3, campaignDataElement) === undefined
        ? {}
        : { progressAchievement: field(campaignData, 'ProgressAchievement', 3, campaignDataElement) }),
      ...(field(campaignData, 'SaveName', 3, campaignDataElement) === undefined
        ? {}
        : { saveName: field(campaignData, 'SaveName', 3, campaignDataElement) }),
      ...(field(campaignData, 'CompletedSaveName', 3, campaignDataElement) === undefined
        ? {}
        : { completedSaveName: field(campaignData, 'CompletedSaveName', 3, campaignDataElement) }),
    }))
    index = end - 1
  }
  return records
}

function missionForLaunchMap(missions, launchMap) {
  const target = fold(launchMap).replace(/^file:/u, '')
  const targetWithSuffix = target.endsWith(MAP_SUFFIX) ? target : `${target}${MAP_SUFFIX}`
  const targetName = basename(targetWithSuffix)
  return missions.find(mission => {
    const path = fold(mission.path)
    return path.endsWith(targetWithSuffix) || basename(path) === targetName
  })
}

async function inspectCampaignCatalog(context, missions) {
  const candidates = context.entries.filter(entry =>
    entry.kind === 'file' && fold(entry.path).endsWith(CAMPAIGN_DATA_SUFFIX),
  )
  const diagnostics = []
  const records = []
  if (candidates.length > MAX_CAMPAIGN_DATA_FILES) {
    diagnostics.push(Object.freeze({
      id: 'sc2-campaign-data-file-budget',
      code: 'blizzard/sc2-campaign-data-file-budget',
      category: 'budget',
      severity: 'warning',
      message: `Only the first ${MAX_CAMPAIGN_DATA_FILES} CampaignData.xml files were inspected`,
    }))
  }
  for (const entry of candidates.slice(0, MAX_CAMPAIGN_DATA_FILES)) {
    context.context.signal?.throwIfAborted()
    try {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(
        await context.readEntry(entry.path),
      )
      const elements = parseXmlElements(
        text,
        context.context.budget,
        'Catalog',
        `SC2 CampaignData (${entry.path})`,
      )
      records.push(...campaignRecords(elements, entry.path))
    } catch (error) {
      diagnostics.push(Object.freeze({
        id: `sc2-campaign-data-unreadable:${encodeURIComponent(fold(entry.path))}`,
        code: 'blizzard/sc2-campaign-data-unreadable',
        category: 'structure',
        severity: 'warning',
        message: `${entry.path} could not be summarized: ${error instanceof Error ? error.message : String(error)}`,
      }))
    }
  }
  const campaigns = records.map(record => Object.freeze({
    ...record,
    launchMaps: Object.freeze([
      record.launchMap,
      record.progressLaunchMap,
      record.tutorialMap,
    ].filter(path => path !== undefined).map(path => {
      const mission = missionForLaunchMap(missions, path)
      return Object.freeze({ path, ...(mission === undefined ? {} : { missionId: mission.id }) })
    })),
  }))
  const hasExplicitProgressData = campaigns.some(campaign =>
    campaign.prerequisiteCampaignId !== undefined ||
    campaign.progressAchievement !== undefined ||
    campaign.launchMaps.length > 0,
  )
  return Object.freeze({
    files: Object.freeze(candidates.map(entry => entry.path)),
    campaigns: Object.freeze(campaigns),
    diagnostics: Object.freeze(diagnostics),
    progression: hasExplicitProgressData
      ? Object.freeze({
          state: 'partial',
          basis: 'CampaignData',
          reason: 'Campaign-level prerequisites and launch maps are known; mission ordering remains scenario-defined',
        })
      : Object.freeze({
          state: 'unresolved',
          reason: 'CampaignData does not declare mission ordering or unlock semantics',
        }),
  })
}

function editRequest(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('campaign data edit requires an object')
  }
  const campaignId = input.campaignId
  const fieldId = input.field
  const value = input.value
  const sourcePath = input.sourcePath
  const index = input.index
  if (typeof campaignId !== 'string' || campaignId.length === 0 || campaignId.length > 256) {
    throw new TypeError('campaignId must be a non-empty string of at most 256 characters')
  }
  if (typeof fieldId !== 'string' || CAMPAIGN_FIELD[fieldId] === undefined) {
    throw new TypeError(`field must be one of: ${Object.keys(CAMPAIGN_FIELD).join(', ')}`)
  }
  const field = CAMPAIGN_FIELD[fieldId]
  if (field.array === true && (!Number.isSafeInteger(index) || index < 0)) {
    throw new TypeError('index must be a non-negative safe integer for campaign bank fields')
  }
  if (field.array !== true && index !== undefined) {
    throw new TypeError('index is accepted only for campaign bank fields')
  }
  if (
    value !== null &&
    (typeof value !== 'string' || value.length > MAX_CAMPAIGN_FIELD_CHARS || value.includes('\0'))
  ) {
    throw new TypeError(`value must be null or a string of at most ${MAX_CAMPAIGN_FIELD_CHARS} characters`)
  }
  if (sourcePath !== undefined && typeof sourcePath !== 'string') {
    throw new TypeError('sourcePath must be a string when supplied')
  }
  return Object.freeze({ campaignId, fieldId, value, sourcePath, index })
}

function campaignArrayElement(elements, campaignId, elementName, index) {
  const declarationIndex = elements.findIndex(element =>
    element.depth === 1 &&
    element.name === 'CCampaign' &&
    decodeXmlAttribute(element.attributes.id ?? '') === campaignId,
  )
  if (declarationIndex < 0) return undefined
  let end = declarationIndex + 1
  while (end < elements.length && elements[end].depth > 1) end += 1
  const body = elements.slice(declarationIndex + 1, end)
  const campaignDataIndex = body.findIndex(element =>
    element.depth === 2 && element.name === 'CampaignData',
  )
  if (campaignDataIndex < 0) return undefined
  let dataEnd = campaignDataIndex + 1
  while (dataEnd < body.length && body[dataEnd].depth > 2) dataEnd += 1
  const items = body.slice(campaignDataIndex + 1, dataEnd)
    .filter(element => element.depth === 3 && element.name === elementName)
  return items.find(element => element.attributes.index === String(index)) ?? items[index]
}

export function parseCampaignDataText(text, budget, sourcePath = 'CampaignData.xml') {
  return Object.freeze(campaignRecords(
    parseXmlElements(text, budget, 'Catalog', `SC2 CampaignData (${sourcePath})`),
    sourcePath,
  ))
}

export function patchCampaignDataText(text, budget, input, sourcePath = 'CampaignData.xml') {
  const request = editRequest(input)
  if (request.sourcePath !== undefined && fold(request.sourcePath) !== fold(sourcePath)) {
    throw new TypeError(`sourcePath ${request.sourcePath} does not name the opened CampaignData.xml`)
  }
  if (!parseCampaignDataText(text, budget, sourcePath).some(item => item.id === request.campaignId)) {
    throw new RangeError(`CCampaign ${request.campaignId} was not found`)
  }
  const field = CAMPAIGN_FIELD[request.fieldId]
  const patch = field.array === true
    ? request.value === null
      ? patchCatalogIndexedEntryRemoval(
          text,
          'CCampaign',
          request.campaignId,
          field.path,
          request.index,
        )
      : patchCatalogIndexedEntry(
          text,
          'CCampaign',
          request.campaignId,
          field.path,
          request.index,
          request.value,
        )
    : patchCatalogField(text, 'CCampaign', request.campaignId, field.path, request.value)
  if (!patch.changed) throw new TypeError(patch.reason ?? `${field.path} already has the requested value`)
  const elements = parseXmlElements(
    patch.text,
    budget,
    'Catalog',
    `SC2 CampaignData (${sourcePath})`,
  )
  const parsed = campaignRecords(elements, sourcePath).find(item => item.id === request.campaignId)
  const arrayElement = field.array === true
    ? campaignArrayElement(elements, request.campaignId, field.path.split('.').at(-1), request.index)
    : undefined
  const verified = field.array === true
    ? request.value === null
      ? arrayElement?.attributes.removed === '1'
      : decodeXmlAttribute(arrayElement?.attributes.value ?? '') === request.value
    : parsed?.[field.property] === (request.value ?? undefined)
  if (!verified) {
    throw new TypeError(`CampaignData writer failed to verify ${request.campaignId}.${request.fieldId}`)
  }
  return Object.freeze({
    text: patch.text,
    semanticPath: Object.freeze([
      'Campaign',
      request.campaignId,
      field.path,
      ...(field.array === true ? [String(request.index)] : []),
    ]),
    label: `set CCampaign ${request.campaignId}.${field.path}`,
  })
}

export function declareCampaignDataText(text, budget, input, sourcePath = 'CampaignData.xml') {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('campaign declaration requires an object')
  }
  const campaignId = input.campaignId
  if (typeof campaignId !== 'string' || campaignId.length === 0 || campaignId.length > 256) {
    throw new TypeError('campaignId must be a non-empty string of at most 256 characters')
  }
  if (campaignId.includes('\0')) throw new TypeError('campaignId cannot contain NUL')
  if (parseCampaignDataText(text, budget, sourcePath).some(item => item.id === campaignId)) {
    throw new TypeError(`CCampaign ${campaignId} is already declared`)
  }
  const patch = insertCatalogEntityDeclaration(text, 'CCampaign', campaignId)
  if (!patch.changed) throw new TypeError(patch.reason ?? `CCampaign ${campaignId} could not be declared`)
  if (!parseCampaignDataText(patch.text, budget, sourcePath).some(item => item.id === campaignId)) {
    throw new TypeError(`CampaignData writer failed to verify declaration of ${campaignId}`)
  }
  return Object.freeze({
    text: patch.text,
    semanticPath: Object.freeze(['Campaign', campaignId]),
    label: `declare CCampaign ${campaignId}`,
  })
}

function campaignTreeFields(item) {
  return Object.entries(CAMPAIGN_FIELD).flatMap(([fieldId, field]) => {
    const value = item[field.property]
    if (field.array === true) {
      return (value ?? []).map((entry, index) => Object.freeze({
        kind: 'campaign-data-field',
        label: `${fieldId}[${index}]`,
        preview: String(entry),
        semanticPath: Object.freeze(['Campaign', item.id, field.path, String(index)]),
      }))
    }
    return value === undefined ? [] : [Object.freeze({
      kind: 'campaign-data-field',
      label: fieldId,
      preview: String(value),
      semanticPath: Object.freeze(['Campaign', item.id, field.path]),
    })]
  })
}

/** Project one native SC2Campaign namespace into a source-independent campaign inventory. */
export async function extendCampaignInspection(context) {
  context.context.signal?.throwIfAborted()
  const missions = packages(context.entries, MAP_SUFFIX)
  const layers = packages(context.entries, MOD_SUFFIX)
  const catalog = await inspectCampaignCatalog(context, missions)
  const campaignId = context.root.id
  const campaignNodes = catalog.campaigns.map(item => Object.freeze({
    id: `campaign-catalog:${encodeURIComponent(item.id.toLowerCase())}`,
    label: item.id,
    type: 'sc2-campaign-catalog-entry',
  }))
  const externalPrerequisites = [...new Set(catalog.campaigns
    .map(item => item.prerequisiteCampaignId)
    .filter(id => id !== undefined && !catalog.campaigns.some(item => item.id === id)))]
    .map(id => Object.freeze({
      id: `campaign-catalog:${encodeURIComponent(id.toLowerCase())}`,
      label: id,
      type: 'external-sc2-campaign',
    }))
  const nodes = [
    ...context.bankSemantic.nodes,
    ...missions.map(item => Object.freeze({ id: item.id, label: item.label, type: 'campaign-mission' })),
    ...layers.map(item => Object.freeze({ id: item.id, label: item.label, type: 'campaign-shared-layer' })),
    ...campaignNodes,
    ...externalPrerequisites,
  ]
  const edges = [
    ...context.bankSemantic.edges,
    ...missions.map(item => Object.freeze({ from: campaignId, to: item.id, role: 'contains-mission' })),
    ...layers.map(item => Object.freeze({ from: campaignId, to: item.id, role: item.role })),
    ...catalog.campaigns.map(item => Object.freeze({
      from: campaignId,
      to: `campaign-catalog:${encodeURIComponent(item.id.toLowerCase())}`,
      role: 'defines-campaign',
    })),
    ...catalog.campaigns.flatMap(item => {
      const from = `campaign-catalog:${encodeURIComponent(item.id.toLowerCase())}`
      return [
        ...(item.prerequisiteCampaignId === undefined ? [] : [Object.freeze({
          from,
          to: `campaign-catalog:${encodeURIComponent(item.prerequisiteCampaignId.toLowerCase())}`,
          role: 'requires-campaign',
        })]),
        ...item.launchMaps.flatMap(launch => launch.missionId === undefined ? [] : [Object.freeze({
          from,
          to: launch.missionId,
          role: 'launches-mission',
        })]),
      ]
    }),
  ]
  const model = Object.freeze({
    schemaVersion: 1,
    campaignId,
    missions: Object.freeze(missions),
    sharedLayers: Object.freeze(layers),
    catalog: Object.freeze({ files: catalog.files, campaigns: catalog.campaigns }),
    progression: catalog.progression,
  })
  const campaignFacts = Object.freeze([
    fact(context.root, 'mission-count', 'Missions', missions.length, ['campaign', 'missions']),
    fact(context.root, 'shared-layer-count', 'Shared layers', layers.length, ['campaign', 'sharedLayers']),
    fact(context.root, 'mission-paths', 'Mission packages', missions.map(item => item.path), ['campaign', 'missions']),
    fact(context.root, 'catalog-entry-count', 'Campaign catalog entries', catalog.campaigns.length, ['campaign', 'catalog']),
    fact(context.root, 'progression-state', 'Progression state', model.progression.state, ['campaign', 'progression']),
  ])
  const factRelations = Object.freeze([
    ...missions.map((item, index) => Object.freeze({
      role: 'contains-mission',
      subjectId: item.id,
      label: item.label,
      kind: 'campaign-mission',
      provenance: provenanceOf(context.root, ['campaign', 'missions', String(index)]),
    })),
    ...layers.map((item, index) => Object.freeze({
      role: item.role,
      subjectId: item.id,
      label: item.label,
      kind: 'campaign-shared-layer',
      provenance: provenanceOf(context.root, ['campaign', 'sharedLayers', String(index)]),
    })),
    ...catalog.campaigns.map((item, index) => Object.freeze({
      role: 'defines-campaign',
      subjectId: `campaign-catalog:${encodeURIComponent(item.id.toLowerCase())}`,
      label: item.id,
      kind: 'sc2-campaign-catalog-entry',
      provenance: provenanceOf(context.root, ['campaign', 'catalog', 'campaigns', String(index)]),
    })),
  ])
  return Object.freeze({
    summary: Object.freeze({
      campaignMissions: missions.length,
      campaignSharedLayers: layers.length,
      campaignProgression: model.progression.state,
    }),
    metadata: Object.freeze([Object.freeze({
      id: 'sc2-campaign-model',
      label: 'SC2 campaign model',
      entries: Object.freeze([
        Object.freeze({ key: 'missions', value: missions.length }),
        Object.freeze({ key: 'sharedLayers', value: layers.length }),
        Object.freeze({ key: 'catalogEntries', value: catalog.campaigns.length }),
        Object.freeze({ key: 'progression', value: model.progression.state }),
      ]),
    })]),
    traits: Object.freeze([]),
    treeNodes: Object.freeze([
      Object.freeze({
        kind: 'campaign-missions',
        label: 'Missions',
        preview: `${missions.length} mission package(s)`,
        children: missions.map(item => Object.freeze({
          kind: 'campaign-mission',
          label: item.label,
          preview: `${item.topology}: ${item.path}`,
          semanticPath: Object.freeze(['campaign', 'missions', item.id]),
        })),
      }),
      Object.freeze({
        kind: 'campaign-layers',
        label: 'Shared layers',
        preview: `${layers.length} SC2Mod package(s)`,
        children: layers.map(item => Object.freeze({
          kind: 'campaign-shared-layer',
          label: item.label,
          preview: `${item.role}: ${item.path}`,
          semanticPath: Object.freeze(['campaign', 'sharedLayers', item.id]),
        })),
      }),
      Object.freeze({
        kind: 'campaign-catalog',
        label: 'Campaign data',
        preview: `${catalog.campaigns.length} CCampaign record(s)`,
        children: catalog.campaigns.map(item => Object.freeze({
          kind: 'campaign-catalog-entry',
          label: item.id,
          preview: `${item.launchMaps.length} launch map(s), ${item.campaignBanks.length + item.transitionBanks.length} bank(s)`,
          semanticPath: Object.freeze(['Campaign', item.id]),
          children: Object.freeze(campaignTreeFields(item)),
        })),
      }),
    ]),
    factGroups: Object.freeze([Object.freeze({ id: 'campaign', label: 'Campaign', facts: campaignFacts })]),
    factRelations,
    dataSources: Object.freeze({
      'common.view/table-data-source': createTableDataSource(
        ['Mission', 'Path', 'Topology', 'Files', 'MapInfo', 'Objects', 'Regions', 'Height'],
        missions.map(item => [
          item.label,
          item.path,
          item.topology,
          item.files,
          item.documents.mapInfo,
          item.documents.objects,
          item.documents.regions,
          item.documents.height,
        ]),
      ),
      'common.view/relation-graph-source': createRelationGraphSource({
        snapshotId: context.revision,
        nodes,
        edges,
        completeness: 'partial',
        reason: model.progression.reason,
      }),
    }),
    handlers: Object.freeze({
      'inspect-missions': async () => Object.freeze({ kind: 'json', value: model }),
    }),
    unsupportedFeatures: Object.freeze([
      ...(model.progression.state === 'unresolved' ? ['campaign-progression-not-decoded'] : []),
      'campaign-mission-order-is-scenario-defined',
      'campaign-scenario-unlock-editing-not-advertised',
    ]),
    diagnostics: catalog.diagnostics,
  })
}

export const campaignOperations = contributionId => Object.freeze([
  Object.freeze({
    id: `${contributionId}.inspect-missions`,
    handlerId: 'inspect-missions',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
])

export const CAMPAIGN_OPERATIONS = campaignOperations('blizzard/sc2-campaign')
