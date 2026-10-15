/**
 * Packed and directory SC2 mod codecs: marker detection, semantic inspection/resources,
 * comparison, native/JSON export and revision-bound edits through existing module owners.
 * Probes load only namespace/metadata helpers; models and authoring implementations load when
 * inspection or the corresponding operation needs them. Both representations share this codec.
 */
import { ModkitError, operationId } from '@modkit/core'
import type {
  ArtifactByteSource,
  AssetNamespace,
  ContributionContext,
  JsonValue,
  OperationDecl,
  OperationOutput,
  RevisionId,
  SubjectCatalogPort,
} from '@modkit/sdk'
import { isJsonSerializable } from '@modkit/codec-kit'
import { namespaceEntryEditTarget } from '@modkit/sdk'
import {
  createInspectionCodec,
  simpleLease,
  type NamespaceInspectionCodecDefinition,
  type NamespaceInspectionContext,
  type NamespaceInspectionResult,
} from '@modkit/codec-kit'
import type { SC2Mod } from '../../../shared/core/index.js'
import { isSemanticModEntry } from '../../../shared/core/document-routes.js'
import {
  sc2BuiltinDocumentInfo,
  sc2InstallationDependencies,
} from '../../../shared/workspace/implicit-dependencies.js'
import {
  addTextLocaleToComponentList,
  componentListHasLocale,
} from '../../document-metadata/core/component-list.js'
import { createSc2NamespaceDefinition } from '../../../../../shared/package-namespace/runtime.js'

const PACKED_ID = 'blizzard/sc2-mod'
const LOOSE_ID = 'blizzard/sc2-mod-directory'
const ROOT = 'namespace:Active.SC2Mod'
const COMPONENT_LIST = 'ComponentList.SC2Components'
const utf8 = new TextDecoder('utf-8', { fatal: false })
const encoder = new TextEncoder()

/** The `edit-structure` (add-locale) input: a locale code, optionally the strings file stem. */
function addLocaleRequest(input: JsonValue): {
  readonly locale: string
  readonly fileStem?: string
} {
  const value = (
    input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  ) as Readonly<Record<string, JsonValue>>
  const locale = value['locale']
  const fileStem = value['fileStem']
  if (typeof locale !== 'string' || locale.trim() === '') {
    throw new TypeError('sc2-mod add-locale needs a non-empty string `locale`')
  }
  if (fileStem !== undefined && typeof fileStem !== 'string') {
    throw new TypeError('sc2-mod add-locale `fileStem` must be a string')
  }
  return fileStem === undefined ? { locale } : { locale, fileStem }
}

export const SC2_MOD_OPERATION_MAP = Object.freeze({
  'view.inspect': { id: 'view.inspect', handlerId: 'inspect', outputKinds: ['json'] },
  'asset.compare': { id: 'asset.compare', handlerId: 'compare', outputKinds: ['json'] },
  'asset.validate': { id: 'asset.validate', handlerId: 'validate', outputKinds: ['json'] },
  'container.extract': {
    id: 'container.extract',
    handlerId: 'extract-entry',
    outputKinds: ['bytes'],
  },
  'edit.structure': {
    id: 'edit.structure',
    handlerId: 'edit-structure',
    outputKinds: ['edit-plan'],
  },
  'export.convert': { id: 'export.convert', handlerId: 'export-convert', outputKinds: ['json'] },
  // An entity field written into the mod file that declares it (parity plan 5.3).
  'edit.field': { id: 'edit.field', handlerId: 'edit-field', outputKinds: ['edit-plan'] },
} as const)

export const SC2_MOD_OPERATION_MAP_VERSION = 1

type NamespaceEntry = Readonly<{
  id: string
  path: string
  name: string
  kind: 'file' | 'directory'
  size?: bigint
}>

type NamespaceBytes = Readonly<{
  kind: string
  size?: bigint
  ref: Readonly<{ id: string; uri: string; parentIds?: readonly [string, ...string[]] }>
  revision: RevisionId
  read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array>
}>

type ExtensionContext = Readonly<{
  entries: readonly NamespaceEntry[]
  namespace: Readonly<{
    open(
      path: string,
      signal?: AbortSignal,
    ): Promise<Readonly<{ value: NamespaceBytes; release(): Promise<void> }>>
  }>
  context: Readonly<{
    budget: Readonly<{
      maxScalarBytes: number | bigint
      maxInputBytes: number | bigint
      maxNodes: number
      maxDepth: number
    }>
    signal?: AbortSignal
  }>
  root: Readonly<{ id: string; uri: string; parentIds?: readonly [string, ...string[]] }>
  revision: string
  readEntry(path: string, limit?: number | bigint, signal?: AbortSignal): Promise<Uint8Array>
}>

interface ParseFailure {
  readonly path: string
  readonly message: string
}

interface ParsedMod {
  readonly files: ReadonlyMap<string, Uint8Array>
  readonly mod: SC2Mod
  readonly failures: readonly ParseFailure[]
  readonly dependencies: readonly string[]
}

function portable(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return String(value)
  if (value instanceof Uint8Array) return { bytes: [...value] }
  if (Array.isArray(value)) return value.map(portable)
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()]
        .map(([key, item]) => [String(key), portable(item)] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    )
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
      if (item !== undefined) result[key] = portable(item)
    }
    return result
  }
  return String(value)
}

function json(value: unknown): OperationOutput {
  const valueJson = portable(value)
  if (!isJsonSerializable(valueJson))
    throw new TypeError('SC2 mod operation produced non-JSON data')
  return { kind: 'json', value: valueJson }
}

function normalizePath(value: string): string {
  const path = value.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  if (path.includes('\0') || path.split('/').some(part => part === '..')) {
    throw new TypeError('SC2 mod path is not confined')
  }
  return path
}

type NamespaceDetection = Readonly<{
  confidence: number
  kind?: 'structure' | 'context' | 'extension' | 'magic' | 'companion' | 'user-override'
  note?: string
}>

async function detectSc2ModNamespaceMarkers(
  markers: readonly Readonly<{
    path: string
    kind: 'file' | 'directory'
  }>[],
  uri: string,
): Promise<NamespaceDetection> {
  const normalized = new Map(
    markers.map(marker => [normalizePath(marker.path).toLowerCase(), marker.kind]),
  )
  const mapMarker = [...normalized].some(
    ([path, kind]) =>
      kind === 'file' &&
      [
        'mapinfo',
        'objects',
        'mapobjects',
        'regions',
        'mapregions',
        't3heightmap',
        'mapheightmap',
      ].includes(path.split('/').at(-1) ?? ''),
  )
  const campaign = normalized.get('base.sc2maps') === 'directory'
  const flatGameData = normalized.get('gamedata') === 'directory'
  const packagedGameData = normalized.get('base.sc2data') === 'directory'
  const documentInfo = normalized.get('documentinfo') === 'file'
  const componentList = normalized.get(COMPONENT_LIST.toLowerCase()) === 'file'
  const sc2ModUri = /\.sc2mod$/iu.test(uri.replaceAll('\\', '/').replace(/\/+$/u, ''))
  if (sc2ModUri && documentInfo && flatGameData && !componentList && !mapMarker && !campaign) {
    return {
      confidence: 0.9,
      kind: 'structure' as const,
      note: 'mod:document-info + mod:data-directory + .sc2mod',
    }
  }
  return sc2ModUri && packagedGameData && !mapMarker && !campaign
    ? {
        confidence: 0.85,
        kind: 'structure' as const,
        note: 'installed-mod:base.sc2data + .sc2mod',
      }
    : {
        confidence: 0,
        kind: 'structure' as const,
        note: 'sc2-mod-directory-markers-missing',
      }
}

async function componentListFallback(
  namespace: AssetNamespace,
  context: NamespaceInspectionContext,
): Promise<'flat' | 'packaged' | undefined> {
  let flatGameData = false
  let packagedGameData = false
  let componentList = false
  let documentInfo = false
  let mapMarker = false
  let campaign = false
  let visited = 0
  for await (const entry of namespace.list('', context.signal)) {
    context.signal?.throwIfAborted()
    if (++visited > 512) break
    const path = normalizePath(entry.path).toLowerCase()
    if (path === 'gamedata' && entry.kind === 'directory') flatGameData = true
    if (path === 'base.sc2data' && entry.kind === 'directory') packagedGameData = true
    if (path === COMPONENT_LIST.toLowerCase() && entry.kind === 'file') componentList = true
    if (path === 'documentinfo' && entry.kind === 'file') documentInfo = true
    if (path === 'base.sc2maps' && entry.kind === 'directory') campaign = true
    if (
      entry.kind === 'file' &&
      [
        'mapinfo',
        'objects',
        'mapobjects',
        'regions',
        'mapregions',
        't3heightmap',
        'mapheightmap',
      ].includes(path)
    )
      mapMarker = true
  }
  const uri = context.input.root.uri.replaceAll('\\', '/').replace(/\/+$/u, '')
  if (!/\.sc2mod$/iu.test(uri) || componentList || mapMarker || campaign) return undefined
  if (documentInfo && flatGameData) return 'flat'
  return packagedGameData ? 'packaged' : undefined
}

function legacyFlatNamespace(
  namespace: AssetNamespace,
  context: NamespaceInspectionContext,
): AssetNamespace {
  const bytes = encoder.encode(
    '<?xml version="1.0" encoding="utf-8"?>\n<Components><DataComponent Type="gada">GameData</DataComponent></Components>\n',
  )
  const root = context.input.root
  const separator = root.uri.includes('?') ? '&' : '?'
  const ref = Object.freeze({
    id: `${root.id}?vfs-path=${encodeURIComponent(COMPONENT_LIST)}`,
    uri: `${root.uri}${separator}vfs-path=${encodeURIComponent(COMPONENT_LIST)}`,
    parentIds: Object.freeze([...(root.parentIds ?? []), root.id]) as readonly [
      string,
      ...string[],
    ],
  })
  const source: ArtifactByteSource = Object.freeze({
    kind: 'bytes',
    ref,
    revision: namespace.revision,
    size: BigInt(bytes.byteLength),
    async read(offset: bigint, length: number, signal?: AbortSignal) {
      signal?.throwIfAborted()
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream(
      _range?: { readonly offset: bigint; readonly length?: bigint },
      signal?: AbortSignal,
    ) {
      signal?.throwIfAborted()
      yield bytes
    },
  })
  return Object.freeze({
    revision: namespace.revision,
    async *list(prefix: string, signal?: AbortSignal) {
      for await (const entry of namespace.list(prefix, signal)) yield entry
      if (normalizePath(prefix) === '') {
        yield Object.freeze({
          path: COMPONENT_LIST,
          kind: 'file' as const,
          size: BigInt(bytes.byteLength),
        })
      }
    },
    open(path: string, signal?: AbortSignal) {
      return normalizePath(path).toLowerCase() === COMPONENT_LIST.toLowerCase()
        ? Promise.resolve(simpleLease(source))
        : namespace.open(path, signal)
    },
  })
}

function documentDependencies(files: ReadonlyMap<string, Uint8Array>): readonly string[] {
  const entry = [...files].find(([path]) => path.toLowerCase() === 'documentinfo')
  if (entry === undefined) return Object.freeze([])
  const dependencies: string[] = []
  for (const match of utf8.decode(entry[1]).matchAll(/<Value(?:\s[^>]*)?>([^<]+)<\/Value>/giu)) {
    const value = match[1]?.trim().replace(/^file:/iu, '')
    if (value !== undefined && /\.sc2(?:mod|campaign)(?:\/|$)/iu.test(value))
      dependencies.push(value)
  }
  return Object.freeze([...new Set(dependencies)])
}

async function parseNamespace(extension: ExtensionContext): Promise<ParsedMod> {
  const { readSc2ModOfFiles } = await import('../../../shared/core/mod-of-files.js')
  extension.context.signal?.throwIfAborted()
  const files = new Map<string, Uint8Array>()
  const failures: ParseFailure[] = []
  let total = 0
  const maximum = Math.min(Number(extension.context.budget.maxInputBytes), Number.MAX_SAFE_INTEGER)
  const paths = extension.entries
    .filter(entry => entry.kind === 'file')
    .map(entry => normalizePath(entry.path))
    .filter(isSemanticModEntry)
  // The loader already owns the listing; overlap worker/VFS reads while retaining its file order.
  for (let start = 0; start < paths.length; start += 8) {
    extension.context.signal?.throwIfAborted()
    const batch = await Promise.all(
      paths.slice(start, start + 8).map(async path => {
        try {
          return {
            path,
            bytes: await extension.readEntry(
              path,
              extension.context.budget.maxScalarBytes,
              extension.context.signal,
            ),
          }
        } catch (error) {
          return { path, error: error instanceof Error ? error.message : String(error) }
        }
      }),
    )
    for (const result of batch) {
      if (result.bytes === undefined) {
        failures.push({ path: result.path, message: result.error ?? 'read failed' })
        continue
      }
      total += result.bytes.byteLength
      if (total > maximum) throw new RangeError('SC2 mod namespace exceeds the input byte budget')
      files.set(result.path, result.bytes)
    }
  }
  let mod: SC2Mod
  try {
    mod = await readSc2ModOfFiles(files, ROOT)
  } catch (error) {
    failures.push({ path: ROOT, message: error instanceof Error ? error.message : String(error) })
    throw error
  }
  return Object.freeze({
    files,
    mod,
    failures: Object.freeze(failures),
    dependencies: documentDependencies(files),
  })
}

function operationDecls(id: string, packed: boolean): readonly OperationDecl[] {
  const native = (
    Object.entries(SC2_MOD_OPERATION_MAP) as Array<
      [
        keyof typeof SC2_MOD_OPERATION_MAP,
        (typeof SC2_MOD_OPERATION_MAP)[keyof typeof SC2_MOD_OPERATION_MAP],
      ]
    >
  )
    .filter(([operation]) => operation !== 'container.extract')
    .map(([operation, mapping]) => {
      const mutatesSource = operation === 'edit.structure' || operation === 'edit.field'
      return Object.freeze({
        id: operationId(mapping.id, { contributionId: id }),
        handlerId: mapping.handlerId,
        mutatesSource,
        requiredPermissions: Object.freeze(
          mutatesSource ? (['read-source', 'write-source'] as const) : (['read-source'] as const),
        ),
        outputKinds: Object.freeze(mapping.outputKinds),
      }) satisfies OperationDecl
    })
  return Object.freeze([
    ...native,
    ...(packed
      ? [
          Object.freeze({
            id: operationId('export.raw', { contributionId: id }),
            handlerId: 'export-raw',
            mutatesSource: false,
            requiredPermissions: Object.freeze(['read-source'] as const),
            outputKinds: Object.freeze(['bytes'] as const),
          }) satisfies OperationDecl,
        ]
      : []),
  ])
}

async function openEntry(extension: ExtensionContext, path: string) {
  const lease = await extension.namespace.open(path, extension.context.signal)
  try {
    if (lease.value.kind !== 'bytes' || lease.value.size === undefined)
      throw new TypeError(`${path} is not a sized byte entry`)
    const size = Number(lease.value.size)
    if (!Number.isSafeInteger(size) || size > Number(extension.context.budget.maxScalarBytes)) {
      throw new RangeError(`${path} exceeds the scalar byte budget`)
    }
    const bytes = await lease.value.read(0n, size, extension.context.signal)
    return Object.freeze({ ref: lease.value.ref, revision: lease.value.revision, bytes })
  } finally {
    await lease.release()
  }
}

function entryRevision(source: Awaited<ReturnType<typeof openEntry>>) {
  return Object.freeze({
    bindings: Object.freeze({ content: source.revision }),
    namespaceRevision: source.revision,
    compositionFingerprint: `namespace-entry:${String(source.revision)}:${source.ref.id}`,
  })
}

function createExtension(catalog: SubjectCatalogPort | undefined, loose: boolean) {
  return async function extendModInspection(extension: ExtensionContext) {
    const parsed = await parseNamespace(extension)
    const [{ gameDataNamespaceSummaries, collectModEntities }, { modCardFacts, modResourceTree }] =
      await Promise.all([
        import('../../../shared/core/entities.js'),
        import('../../../services/resources/src/mod-card.js'),
      ])
    extension.context.signal?.throwIfAborted()
    const namespaces = gameDataNamespaceSummaries(parsed.mod)
    const ownPath = parsed.mod.loadOrder.at(-1) ?? ROOT
    const summary = Object.freeze({
      semanticNamespaces: namespaces.length,
      semanticEntities: namespaces.reduce((sum, item) => sum + item.total, 0),
      ownEntities: namespaces.reduce((sum, item) => sum + item.own, 0),
      declaredDependencies: parsed.dependencies,
    })
    const card = modCardFacts({
      root: extension.root,
      revision: extension.revision,
      entries: extension.entries,
      files: parsed.files,
      dependencies: parsed.dependencies,
      mod: parsed.mod as never,
      namespaces,
      ...(catalog === undefined ? {} : { catalog }),
    })
    return Object.freeze({
      summary,
      factGroups: card.factGroups,
      factRelations: card.factRelations,
      dataSources: Object.freeze({
        'common.view/tree-data-source': modResourceTree({
          root: extension.root,
          revision: extension.revision,
          entries: extension.entries,
          files: parsed.files,
          dependencies: parsed.dependencies,
          // The same engine authority the host asks for when it mounts dependencies, so Resources
          // shows the chain that is actually loaded — Core first — not only the declared names.
          dependencyChain: sc2InstallationDependencies(extension.root.uri, parsed.dependencies)
            .dependencies,
          mod: parsed.mod as never,
          namespaces,
        }),
        'common.view/subject-selector-source': card.selector,
      }),
      metadata: Object.freeze([
        Object.freeze({
          id: 'sc2-mod-model',
          label: 'SC2 mod model',
          entries: Object.freeze([
            Object.freeze({ key: 'namespaces', value: summary.semanticNamespaces }),
            Object.freeze({ key: 'entities', value: summary.semanticEntities }),
            Object.freeze({ key: 'dependencies', value: parsed.dependencies }),
          ]),
        }),
      ]),
      traits: Object.freeze([
        ...(parsed.dependencies.length === 0
          ? []
          : [
              Object.freeze({
                id: 'source.dependencies',
                parameters: { count: parsed.dependencies.length },
              }),
            ]),
      ]),
      handlers: Object.freeze({
        inspect: async () => json({ ...summary, namespaces }),
        compare: async (input: JsonValue) => {
          const locale =
            input !== null &&
            typeof input === 'object' &&
            !Array.isArray(input) &&
            typeof (input as Record<string, unknown>)['locale'] === 'string'
              ? String((input as Record<string, unknown>)['locale']).toLowerCase()
              : 'enus'
          return json({
            ownPath,
            namespaces,
            overrides: namespaces.map(item => ({
              namespace: item.ns,
              entities: collectModEntities(parsed.mod, item.ns, locale).filter(
                entity => entity.own,
              ),
            })),
          })
        },
        validate: async () =>
          json({ valid: parsed.failures.length === 0, diagnostics: parsed.failures }),
        'export-convert': async (input: JsonValue) => {
          const request =
            input !== null && typeof input === 'object' && !Array.isArray(input)
              ? (input as Record<string, JsonValue>)
              : {}
          const format = request['format'] === 'sc2components' ? 'sc2components' : 'json-mod'
          if (format === 'json-mod') {
            const { exportJsonMod } = await import('./portable-json-export.js')
            extension.context.signal?.throwIfAborted()
            return json(
              exportJsonMod(parsed.mod, {
                ...(Array.isArray(request['namespaces'])
                  ? { namespaces: request['namespaces'].map(String) }
                  : {}),
                ...(request['mode'] === 'full' ? { mode: 'full' as const } : {}),
                ...(typeof request['name'] === 'string' ? { name: request['name'] } : {}),
              }),
            )
          }
          const { exportSc2Components } = await import('./sc2-components-export.js')
          extension.context.signal?.throwIfAborted()
          return json({
            format,
            files: exportSc2Components(parsed.mod, {
              ...(Array.isArray(request['namespaces'])
                ? { namespaces: request['namespaces'].map(String) }
                : {}),
              ...(typeof request['name'] === 'string' ? { modName: request['name'] } : {}),
              ...(typeof request['indent'] === 'string' ? { indent: request['indent'] } : {}),
              ...(typeof request['writeDefaultAttr'] === 'boolean'
                ? { writeDefaultAttr: request['writeDefaultAttr'] }
                : {}),
            }),
          })
        },
        /*
         * One entity field, written into the file of this mod that declares it (parity plan 5.3):
         * the declaration that last set the field, else the entity's last declaration here. The
         * GameData file session's patcher, and a plan that replaces that one member — the host
         * commits it through the MPQ container of a packed mod, or as the file of a folder mod.
         */
        'edit-field': async (input: JsonValue): Promise<OperationOutput> => {
          const request =
            input !== null && typeof input === 'object' && !Array.isArray(input)
              ? (input as Readonly<Record<string, JsonValue>>)
              : {}
          const path = Array.isArray(request['path']) ? request['path'].map(String) : []
          const [namespace, entityId, ...field] = path
          if (namespace === undefined || entityId === undefined || field.length === 0)
            throw new TypeError('a catalog field write needs [namespace, entityId, ...field]')
          const entity = parsed.mod.get(namespace, entityId)
          if (entity === undefined) throw new TypeError(`no entity ${namespace}/${entityId} in this mod`)
          const site = entity.fieldSources?.[field[0]!] ?? entity.sources?.at(-1) ?? entity.source
          const file = site?.file.replace(/\\/gu, '/').replace(new RegExp(`^${ROOT}/`, 'iu'), '').replace(/^\/+/u, '')
          const entry = extension.entries.find(
            item => item.kind === 'file' && item.path.toLowerCase() === file?.toLowerCase(),
          )
          if (entry === undefined) throw new TypeError(`no file of this mod declares ${namespace}/${entityId}`)
          const { writeEntityField } = await import('../../../../data/services/editing/entity-field-write.js')
          extension.context.signal?.throwIfAborted()
          const member = await openEntry(extension, entry.path)
          const bytes = new TextEncoder().encode(
            writeEntityField(utf8.decode(member.bytes), entity.class, entityId, field, request['value']),
          )
          const target = loose
            ? namespaceEntryEditTarget({
                root: extension.root,
                namespaceRevision: extension.revision as RevisionId,
                entry: { path: entry.path, size: member.bytes.byteLength },
              })
            : Object.freeze({
                targetId: 'entry-0',
                subjectUri: member.ref.uri,
                ownerSource: member.ref,
                semanticPath: Object.freeze([namespace, entityId, ...field]),
                expectedRevision: entryRevision(member),
              })
          return {
            kind: 'edit-plan',
            plan: Object.freeze({
              planId: `${String(extension.revision)}:field:${namespace}/${entityId}:${field.join('.')}`,
              targets: Object.freeze([target]),
              edits: Object.freeze([
                Object.freeze({
                  operation: 'replace',
                  targetId: target.targetId,
                  source: target.ownerSource,
                  payload: Object.freeze({ kind: 'inline', bytes }),
                  label: `set ${field.join('.')} of ${namespace}/${entityId} in ${entry.path}`,
                }),
              ]),
              semantics: Object.freeze({ mutationMode: 'mutate', minimumGuarantee: 'atomic' }),
              fidelity: Object.freeze({
                roundTrip: 'byte-identical',
                preservesUnknownData: true,
                notes: Object.freeze([
                  'Only the targeted attribute or element is rewritten; the rest of the file is untouched.',
                ]),
              }),
              diagnostics: Object.freeze([]),
            }),
          } as OperationOutput
        },
        'edit-structure': async (input: JsonValue): Promise<OperationOutput> => {
          const request = addLocaleRequest(input)
          const entry = extension.entries.find(
            item =>
              item.kind === 'file' && item.path.toLowerCase() === COMPONENT_LIST.toLowerCase(),
          )
          if (entry === undefined) throw new TypeError(`SC2 mod has no ${COMPONENT_LIST}`)
          const xml = utf8.decode(
            await extension.readEntry(
              entry.path,
              extension.context.budget.maxScalarBytes,
              extension.context.signal,
            ),
          )
          if (componentListHasLocale(xml, request.locale))
            throw new TypeError(`locale ${request.locale} is already declared`)
          const next = addTextLocaleToComponentList(xml, request.locale)
          if (next === xml)
            throw new ModkitError({
              code: 'blizzard/sc2-mod-component-list-malformed',
              message: `${COMPONENT_LIST} has no closing Components element.`,
              context: { componentListPath: COMPONENT_LIST },
            })
          throw new ModkitError({
            code: 'blizzard/sc2-mod-locale-file-create-unavailable',
            message: `Adding ${request.locale} requires atomic replacement of ${COMPONENT_LIST} and creation of ${request.locale}.SC2Data/LocalizedData/${request.fileStem ?? 'GameStrings'}.txt; the active container composition does not support new entries.`,
            context: {
              locale: request.locale,
              componentListPath: COMPONENT_LIST,
              localeFilePath: `${request.locale}.SC2Data/LocalizedData/${request.fileStem ?? 'GameStrings'}.txt`,
            },
          })
        },
      }),
      diagnostics: Object.freeze(
        parsed.failures.map((failure, index) =>
          Object.freeze({
            id: `sc2-mod.parse.${index}`,
            code: 'blizzard/sc2-mod-parse-failed',
            category: 'syntax',
            severity: 'warning',
            message: failure.message,
            data: { path: failure.path },
          }),
        ),
      ),
      unsupportedFeatures: Object.freeze([
        'dependency-content-merge-requires-node-workspace-facade',
        'packed-container-new-entry-create',
        'installed-editor-acceptance',
      ]),
    })
  }
}

export const abiVersion = 1

export function createSc2ModCodec(loose: boolean, context?: ContributionContext) {
  const id = loose ? LOOSE_ID : PACKED_ID
  const definition = createSc2NamespaceDefinition({
    id,
    kind: 'mod',
    formatId: loose ? 'sc2-mod-directory' : 'sc2-mod',
    displayName: loose ? 'StarCraft II loose mod' : 'StarCraft II mod',
    topology: loose ? 'mounted-directory' : 'mpq-namespace',
    packed: !loose,
    virtualDocumentInfo: sc2BuiltinDocumentInfo,
    operations: operationDecls(id, !loose),
    extendInspection: createExtension(context?.catalog, loose),
  })
  const sharedDetect = definition.namespace.detect
  const sharedInspect = definition.namespace.inspect
  return createInspectionCodec(
    Object.freeze({
      ...definition,
      namespace: Object.freeze({
        ...definition.namespace,
        async detect(
          markers: readonly Readonly<{ path: string; kind: 'file' | 'directory' }>[],
          uri: string,
        ) {
          const detected = (await sharedDetect(markers)) as NamespaceDetection
          return detected.confidence > 0 ? detected : detectSc2ModNamespaceMarkers(markers, uri)
        },
        async inspect(
          namespace: AssetNamespace,
          inspectionContext: NamespaceInspectionContext,
        ): Promise<NamespaceInspectionResult> {
          const fallback = await componentListFallback(namespace, inspectionContext)
          if (fallback === undefined) {
            return sharedInspect(namespace, inspectionContext) as Promise<NamespaceInspectionResult>
          }
          const result = (await sharedInspect(
            legacyFlatNamespace(namespace, inspectionContext),
            inspectionContext,
          )) as NamespaceInspectionResult
          const summaryValue =
            result.summary !== null &&
            typeof result.summary === 'object' &&
            !Array.isArray(result.summary)
              ? (result.summary as Readonly<Record<string, JsonValue>>)
              : {}
          return Object.freeze({
            ...result,
            summary: Object.freeze({
              ...summaryValue,
              syntheticComponentListFallback: fallback,
              ...(fallback === 'flat' ? { legacyFlatGameDataFallback: true } : {}),
            }),
            detection: Object.freeze({
              confidence: fallback === 'flat' ? 0.9 : 0.85,
              kind: 'structure' as const,
              note:
                fallback === 'flat'
                  ? 'mod:document-info + mod:data-directory + .sc2mod'
                  : 'installed-mod:base.sc2data + .sc2mod',
            }),
          })
        },
      }),
    }) as NamespaceInspectionCodecDefinition,
    context,
  )
}

export function createCodec(context?: ContributionContext) {
  return createSc2ModCodec(false, context)
}
