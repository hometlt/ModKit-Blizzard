import { MAP_PREVIEW_PREPARATION_CONTRACT } from '@modkit/sdk/maps'
import {
  canonicalSc2PackagePath,
  sc2BuiltinDirectDependencies,
} from '../../../mod/shared/workspace/implicit-dependencies.js'

const GAME_ID = 'blizzard/starcraft-2'
const CASC_FORMAT_ID = 'casc'
const PACKED_MAP_FORMAT_ID = 'sc2-map'
const LOOSE_MAP_FORMAT_ID = 'sc2-map-directory'
const INSTALLATION_RESOURCE_RESOLVER_ID = 'modkit.node/game-installation-resource-map-preview'
const SUBJECT_FORMAT_IDS = Object.freeze([
  CASC_FORMAT_ID,
  PACKED_MAP_FORMAT_ID,
  LOOSE_MAP_FORMAT_ID,
])
const MAXIMUM_CANDIDATES = 256
const MAXIMUM_ROOTS = 64
const MAXIMUM_DEPTH = 128
const MAXIMUM_NAMESPACE_ENTRIES = 20_000
const MAXIMUM_LOGICAL_PATH_CHARS = 4_096

const MAP_DOCUMENT_MARKERS = Object.freeze({
  objects: new Set(['objects', 'mapobjects']),
  regions: new Set(['regions']),
  terrain: new Set(['t3heightmap', 'mapheightmap']),
})
const REQUIRED_MAP_DOCUMENT_ROLES = Object.freeze(['objects', 'terrain'])
const NAMESPACE_MARKER_SEARCH_ID = 'sc2-map-marker-documents'
const NAMESPACE_MARKER_BASENAMES = Object.freeze(
  [...new Set(Object.values(MAP_DOCUMENT_MARKERS).flatMap(names => [...names]))].sort(),
)
const DOCUMENT_INFO_ID = 'sc2-map-document-info'
const DOCUMENT_INFO_MAX_BYTES = 1_048_576

export const STARCRAFT2_MAP_PREVIEW_PREPARATION_ID = 'blizzard.starcraft2.map-preview'

function recordOf(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

function positiveLimit(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}`)
  }
  return value
}

function diagnostic(severity, code, message, data) {
  return Object.freeze({
    severity,
    code,
    message,
    ...(data === undefined ? {} : { data: Object.freeze(data) }),
  })
}

function normalizeLogicalPath(value, label) {
  nonEmptyString(value, label)
  const normalized = value.replace(/\\/gu, '/').replace(/^\.\//u, '')
  if (
    normalized.length > MAXIMUM_LOGICAL_PATH_CHARS ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[a-z]:/iu.test(normalized)
  ) {
    throw new TypeError(`${label} must be a confined logical path`)
  }
  const parts = []
  for (const part of normalized.split('/')) {
    if (part.length === 0 || part === '.') continue
    if (part === '..') throw new TypeError(`${label} must not escape the subject namespace`)
    parts.push(part.toLowerCase())
  }
  if (parts.length === 0) throw new TypeError(`${label} must name a logical path`)
  return parts.join('/')
}

function validateRequest(request) {
  const value = recordOf(request)
  if (value === undefined) throw new TypeError('map preview preparation request must be an object')
  const subject = recordOf(value.subject)
  if (subject?.schemaVersion !== 1) {
    throw new TypeError('map preview preparation requires a versioned subject')
  }
  nonEmptyString(subject.subjectUri, 'subject.subjectUri')
  nonEmptyString(subject.revision, 'subject.revision')
  nonEmptyString(subject.formatId, 'subject.formatId')
  if (!Array.isArray(subject.traits)) throw new TypeError('subject.traits must be an array')
  if (!Array.isArray(subject.dataSources)) {
    throw new TypeError('subject.dataSources must be an array')
  }
  if (!Array.isArray(subject.operations)) throw new TypeError('subject.operations must be an array')
  const maxCandidates = positiveLimit(value.maxCandidates, 'maxCandidates', MAXIMUM_CANDIDATES)
  const maxRoots = positiveLimit(value.maxRoots, 'maxRoots', MAXIMUM_ROOTS)
  const maxDepth = positiveLimit(value.maxDepth, 'maxDepth', MAXIMUM_DEPTH)
  if (value.selectionId !== undefined && typeof value.selectionId !== 'string') {
    throw new TypeError('selectionId must be an opaque string when supplied')
  }
  return { ...value, subject, maxCandidates, maxRoots, maxDepth }
}

function validateNamespace(subject) {
  const namespace = recordOf(subject.namespace)
  if (
    namespace === undefined ||
    !['unavailable', 'complete', 'truncated'].includes(String(namespace.state)) ||
    !Array.isArray(namespace.entries)
  ) {
    throw new TypeError('subject.namespace must be a bounded namespace index')
  }
  if (namespace.entries.length > MAXIMUM_NAMESPACE_ENTRIES) {
    return Object.freeze({
      state: 'over-budget',
      entries: Object.freeze([]),
      observed: namespace.entries.length,
    })
  }
  const entries = namespace.entries.map((entry, index) => {
    const item = recordOf(entry)
    if (
      item === undefined ||
      typeof item.path !== 'string' ||
      (item.kind !== 'file' && item.kind !== 'directory') ||
      (item.size !== undefined &&
        (typeof item.size !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(item.size)))
    ) {
      throw new TypeError(`subject.namespace.entries[${index}] is malformed`)
    }
    return item
  })
  return Object.freeze({
    state: namespace.state,
    entries: Object.freeze(entries),
    observed: entries.length,
  })
}

function validateNamespaceSearches(subject) {
  if (subject.namespaceSearches === undefined) return Object.freeze([])
  if (!Array.isArray(subject.namespaceSearches) || subject.namespaceSearches.length > 8) {
    throw new TypeError('subject.namespaceSearches must be a bounded array when supplied')
  }
  let observed = 0
  const searches = subject.namespaceSearches.map((search, searchIndex) => {
    const value = recordOf(search)
    if (
      value === undefined ||
      !Object.keys(value).every(
        key => key === 'searchId' || key === 'state' || key === 'entries',
      ) ||
      typeof value.searchId !== 'string' ||
      value.searchId.length === 0 ||
      value.searchId.length > 512 ||
      value.searchId.includes('\0') ||
      !['unsupported', 'complete', 'truncated'].includes(String(value.state)) ||
      !Array.isArray(value.entries)
    ) {
      throw new TypeError(`subject.namespaceSearches[${searchIndex}] is malformed`)
    }
    const entries = value.entries.map((entry, entryIndex) => {
      const item = recordOf(entry)
      if (
        item === undefined ||
        !Object.keys(item).every(key => key === 'path' || key === 'kind' || key === 'size') ||
        typeof item.path !== 'string' ||
        (item.kind !== 'file' && item.kind !== 'directory') ||
        (item.size !== undefined &&
          (typeof item.size !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(item.size)))
      ) {
        throw new TypeError(
          `subject.namespaceSearches[${searchIndex}].entries[${entryIndex}] is malformed`,
        )
      }
      observed += 1
      if (observed > MAXIMUM_NAMESPACE_ENTRIES) {
        throw new TypeError('subject.namespaceSearches exceed the provider entry budget')
      }
      return item
    })
    return Object.freeze({
      searchId: value.searchId,
      state: value.state,
      entries: Object.freeze(entries),
    })
  })
  if (new Set(searches.map(search => search.searchId)).size !== searches.length) {
    throw new TypeError('subject.namespaceSearches contains duplicate searchId values')
  }
  return Object.freeze(searches)
}

function validateDocumentReads(subject) {
  if (subject.documentReads === undefined) return Object.freeze([])
  if (!Array.isArray(subject.documentReads) || subject.documentReads.length > 8) {
    throw new TypeError('subject.documentReads must be a bounded array when supplied')
  }
  return Object.freeze(
    subject.documentReads.map((document, index) => {
      const value = recordOf(document)
      if (
        value === undefined ||
        !Object.keys(value).every(key => ['documentId', 'path', 'state', 'text'].includes(key)) ||
        typeof value.documentId !== 'string' ||
        typeof value.path !== 'string' ||
        !['read', 'missing', 'too-large', 'unreadable', 'unsupported'].includes(
          String(value.state),
        ) ||
        (value.state === 'read' ? typeof value.text !== 'string' : value.text !== undefined)
      ) {
        throw new TypeError(`subject.documentReads[${index}] is malformed`)
      }
      return value
    }),
  )
}

function mergeNamespaceEntries(...groups) {
  const byIdentity = new Map()
  for (const entries of groups) {
    for (const entry of entries) {
      let identity
      try {
        identity = `${normalizeLogicalPath(entry.path, 'namespace entry path')}\0${entry.kind}`
      } catch {
        identity = `${entry.path}\0${entry.kind}`
      }
      if (!byIdentity.has(identity)) byIdentity.set(identity, entry)
    }
  }
  return Object.freeze([...byIdentity.values()])
}

function hasNamespaceSource(subject) {
  return subject.dataSources.some(item => {
    const value = recordOf(item)
    return value?.contract === 'common.view/namespace-entry-source' && value.major === 1
  })
}

function hasEntryExtraction(subject) {
  return subject.operations.some(item => {
    const value = recordOf(item)
    return value?.id === 'container.extract' && value.state === 'available'
  })
}

function hashText(value) {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

function packedMapDisplayName(subject) {
  const tail = subject.subjectUri.split(/[\\/]/u).at(-1)?.split(/[?#]/u)[0] ?? ''
  if (/\.sc2map$/iu.test(tail)) {
    try {
      return decodeURIComponent(tail)
    } catch {
      return tail
    }
  }
  return 'Opened SC2Map'
}

function documentRole(name) {
  for (const [role, names] of Object.entries(MAP_DOCUMENT_MARKERS)) {
    if (names.has(name)) return role
  }
  return undefined
}

function discoverCandidates(subject, namespace) {
  const markersByRoot = new Map()
  let refusedPaths = 0
  for (const entry of namespace.entries) {
    if (entry.kind !== 'file') continue
    let path
    try {
      path = normalizeLogicalPath(entry.path, 'namespace entry path')
    } catch {
      refusedPaths += 1
      continue
    }
    const slash = path.lastIndexOf('/')
    const root = slash === -1 ? '' : path.slice(0, slash)
    const role = documentRole(slash === -1 ? path : path.slice(slash + 1))
    if (role === undefined) continue
    if (subject.formatId === CASC_FORMAT_ID && !root.endsWith('.sc2map')) continue
    if (subject.formatId === PACKED_MAP_FORMAT_ID && root.length > 0 && !root.endsWith('.sc2map')) {
      continue
    }
    const markers = markersByRoot.get(root) ?? new Set()
    markers.add(role)
    markersByRoot.set(root, markers)
  }

  const candidates = [...markersByRoot.entries()]
    .filter(([, markers]) => REQUIRED_MAP_DOCUMENT_ROLES.every(role => markers.has(role)))
    .map(([namespacePrefix]) => {
      const identityRoot = namespacePrefix.length === 0 ? '<namespace-root>' : namespacePrefix
      const candidateId = `sc2-map:${hashText(
        `${subject.revision}\0${subject.formatId}\0${identityRoot}`,
      )}`
      const standalone =
        (subject.formatId === PACKED_MAP_FORMAT_ID || subject.formatId === LOOSE_MAP_FORMAT_ID) &&
        namespacePrefix.length === 0
      const sourcePath = standalone
        ? `opened/${hashText(`${subject.revision}\0${subject.subjectUri}`)}.sc2map`
        : namespacePrefix
      return Object.freeze({
        candidateId,
        displayName: standalone
          ? packedMapDisplayName(subject)
          : (namespacePrefix.split('/').at(-1) ?? 'SC2Map'),
        sourcePath,
        namespacePrefix,
      })
    })
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath, 'en'))

  if (new Set(candidates.map(item => item.candidateId)).size !== candidates.length) {
    return Object.freeze({ state: 'collision', candidates: Object.freeze([]), refusedPaths })
  }
  return Object.freeze({ state: 'complete', candidates: Object.freeze(candidates), refusedPaths })
}

function selectionCandidates(candidates) {
  return Object.freeze(
    candidates.map(candidate =>
      Object.freeze({
        candidateId: candidate.candidateId,
        displayName: candidate.displayName,
        sourcePath: candidate.sourcePath,
      }),
    ),
  )
}

function graphDependency(targetRootId, ref) {
  return Object.freeze({ targetRootId, ref, required: true, provenance: 'implicit' })
}

function graphRoot(sourceId, rootId, sourcePath, displayName, kind, dependencies = []) {
  return Object.freeze({
    rootId,
    sourceId,
    sourcePath,
    displayName,
    kind,
    dependencies: Object.freeze(dependencies),
  })
}

function decodeXmlText(value) {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
}

function documentInfoDependencies(text) {
  if (text.length > DOCUMENT_INFO_MAX_BYTES) {
    throw new RangeError('DocumentInfo text exceeds the preparation byte limit')
  }
  const block = /<Dependencies\b[^>]*>([\s\S]*?)<\/Dependencies\s*>/iu.exec(text)?.[1] ?? ''
  return Object.freeze(
    [...block.matchAll(/<Value\b[^>]*>([\s\S]*?)<\/Value\s*>/giu)]
      .slice(0, 256)
      .map(match => decodeXmlText(match[1].replace(/<[^>]*>/gu, '').trim()))
      .filter(value => value.length > 0),
  )
}

const STOCK_DEPENDENCY_PATHS = Object.freeze({
  'core (mod)': 'mods/core.sc2mod',
  'liberty (mod)': 'mods/liberty.sc2mod',
  'swarm (mod)': 'mods/swarm.sc2mod',
  'void (mod)': 'mods/void.sc2mod',
  'liberty multi (mod)': 'mods/libertymulti.sc2mod',
  'swarm multi (mod)': 'mods/swarmmulti.sc2mod',
  'void multi (mod)': 'mods/voidmulti.sc2mod',
  'balance multi (mod)': 'mods/balancemulti.sc2mod',
  'liberty (campaign)': 'campaigns/liberty.sc2campaign',
  'swarm (campaign)': 'campaigns/swarm.sc2campaign',
  'void (campaign)': 'campaigns/void.sc2campaign',
})

function dependencyLogicalPath(ref) {
  const lowered = ref.trim().toLocaleLowerCase('en-US')
  if (STOCK_DEPENDENCY_PATHS[lowered] !== undefined) return STOCK_DEPENDENCY_PATHS[lowered]
  const fileRef = /(?:^|,)\s*file:([^,]+)/u.exec(lowered)?.[1]
  const bnetName = /^(?:bnet|battle\.net):([^/]+)(?:\/|$)/u.exec(lowered)?.[1]
  if (
    fileRef === undefined &&
    bnetName !== undefined &&
    STOCK_DEPENDENCY_PATHS[bnetName] !== undefined
  ) {
    return STOCK_DEPENDENCY_PATHS[bnetName]
  }
  if (fileRef === undefined && /^(?:bnet|battle\.net):/u.test(lowered)) return undefined
  let candidate = (fileRef ?? lowered.replace(/^file:/u, ''))
    .replace(/\\/gu, '/')
    .replace(/^\/+|\/+$/gu, '')
  if (!candidate.includes('/')) {
    if (candidate.endsWith('.sc2mod')) candidate = `mods/${candidate}`
    else if (candidate.endsWith('.sc2campaign')) candidate = `campaigns/${candidate}`
  }
  if (!/\.(?:sc2mod|sc2campaign)$/u.test(candidate)) return undefined
  try {
    return normalizeLogicalPath(candidate, 'DocumentInfo dependency')
  } catch {
    return undefined
  }
}

function dependencyDocumentRequest(path) {
  return Object.freeze({
    documentId: `sc2-dependency-document:${hashText(path)}`,
    path: `${path}/documentinfo`,
    maxBytes: DOCUMENT_INFO_MAX_BYTES,
  })
}

function resolveDocumentInfoClosure(directRefs, documentReads, maxPaths) {
  const unresolvedRefs = []
  const unavailableDocuments = []
  const directPaths = []
  for (const ref of directRefs) {
    const path = dependencyLogicalPath(ref)
    if (path === undefined) unresolvedRefs.push(ref)
    else if (!directPaths.includes(path)) directPaths.push(path)
  }
  const allPaths = []
  const dependencyEdges = new Map()
  const pendingDocuments = []
  const queue = [...directPaths]
  while (queue.length > 0) {
    const path = queue.shift()
    if (allPaths.includes(path)) continue
    if (allPaths.length >= maxPaths) {
      return Object.freeze({
        state: 'over-budget',
        observed: allPaths.length + queue.length + 1,
      })
    }
    allPaths.push(path)
    const request = dependencyDocumentRequest(path)
    const document = documentReads.find(
      item => item.documentId === request.documentId && item.path === request.path,
    )
    if (document === undefined) {
      pendingDocuments.push(request)
      continue
    }
    if (document.state !== 'read') {
      unavailableDocuments.push(`${path} (${document.state})`)
      continue
    }
    const targets = []
    for (const ref of documentInfoDependencies(document.text)) {
      const target = dependencyLogicalPath(ref)
      if (target === undefined) unresolvedRefs.push(`${path}: ${ref}`)
      else {
        if (!targets.includes(target)) targets.push(target)
        if (!allPaths.includes(target)) queue.push(target)
      }
    }
    dependencyEdges.set(path, Object.freeze(targets))
  }
  return Object.freeze({
    state: 'resolved',
    directPaths: Object.freeze(directPaths),
    allPaths: Object.freeze(allPaths),
    dependencyEdges,
    pendingDocuments: Object.freeze(pendingDocuments),
    unresolvedRefs: Object.freeze([...new Set(unresolvedRefs)]),
    unavailableDocuments: Object.freeze([...new Set(unavailableDocuments)]),
  })
}

function installedStockRoots(
  subject,
  candidate,
  { allPaths = [], directPaths = [], dependencyEdges = new Map() } = {},
) {
  const sourceId = 'starcraft2-opened-subject'
  const active = graphRoot(sourceId, 'map', candidate.sourcePath, candidate.displayName, 'map')
  if (
    subject.formatId !== CASC_FORMAT_ID &&
    subject.formatId !== PACKED_MAP_FORMAT_ID &&
    subject.formatId !== LOOSE_MAP_FORMAT_ID
  ) {
    return Object.freeze([active])
  }

  const foldedPath = value => String(value).replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '').toLowerCase()
  const canonicalPath = value => canonicalSc2PackagePath(value) ?? value
  // One key for storing a root and for every lookup (edges, targets, direct and campaign roots).
  const rootKey = value => foldedPath(canonicalPath(value))
  const edges = new Map([...dependencyEdges].map(([path, targets]) => [rootKey(path), targets]))
  const rootsByPath = new Map()
  const visiting = new Set()
  const orderedPaths = []
  const append = value => {
    const canonical = canonicalPath(value)
    const path = rootKey(value)
    if (rootsByPath.has(path) || visiting.has(path)) return
    visiting.add(path)
    const declaredTargets = edges.get(path) ?? []
    const implicitTargets = sc2BuiltinDirectDependencies(canonical)
    const targets = [...declaredTargets, ...implicitTargets]
    // Core is the only package the engine loads beneath everything; the rest must be declared.
    if (targets.length === 0 && path !== 'mods/core.sc2mod') targets.push('mods/core.sc2mod')
    for (const target of targets) append(target)
    const basename = canonical.slice(canonical.lastIndexOf('/') + 1)
    const stock = /^(?:mods|campaigns)\/(core|liberty|swarm|void)(story)?\.sc2(mod|campaign)$/u.exec(path)
    const rootId = stock
      ? `stock-${stock[1]}${stock[2] ?? ''}${stock[3] === 'campaign' ? '-campaign' : ''}`
      : `declared-${hashText(path)}`
    const dependencies = targets
      .map(target => rootsByPath.get(rootKey(target)))
      .filter(target => target !== undefined)
      .map(target => graphDependency(target.rootId, target.sourcePath))
    const root = graphRoot(
      sourceId,
      rootId,
      path,
      basename,
      path.endsWith('.sc2campaign') ? 'SC2Campaign' : 'SC2Mod',
      dependencies,
    )
    rootsByPath.set(path, root)
    orderedPaths.push(path)
    visiting.delete(path)
  }

  append('Mods/Core.SC2Mod')
  for (const path of allPaths) append(path)
  for (const path of directPaths) append(path)
  const enclosingCampaign = /^(campaigns\/[^/]+\.sc2campaign)(?:\/|$)/u.exec(
    foldedPath(candidate.sourcePath),
  )?.[1]
  if (enclosingCampaign !== undefined) append(enclosingCampaign)

  const directRoots = directPaths
    .map(path => rootsByPath.get(rootKey(path)))
    .filter(root => root !== undefined)
  const enclosingRoot =
    enclosingCampaign === undefined ? undefined : rootsByPath.get(rootKey(enclosingCampaign))
  const fallbackRoot = rootsByPath.get(rootKey('Mods/Core.SC2Mod'))
  const activeDependencies = [
    ...(directRoots.length > 0
      ? directRoots
      : enclosingRoot !== undefined
        ? [enclosingRoot]
        : fallbackRoot === undefined
          ? []
          : [fallbackRoot]),
  ].map(root => graphDependency(root.rootId, root.sourcePath)).filter(
    (dependency, index, dependencies) =>
      dependencies.findIndex(item => item.targetRootId === dependency.targetRootId) === index,
  )
  return Object.freeze([
    Object.freeze({
      ...active,
      dependencies: Object.freeze(activeDependencies),
    }),
    ...orderedPaths.reverse().map(path => rootsByPath.get(path)),
  ])
}

/**
 * Where a map keeps its assets, as the map codec declares them (codec.json `container.assetRoots`):
 * a map made in the editor carries what it imports at its root, not under Base.SC2Assets, and the
 * catalog still names it `Assets\Textures\x.dds` (base.sc2assets/... here).
 */
const MAP_ASSET_ROOTS = Object.freeze(['Base.SC2Assets', '*.SC2Assets', ''])

function preparedPlan(subject, candidate, dependencies = {}) {
  const roots = installedStockRoots(subject, candidate, dependencies)
  const subjectNamespaceRoots = Object.freeze([
    Object.freeze({
      rootId: 'map',
      namespacePrefix: candidate.namespacePrefix,
      assetRoots: MAP_ASSET_ROOTS,
    }),
  ])
  const externalRoots = Object.freeze(
    roots
      .filter(root => root.rootId !== 'map')
      .map(root =>
        Object.freeze({
          rootId: root.rootId,
          locator: Object.freeze({
            schemaVersion: 1,
            kind: 'game-installation-subject',
            gameId: GAME_ID,
            relativePaths: Object.freeze([root.sourcePath]),
            namespaceFallbackPrefix: root.sourcePath,
            openedSubjectPolicy: 'installation-only',
          }),
        }),
      ),
  )
  const resources =
    subject.formatId !== CASC_FORMAT_ID
      ? Object.freeze({
          schemaVersion: 1,
          strategy: 'host-resolved',
          resolverId: INSTALLATION_RESOURCE_RESOLVER_ID,
          subjectNamespaceRoots,
          roots: externalRoots,
        })
      : Object.freeze({
          schemaVersion: 1,
          strategy: 'subject-namespace',
          roots: Object.freeze(
            roots.map(root =>
              Object.freeze({
                rootId: root.rootId,
                namespacePrefix:
                  root.rootId === 'map' ? candidate.namespacePrefix : root.sourcePath,
              }),
            ),
          ),
        })
  return Object.freeze({
    schemaVersion: 1,
    workspace: Object.freeze({
      workspaceId: `starcraft2-preview-${hashText(candidate.candidateId)}`,
      gameId: GAME_ID,
      activeRootId: 'map',
      sources: Object.freeze([
        Object.freeze({
          sourceId: 'starcraft2-opened-subject',
          kind: `${subject.formatId}-subject`,
          location: 'map-preview:opened-subject',
        }),
      ]),
      roots,
      maxRoots: roots.length,
      maxDepth: roots.length,
    }),
    resources,
  })
}

export async function prepareStarcraft2MapPreview(request) {
  request?.signal?.throwIfAborted()
  const value = validateRequest(request)
  if (!SUBJECT_FORMAT_IDS.includes(value.subject.formatId)) {
    return Object.freeze({
      state: 'not-applicable',
      diagnostics: Object.freeze([
        diagnostic(
          'information',
          'blizzard.starcraft2/map-preview-format-not-applicable',
          `StarCraft II map preparation does not inspect ${value.subject.formatId}`,
        ),
      ]),
    })
  }
  if (!hasNamespaceSource(value.subject)) {
    return Object.freeze({
      state: 'unresolved',
      diagnostics: Object.freeze([
        diagnostic(
          'error',
          'blizzard.starcraft2/map-preview-namespace-unavailable',
          'StarCraft II map preparation requires a bounded namespace-entry source',
        ),
      ]),
    })
  }
  if (!hasEntryExtraction(value.subject)) {
    const standalone = value.subject.formatId === PACKED_MAP_FORMAT_ID
    return Object.freeze({
      state: 'unresolved',
      diagnostics: Object.freeze([
        diagnostic(
          'error',
          standalone
            ? 'blizzard.starcraft2/map-preview-standalone-extraction-unavailable'
            : 'blizzard.starcraft2/map-preview-extraction-unavailable',
          standalone
            ? 'the current packed SC2Map codec lists entries but does not expose container.extract; compressed MPQ document extraction remains a named remainder'
            : 'the opened CASC subject does not expose the container.extract operation required by the map resource session',
        ),
      ]),
    })
  }

  const namespace = validateNamespace(value.subject)
  const namespaceSearches = validateNamespaceSearches(value.subject)
  const documentReads = validateDocumentReads(value.subject)
  if (namespace.state === 'over-budget') {
    return Object.freeze({
      state: 'unresolved',
      diagnostics: Object.freeze([
        diagnostic(
          'error',
          'blizzard.starcraft2/map-preview-namespace-budget-exceeded',
          `subject namespace contains ${namespace.observed} entries but the provider admits at most ${MAXIMUM_NAMESPACE_ENTRIES}`,
          { observed: namespace.observed, maximum: MAXIMUM_NAMESPACE_ENTRIES },
        ),
      ]),
    })
  }
  if (namespace.state === 'unavailable') {
    return Object.freeze({
      state: 'unresolved',
      diagnostics: Object.freeze([
        diagnostic(
          'warning',
          'blizzard.starcraft2/map-preview-namespace-unavailable',
          'the opened subject did not provide namespace facts for SC2 map-root discovery',
        ),
      ]),
    })
  }

  const markerSearch = namespaceSearches.find(
    search => search.searchId === NAMESPACE_MARKER_SEARCH_ID,
  )
  if (value.subject.formatId === CASC_FORMAT_ID && namespace.state === 'truncated') {
    if (markerSearch === undefined) {
      return Object.freeze({
        state: 'namespace-search-required',
        searches: Object.freeze([
          Object.freeze({
            searchId: NAMESPACE_MARKER_SEARCH_ID,
            query: Object.freeze({
              kind: 'basename-any',
              basenames: NAMESPACE_MARKER_BASENAMES,
              caseSensitive: false,
            }),
          }),
        ]),
        diagnostics: Object.freeze([
          diagnostic(
            'information',
            'blizzard.starcraft2/map-preview-indexed-marker-search-required',
            'the bounded CASC root listing is incomplete; requesting one bounded host-owned basename search for map marker documents',
          ),
        ]),
      })
    }
    if (markerSearch.state === 'unsupported') {
      return Object.freeze({
        state: 'unresolved',
        diagnostics: Object.freeze([
          diagnostic(
            'warning',
            'blizzard.starcraft2/map-preview-indexed-marker-search-unsupported',
            'the CASC namespace does not provide the indexed basename search required for bounded map discovery',
          ),
        ]),
      })
    }
  }

  const discoveryNamespace =
    value.subject.formatId === CASC_FORMAT_ID && namespace.state === 'truncated' && markerSearch
      ? Object.freeze({
          state: markerSearch.state,
          entries: mergeNamespaceEntries(namespace.entries, markerSearch.entries),
        })
      : namespace

  const discovered = discoverCandidates(value.subject, discoveryNamespace)
  if (discovered.state === 'collision') {
    return Object.freeze({
      state: 'unresolved',
      diagnostics: Object.freeze([
        diagnostic(
          'error',
          'blizzard.starcraft2/map-preview-candidate-collision',
          'map candidates could not be assigned unique opaque ids without guessing',
        ),
      ]),
    })
  }
  const findings =
    discovered.refusedPaths === 0
      ? []
      : [
          diagnostic(
            'warning',
            'blizzard.starcraft2/map-preview-namespace-paths-refused',
            `${discovered.refusedPaths} unsafe or malformed namespace path(s) were ignored`,
            { refusedPaths: discovered.refusedPaths },
          ),
        ]
  const offeredCandidates = discovered.candidates.slice(0, value.maxCandidates)
  const candidateListTruncated = offeredCandidates.length < discovered.candidates.length
  const selected =
    value.selectionId === undefined
      ? undefined
      : discovered.candidates.find(candidate => candidate.candidateId === value.selectionId)
  if (value.selectionId !== undefined && selected === undefined) {
    return Object.freeze({
      state: 'unresolved',
      diagnostics: Object.freeze([
        ...findings,
        diagnostic(
          'error',
          'blizzard.starcraft2/map-preview-selection-invalid',
          'selectionId does not name a fully observed map root in this exact subject revision',
        ),
      ]),
    })
  }
  if (discovered.candidates.length === 0) {
    return Object.freeze({
      state: discoveryNamespace.state === 'complete' ? 'not-applicable' : 'unresolved',
      diagnostics: Object.freeze([
        ...findings,
        diagnostic(
          discoveryNamespace.state === 'complete' ? 'information' : 'warning',
          discoveryNamespace.state === 'complete'
            ? 'blizzard.starcraft2/map-preview-map-absent'
            : 'blizzard.starcraft2/map-preview-namespace-truncated-prefix-discovery-required',
          discoveryNamespace.state === 'complete'
            ? 'the complete subject namespace contains no root with Objects and t3HeightMap documents'
            : 'the bounded CASC root listing ended before any complete SC2 map root was proved; the host must add a bounded prefix-discovery round before retrying preparation',
          ...(discoveryNamespace.state === 'complete'
            ? []
            : [{ namespaceState: discoveryNamespace.state }]),
        ),
      ]),
    })
  }
  if (
    selected === undefined &&
    (discoveryNamespace.state === 'truncated' || discovered.candidates.length > 1)
  ) {
    return Object.freeze({
      state: 'selection-required',
      candidates: selectionCandidates(offeredCandidates),
      diagnostics: Object.freeze([
        ...findings,
        ...(candidateListTruncated
          ? [
              diagnostic(
                'warning',
                'blizzard.starcraft2/map-preview-candidate-list-truncated',
                `found ${discovered.candidates.length} map roots; this bounded selection page exposes the first ${offeredCandidates.length} stable candidates without choosing one`,
                {
                  observed: discovered.candidates.length,
                  offered: offeredCandidates.length,
                },
              ),
            ]
          : []),
        ...(discoveryNamespace.state === 'truncated'
          ? [
              diagnostic(
                'warning',
                'blizzard.starcraft2/map-preview-namespace-truncated-selection-required',
                'the bounded CASC listing may omit other maps; an observed root must be selected explicitly and is never guessed, while broader choices require a bounded host prefix-discovery round',
                { namespaceState: discoveryNamespace.state },
              ),
            ]
          : []),
      ]),
    })
  }
  const active = selected ?? discovered.candidates[0]
  const documentInfoPath =
    active.namespacePrefix.length === 0 ? 'DocumentInfo' : `${active.namespacePrefix}/documentinfo`
  const documentInfo = documentReads.find(
    document => document.documentId === DOCUMENT_INFO_ID && document.path === documentInfoPath,
  )
  if (documentInfo === undefined) {
    return Object.freeze({
      state: 'document-read-required',
      documents: Object.freeze([
        Object.freeze({
          documentId: DOCUMENT_INFO_ID,
          path: documentInfoPath,
          maxBytes: DOCUMENT_INFO_MAX_BYTES,
        }),
      ]),
      diagnostics: Object.freeze([
        ...findings,
        diagnostic(
          'information',
          'blizzard.starcraft2/map-preview-document-info-required',
          'the host must read the selected map DocumentInfo before its declared dependency graph can be composed',
        ),
      ]),
    })
  }
  if (documentInfo.path !== documentInfoPath) {
    throw new TypeError('subject DocumentInfo read belongs to another selected map root')
  }
  const dependencyRefs =
    documentInfo.state === 'read' ? documentInfoDependencies(documentInfo.text) : Object.freeze([])
  const dependencyClosure = resolveDocumentInfoClosure(
    dependencyRefs,
    documentReads,
    Math.max(1, value.maxRoots - 1),
  )
  if (dependencyClosure.state === 'over-budget') {
    return Object.freeze({
      state: 'unresolved',
      diagnostics: Object.freeze([
        ...findings,
        diagnostic(
          'error',
          'blizzard.starcraft2/map-preview-document-info-closure-over-budget',
          `DocumentInfo dependency closure exceeds the ${value.maxRoots}-root workspace budget`,
          { observed: dependencyClosure.observed, maximum: value.maxRoots },
        ),
      ]),
    })
  }
  if (value.subject.formatId === CASC_FORMAT_ID && dependencyClosure.pendingDocuments.length > 0) {
    return Object.freeze({
      state: 'document-read-required',
      documents: Object.freeze(dependencyClosure.pendingDocuments.slice(0, 8)),
      diagnostics: Object.freeze([
        diagnostic(
          'information',
          'blizzard.starcraft2/map-preview-dependency-document-info-required',
          `${dependencyClosure.pendingDocuments.length} dependency DocumentInfo document(s) remain in the bounded closure`,
        ),
      ]),
    })
  }
  const unresolvedDependencyRefs = dependencyClosure.unresolvedRefs
  const plan = preparedPlan(value.subject, active, {
    allPaths: dependencyClosure.allPaths,
    directPaths: dependencyClosure.directPaths,
    dependencyEdges: dependencyClosure.dependencyEdges,
  })
  const requiredRoots = plan.workspace.roots.length
  const requiredDepth = plan.workspace.maxDepth
  if (value.maxRoots < requiredRoots || value.maxDepth < requiredDepth) {
    return Object.freeze({
      state: 'unresolved',
      diagnostics: Object.freeze([
        ...findings,
        diagnostic(
          'error',
          'blizzard.starcraft2/map-preview-workspace-budget-exceeded',
          `StarCraft II map preparation requires ${requiredRoots} root(s) and dependency depth ${requiredDepth}`,
          {
            requiredRoots,
            requiredDepth,
            maxRoots: value.maxRoots,
            maxDepth: value.maxDepth,
          },
        ),
      ]),
    })
  }

  return Object.freeze({
    state: 'prepared',
    plan,
    diagnostics: Object.freeze([
      ...findings,
      ...(discoveryNamespace.state === 'truncated'
        ? [
            diagnostic(
              'warning',
              'blizzard.starcraft2/map-preview-truncated-selection-confirmed',
              'the selected map root is accepted because all required documents were observed; unseen CASC roots were not inferred',
            ),
          ]
        : []),
      ...(value.subject.formatId === CASC_FORMAT_ID
        ? [
            diagnostic(
              documentInfo.state === 'read' ? 'information' : 'warning',
              documentInfo.state === 'read'
                ? 'blizzard.starcraft2/map-preview-document-info-closure'
                : 'blizzard.starcraft2/map-preview-document-info-unavailable',
              documentInfo.state === 'read'
                ? `the selected installed map is composed with ${dependencyRefs.length} direct reference(s), ${dependencyClosure.allPaths.length} dependency root(s), their bounded DocumentInfo closure and the known stock chain`
                : `DocumentInfo is ${documentInfo.state}; the selected installed map uses only its known stock dependency chain`,
            ),
            ...(unresolvedDependencyRefs.length === 0
              ? []
              : [
                  diagnostic(
                    'warning',
                    'blizzard.starcraft2/map-preview-document-info-dependency-unresolved',
                    `${unresolvedDependencyRefs.length} DocumentInfo dependency reference(s) do not name a confined installed SC2Mod/SC2Campaign path: ${unresolvedDependencyRefs.slice(0, 8).join(', ')}`,
                    { dependencies: unresolvedDependencyRefs.slice(0, 32) },
                  ),
                ]),
            ...(dependencyClosure.unavailableDocuments.length === 0
              ? []
              : [
                  diagnostic(
                    'warning',
                    'blizzard.starcraft2/map-preview-dependency-document-info-unavailable',
                    `${dependencyClosure.unavailableDocuments.length} dependency DocumentInfo document(s) were unavailable: ${dependencyClosure.unavailableDocuments.slice(0, 8).join(', ')}`,
                  ),
                ]),
          ]
        : value.subject.formatId === LOOSE_MAP_FORMAT_ID ||
            value.subject.formatId === PACKED_MAP_FORMAT_ID
          ? [
              diagnostic(
                'information',
                'blizzard.starcraft2/map-preview-installation-resolver-selected',
                dependencyRefs.length === 0
                  ? 'the standalone map declares no external DocumentInfo dependencies; installed stock data remains host-resolved'
                  : `${dependencyRefs.length} standalone-map dependency reference(s) will be resolved against exact installed directories first and the installed CASC namespace second`,
              ),
            ]
          : [
              diagnostic(
                dependencyRefs.length === 0 ? 'information' : 'warning',
                dependencyRefs.length === 0
                  ? 'blizzard.starcraft2/map-preview-document-info-closure'
                  : 'blizzard.starcraft2/map-preview-dependency-resolver-remainder',
                dependencyRefs.length === 0
                  ? 'the standalone map declares no external DocumentInfo dependencies'
                  : `${dependencyRefs.length} standalone-map DocumentInfo dependency reference(s) require an installation-backed resolver`,
              ),
            ]),
    ]),
  })
}

export const abiVersion = 1
export const provides = Object.freeze([MAP_PREVIEW_PREPARATION_CONTRACT])

export function createProvider(selection) {
  if (selection.contract !== MAP_PREVIEW_PREPARATION_CONTRACT || selection.major !== 1) {
    throw new TypeError(
      `unsupported StarCraft II map-preview preparation selection ${selection.contract}@${selection.major}`,
    )
  }
  return Object.freeze({
    value: Object.freeze({
      contract: MAP_PREVIEW_PREPARATION_CONTRACT,
      preparationId: STARCRAFT2_MAP_PREVIEW_PREPARATION_ID,
      subjectFormatIds: SUBJECT_FORMAT_IDS,
      prepare: prepareStarcraft2MapPreview,
    }),
    release: async () => undefined,
  })
}
