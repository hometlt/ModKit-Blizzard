export interface Starcraft2SchemaValueDescriptor {
  readonly valueKind?: string
  readonly valueType?: string
  readonly enumMembers?: readonly string[]
  readonly enumUnknown?: string
  readonly numberMin?: number
  readonly numberMax?: number
  readonly numberFloat?: boolean
  readonly instructionKeywords?: readonly string[]
  readonly instructionArguments?: Readonly<
    Record<string, readonly Starcraft2SchemaValueDescriptor[]>
  >
  readonly instructionDelimiter?: string
  readonly instructionListDelimiter?: string
  readonly instructionFallback?: Starcraft2SchemaValueDescriptor
  readonly itemDescriptor?: Starcraft2SchemaValueDescriptor
  readonly linkNamespace?: string
  readonly assetKind?: string
  readonly externalLinkKind?: string
  readonly structureType?: string
}

export interface Starcraft2SchemaField extends Starcraft2SchemaValueDescriptor {
  readonly fieldId: string
  readonly cardinality: 'scalar' | 'append' | 'indexed'
  readonly indexKey?: string
  readonly fields?: readonly Starcraft2SchemaField[]
  readonly recursiveStructure?: boolean
  readonly positional?: boolean
}

export interface Starcraft2DataSchema {
  readonly typeId: string
  readonly parentTypeId?: string
  readonly fields: readonly Starcraft2SchemaField[]
}

export const STARCRAFT2_VALUE_TYPES: Readonly<
  Record<string, Starcraft2SchemaValueDescriptor>
>
export const STARCRAFT2_DATA_SCHEMAS: readonly Starcraft2DataSchema[]
export const STARCRAFT2_SCHEMA_BY_TYPE: ReadonlyMap<string, Starcraft2DataSchema>
export const STARCRAFT2_TYPE_NAMESPACES: Readonly<Record<string, string>>
export const STARCRAFT2_DATA_NAMESPACES: readonly string[]
export const STARCRAFT2_CATALOG_FILES: readonly string[]
export const STARCRAFT2_DATA_SCHEMA_COVERAGE: Readonly<Record<string, number>>
export const STARCRAFT2_DATA_SCHEMA_PROVENANCE: Readonly<Record<string, unknown>>

export function starcraft2ResolutionField(field: Starcraft2SchemaField): Starcraft2SchemaField
export function resolveStarcraft2StructureFields(
  structureType: string,
): readonly Starcraft2SchemaField[] | undefined
export function starcraft2NamespaceForType(typeId: string): string | undefined
export function resolveStarcraft2SchemaFields(typeId: string): readonly Starcraft2SchemaField[]
export function starcraft2DeclaringTypeForField(typeId: string, fieldId: string): string
