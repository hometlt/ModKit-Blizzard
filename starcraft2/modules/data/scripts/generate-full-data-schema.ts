import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PINNED_REPOSITORY_COMMIT = '1a14ba4eddd0ae88de273348ebd44cfb98a0581d'
const PINNED_SCHEMA_COMMIT = '8a21060f86336d4d03f5471b03f5de4cbeb9c07e'
const SCHEMA_PATH = 'packages/data-processing/src/sc2-schema'

function git(repository: string, ...arguments_: string[]): string {
  return execFileSync('git', ['-C', repository, ...arguments_], { encoding: 'utf8' }).trim()
}

function sortedRecord<T>(entries: readonly (readonly [string, T])[]): Record<string, T> {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)))
}

const semanticTypes = new Map<string, Readonly<Record<string, unknown>>>()

type SchemaConstructor = (new (...arguments_: never[]) => unknown) & {
  readonly name: string
  readonly enum?: readonly string[]
  readonly unknown?: string
  readonly list?: readonly string[]
  readonly instructions?: Readonly<Record<string, unknown>>
  readonly instructionDelimiter?: string
  readonly instructionListDelimiter?: string
  readonly instructionFallback?: unknown
  readonly memberType?: unknown
  readonly memberTypes?: readonly unknown[]
  readonly value?: unknown
  readonly schema?: Readonly<Record<string, unknown>>
  readonly link?: string
}

function parseParentTypes(source: string): ReadonlyMap<string, string> {
  const parents = new Map<string, string>()
  for (const match of source.matchAll(/\bclass\s+(\w+)\s+extends\s+(\w+)\.Ex\s*\(/gu)) {
    const [, typeId, parentTypeId] = match
    if (typeId !== undefined && parentTypeId !== undefined) parents.set(typeId, parentTypeId)
  }
  return parents
}

function inheritanceNames(value: SchemaConstructor): ReadonlySet<string> {
  const names = new Set<string>()
  let current: unknown = value
  while (typeof current === 'function') {
    if (current.name.length > 0) names.add(current.name)
    current = Object.getPrototypeOf(current)
  }
  return names
}

function semanticDescriptor(candidate: SchemaConstructor, namespaces: ReadonlySet<string>) {
  const inheritance = inheritanceNames(candidate)
  if (candidate.instructions !== undefined) {
    const instructionArguments = sortedRecord(
      Object.entries(candidate.instructions).map(([keyword, tuple]) => {
        const memberTypes = (tuple as { readonly memberTypes?: readonly unknown[] }).memberTypes
        return [
          keyword,
          Array.isArray(memberTypes)
            ? memberTypes.slice(1).map(argument => inlineDescriptor(argument, namespaces))
            : [],
        ] as const
      }),
    )
    return {
      valueKind: 'instructions',
      instructionKeywords: Object.keys(candidate.instructions).sort(),
      instructionArguments,
      instructionDelimiter: candidate.instructionDelimiter ?? ' ',
      ...(candidate.instructionListDelimiter === undefined
        ? {}
        : { instructionListDelimiter: candidate.instructionListDelimiter }),
      ...(candidate.instructionFallback === undefined
        ? {}
        : { instructionFallback: inlineDescriptor(candidate.instructionFallback, namespaces) }),
    }
  }
  if (inheritance.has('CStringArray') && candidate.memberType !== undefined) {
    const member = candidate.memberType as SchemaConstructor
    if (typeof member === 'function' && member.instructions !== undefined) {
      const descriptor = semanticDescriptor(member, namespaces)
      return {
        ...descriptor,
        instructionListDelimiter: inheritance.has('CSArray')
          ? ';'
          : inheritance.has('CWArray')
            ? ' '
            : inheritance.has('CCArray')
              ? ','
              : ';',
      }
    }
  }
  if (inheritance.has('CRecord') && candidate.value !== undefined) {
    return {
      valueKind: 'record',
      itemDescriptor: inlineDescriptor(candidate.value, namespaces),
    }
  }
  if (inheritance.has('CFlags')) {
    return {
      valueKind: 'flags',
      ...(Array.isArray(candidate.list) && candidate.list.length > 0
        ? { enumMembers: [...candidate.list] }
        : {}),
    }
  }
  if (inheritance.has('CEnum')) {
    return {
      valueKind: 'enum',
      ...(Array.isArray(candidate.enum) && candidate.enum.length > 0
        ? { enumMembers: [...candidate.enum] }
        : {}),
      enumUnknown: candidate.unknown ?? 'Unknown',
    }
  }
  if (typeof (candidate as { readonly link?: unknown }).link === 'string') {
    const link = candidate.link
    return {
      valueKind: 'link',
      ...(link === 'String'
        ? { linkNamespace: 'String' }
        : link === 'File'
          ? { assetKind: 'File' }
          : namespaces.has(link)
            ? { linkNamespace: link }
            : { externalLinkKind: link }),
    }
  }
  if (inheritance.has('CFile')) return { valueKind: 'file' }
  if (inheritance.has('CBoolean')) return { valueKind: 'bool' }
  if (inheritance.has('CNumber')) {
    const numeric: {
      valueKind: string
      numberMin?: number
      numberMax?: number
      numberFloat?: boolean
    } = { valueKind: 'number' }
    try {
      const instance = new (
        candidate as new () => {
          readonly min?: number
          readonly max?: number
          readonly float?: boolean
        }
      )()
      if (typeof instance.min === 'number') numeric.numberMin = instance.min
      if (typeof instance.max === 'number') numeric.numberMax = instance.max
      if (typeof instance.float === 'boolean') numeric.numberFloat = instance.float
    } catch {
      // Some legacy scalar constructors require arguments; their numeric kind is still exact.
    }
    return numeric
  }
  if (candidate.name === 'TEditorCategories') return { valueKind: 'editorCategories' }
  if (
    inheritance.has('CCatalogReference') ||
    inheritance.has('CGameContentCreationData') ||
    inheritance.has('CDataEntryPath')
  ) {
    return { valueKind: 'catalogRef' }
  }
  if (candidate.schema !== undefined && Object.keys(candidate.schema).length > 0) {
    return { valueKind: 'struct' }
  }
  return { valueKind: 'scalar' }
}

function sourceDescriptor(value: unknown, namespaces: ReadonlySet<string>) {
  if (typeof value !== 'function') return {}
  const candidate = value as SchemaConstructor
  const valueType =
    candidate.name === undefined || candidate.name.length === 0 ? undefined : candidate.name
  const linkNamespace =
    candidate.link === 'String'
      ? ''
      : candidate.link === 'LayoutFrame'
        ? 'Layout'
        : candidate.link !== undefined && namespaces.has(candidate.link)
          ? candidate.link
          : undefined
  const assetKind = candidate.link === 'File' ? 'File' : undefined
  const externalLinkKind =
    candidate.link !== undefined &&
    candidate.link !== 'String' &&
    candidate.link !== 'File' &&
    candidate.link !== 'LayoutFrame' &&
    !namespaces.has(candidate.link)
      ? candidate.link
      : undefined
  const fieldsRef =
    candidate.schema !== undefined && Object.keys(candidate.schema).length > 0
      ? valueType
      : undefined
  const semantics = semanticDescriptor(candidate, namespaces)
  if (valueType !== undefined) {
    const existing = semanticTypes.get(valueType)
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(semantics)) {
      throw new Error(`legacy value type ${valueType} has inconsistent semantic metadata`)
    }
    semanticTypes.set(valueType, semantics)
  }
  return {
    ...(valueType === undefined ? semantics : { valueKind: semantics.valueKind }),
    ...(valueType === undefined ? {} : { valueType }),
    ...(linkNamespace === undefined ? {} : { linkNamespace }),
    ...(assetKind === undefined ? {} : { assetKind }),
    ...(externalLinkKind === undefined ? {} : { externalLinkKind }),
    ...(fieldsRef === undefined ? {} : { fieldsRef }),
  }
}

function inlineDescriptor(value: unknown, namespaces: ReadonlySet<string>) {
  const descriptor = sourceDescriptor(value, namespaces)
  const valueType = descriptor.valueType
  return valueType === undefined
    ? descriptor
    : { ...(semanticTypes.get(valueType) ?? {}), ...descriptor }
}

function fieldDescriptor(fieldId: string, value: unknown, namespaces: ReadonlySet<string>) {
  if (Array.isArray(value)) {
    return {
      fieldId,
      cardinality: 'append',
      ...sourceDescriptor(value[0], namespaces),
    }
  }
  if (typeof value === 'object' && value !== null && 'index' in value && 'value' in value) {
    return {
      fieldId,
      cardinality: 'indexed',
      indexKey: 'index',
      ...sourceDescriptor((value as { readonly value: unknown }).value, namespaces),
    }
  }
  return {
    fieldId,
    cardinality: 'scalar',
    ...sourceDescriptor(value, namespaces),
  }
}

function schemaFields(schema: Readonly<Record<string, unknown>>, namespaces: ReadonlySet<string>) {
  return Object.entries(schema)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fieldId, value]) => fieldDescriptor(fieldId, value, namespaces))
}

function descriptorFingerprint(value: unknown, namespaces: ReadonlySet<string>): string {
  return JSON.stringify(fieldDescriptor('', value, namespaces))
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
// Default (and `--in-repo`) uses the canonical MK3 copy of the pinned legacy schema, with
// corrections verified against SC2 5.0 editor strings, Galaxy constants and shipped XML
// (reports/SC2DATA_MODULE_SCHEMA_DISCREPANCIES_RU.md). An explicit path selects a legacy checkout;
// the metadata gate below refuses to overwrite the artifact from an incomplete source.
const inRepo = process.argv[2] === undefined || process.argv[2] === '--in-repo'
const legacyRepository = inRepo ? undefined : resolve(process.argv[2]!)
const outputPath = resolve(
  process.argv[3] ??
    join(scriptDirectory, '..', 'services', 'schema', 'generated', 'sc2-data-schema.json'),
)

if (legacyRepository !== undefined) {
  if (git(legacyRepository, 'rev-parse', 'HEAD') !== PINNED_REPOSITORY_COMMIT) {
    throw new Error(`legacy repository must be checked out at ${PINNED_REPOSITORY_COMMIT}`)
  }
  execFileSync('git', ['-C', legacyRepository, 'diff', '--quiet', '--', SCHEMA_PATH])
  execFileSync('git', [
    '-C',
    legacyRepository,
    'merge-base',
    '--is-ancestor',
    PINNED_SCHEMA_COMMIT,
    PINNED_REPOSITORY_COMMIT,
  ])
}

const schemaDirectory =
  legacyRepository === undefined
    ? join(scriptDirectory, '..', 'shared', 'catalog-engine', 'sc2-schema')
    : join(legacyRepository, SCHEMA_PATH)
const schemaModulePath = join(schemaDirectory, 'structure-types', 'index.ts')
const schemaSourcePath = join(schemaDirectory, 'structure-types', 'schema.classes.ts')
const schemaModule = (await import(pathToFileURL(schemaModulePath).href)) as {
  readonly DATA_CLASS_SCHEMA: Readonly<
    Record<string, { readonly schema?: Readonly<Record<string, unknown>> }>
  >
  readonly NAMESPACE_CLASS_MAP: Readonly<Record<string, readonly string[]>>
}
const classes = schemaModule.DATA_CLASS_SCHEMA
const namespaceClassMap = schemaModule.NAMESPACE_CLASS_MAP
const namespaces = Object.keys(namespaceClassMap).sort()
const namespaceSet = new Set(namespaces)
const typeNamespaces = new Map<string, string>()
for (const namespace of namespaces) {
  for (const typeId of namespaceClassMap[namespace] ?? []) {
    if (typeNamespaces.has(typeId)) throw new Error(`schema type ${typeId} has multiple namespaces`)
    typeNamespaces.set(typeId, namespace)
  }
}
if (typeNamespaces.size !== Object.keys(classes).length) {
  throw new Error('every generated data class must have exactly one catalog namespace')
}

const parentTypes = parseParentTypes(readFileSync(schemaSourcePath, 'utf8'))
const structureTypes = new Map<string, Readonly<Record<string, unknown>>>()
const rememberStructures = (value: unknown, visiting = new Set<string>()): void => {
  const candidate = Array.isArray(value)
    ? value[0]
    : typeof value === 'object' && value !== null && 'value' in value
      ? (value as { readonly value: unknown }).value
      : value
  if (typeof candidate !== 'function') return
  const typed = candidate as {
    readonly name?: string
    readonly link?: string
    readonly schema?: Readonly<Record<string, unknown>>
  }
  if (
    typed.link !== undefined ||
    typed.schema === undefined ||
    Object.keys(typed.schema).length === 0
  ) {
    return
  }
  const name = typed.name
  if (name === undefined || name.length === 0 || classes[name] !== undefined || visiting.has(name))
    return
  structureTypes.set(name, typed.schema)
  const next = new Set(visiting)
  next.add(name)
  for (const nested of Object.values(typed.schema)) rememberStructures(nested, next)
}
for (const candidate of Object.values(classes)) {
  for (const value of Object.values(candidate.schema ?? {})) rememberStructures(value)
}

const types = Object.entries(classes)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([typeId, candidate]) => {
    const declaredParent = parentTypes.get(typeId)
    const parentTypeId =
      declaredParent === undefined || declaredParent === 'CClass' ? 'CBase' : declaredParent
    const parentSchema = classes[parentTypeId]?.schema ?? {}
    const fields = Object.entries(candidate.schema ?? {})
      .filter(([fieldId, value]) => {
        const inherited = parentSchema[fieldId]
        return (
          inherited === undefined ||
          descriptorFingerprint(inherited, namespaceSet) !==
            descriptorFingerprint(value, namespaceSet)
        )
      })
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([fieldId, value]) => fieldDescriptor(fieldId, value, namespaceSet))
    return {
      typeId,
      namespace: typeNamespaces.get(typeId),
      parentTypeId,
      fields,
    }
  })

const structures = sortedRecord(
  [...structureTypes.entries()].map(
    ([name, schema]) => [name, schemaFields(schema, namespaceSet)] as const,
  ),
)
const valueTypes = sortedRecord([...semanticTypes.entries()])
for (const [typeName, property] of [
  ['CActorKey', 'instructionFallback'],
  ['CActorTerms', 'instructionArguments'],
  ['CActorTerms', 'instructionListDelimiter'],
] as const) {
  if (valueTypes[typeName]?.[property] === undefined) {
    throw new Error(
      `schema source omits ${typeName}.${property}; use the corrected in-repository authoring ` +
        'schema instead of replacing the generated artifact with a lossy pinned projection',
    )
  }
}
const priorityCatalogFiles = [
  'abildata.xml',
  'actordata.xml',
  'behaviordata.xml',
  'buttondata.xml',
  'effectdata.xml',
  'unitdata.xml',
  'upgradedata.xml',
  'weapondata.xml',
]
const catalogFiles = [
  ...priorityCatalogFiles,
  ...namespaces
    .map(namespace => `${namespace.toLowerCase()}data.xml`)
    .filter(file => !priorityCatalogFiles.includes(file)),
]
const coverage = {
  typeCount: types.length + 1,
  generatedTypeCount: types.length,
  namespaceCount: namespaces.length,
  directFieldCount: types.reduce((sum, type) => sum + type.fields.length, 0),
  structureCount: Object.keys(structures).length,
  structureFieldCount: Object.values(structures).reduce((sum, fields) => sum + fields.length, 0),
  linkFieldCount:
    types.flatMap(type => type.fields).filter(field => field.linkNamespace !== undefined).length +
    Object.values(structures)
      .flat()
      .filter(field => field.linkNamespace !== undefined).length,
  assetFieldCount:
    types.flatMap(type => type.fields).filter(field => field.assetKind !== undefined).length +
    Object.values(structures)
      .flat()
      .filter(field => field.assetKind !== undefined).length,
}
const digestInput = {
  schemaVersion: 1,
  namespaces,
  catalogFiles,
  types,
  structures,
  valueTypes,
  coverage,
}
const digest = `sha256:${createHash('sha256').update(JSON.stringify(digestInput)).digest('hex')}`
const asset = {
  ...digestInput,
  provenance: {
    sourceRepository: 'modkit',
    legacyRepositoryCommit: PINNED_REPOSITORY_COMMIT,
    legacySchemaCommit: PINNED_SCHEMA_COMMIT,
    legacySchemaPath: SCHEMA_PATH,
    ...(inRepo ? { correctedIn: 'modules/data/shared/catalog-engine/sc2-schema/structure-types' } : {}),
    generationSource: inRepo ? 'corrected-in-repository' : 'pinned-legacy-checkout',
    digest,
  },
}
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(asset, undefined, 2)}\n`, 'utf8')
console.log(JSON.stringify({ outputPath, digest, coverage }, undefined, 2))
