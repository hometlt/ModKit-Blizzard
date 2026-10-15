import { describe, expect, it } from 'vitest'
import {
  STARCRAFT2_DATA_SCHEMAS,
  STARCRAFT2_DATA_SCHEMA_PROVENANCE,
  STARCRAFT2_VALUE_TYPES,
  type Starcraft2SchemaValueDescriptor,
} from '../services/schema/full-data-schema.js'
import { STARCRAFT2_DATA_SCHEMA_REVISION } from '../services/schema/data-schema-identity.js'
import { classifyField, type FieldInfo } from '../shared/catalog-engine/sc2-catalog/schema-fields.js'
import * as authoringTypes from '../shared/catalog-engine/sc2-schema/structure-types/index.js'

type Comparable = Readonly<Record<string, unknown>>

function generatedDescriptor(
  descriptor: Starcraft2SchemaValueDescriptor,
  includeType = false,
): Comparable {
  const kind = descriptor.valueKind ?? 'scalar'
  return {
    kind,
    ...(includeType && descriptor.valueType !== undefined
      ? { valueType: descriptor.valueType }
      : {}),
    ...(descriptor.enumMembers === undefined ? {} : { enumMembers: descriptor.enumMembers }),
    ...(descriptor.enumUnknown === undefined ? {} : { enumUnknown: descriptor.enumUnknown }),
    ...(descriptor.numberMin === undefined ? {} : { numberMin: descriptor.numberMin }),
    ...(descriptor.numberMax === undefined ? {} : { numberMax: descriptor.numberMax }),
    ...(descriptor.numberFloat === undefined ? {} : { numberFloat: descriptor.numberFloat }),
    ...(kind !== 'link'
      ? {}
      : {
          linkNamespace:
            descriptor.linkNamespace ??
            (descriptor.assetKind === 'File' ? 'File' : descriptor.externalLinkKind),
        }),
    ...(descriptor.itemDescriptor === undefined
      ? {}
      : { itemType: generatedDescriptor(descriptor.itemDescriptor, true) }),
    ...(descriptor.instructionArguments === undefined
      ? {}
      : {
          instructions: Object.fromEntries(
            Object.entries(descriptor.instructionArguments).map(([keyword, arguments_]) => [
              keyword,
              arguments_.map(argument => generatedDescriptor(argument, true)),
            ]),
          ),
        }),
    ...(descriptor.instructionDelimiter === undefined
      ? {}
      : { instructionDelimiter: descriptor.instructionDelimiter }),
    ...(descriptor.instructionListDelimiter === undefined
      ? {}
      : { instructionListDelimiter: descriptor.instructionListDelimiter }),
    ...(descriptor.instructionFallback === undefined
      ? {}
      : { instructionFallback: generatedDescriptor(descriptor.instructionFallback, true) }),
  }
}

function authoringDescriptor(info: FieldInfo, includeType = false): Comparable {
  return {
    kind: info.kind,
    ...(includeType && info.typeName !== undefined ? { valueType: info.typeName } : {}),
    ...(info.enumMembers === undefined ? {} : { enumMembers: info.enumMembers }),
    ...(info.enumUnknown === undefined ? {} : { enumUnknown: info.enumUnknown }),
    ...(info.numberMin === undefined ? {} : { numberMin: info.numberMin }),
    ...(info.numberMax === undefined ? {} : { numberMax: info.numberMax }),
    ...(info.numberFloat === undefined ? {} : { numberFloat: info.numberFloat }),
    ...(info.kind !== 'link' ? {} : { linkNamespace: info.linkNamespace }),
    ...(info.itemType === undefined
      ? {}
      : { itemType: authoringDescriptor(classifyField(info.itemType), true) }),
    ...(info.instructions === undefined
      ? {}
      : {
          instructions: Object.fromEntries(
            [...info.instructions].map(([keyword, arguments_]) => [
              keyword,
              arguments_.map(argument => authoringDescriptor(argument, true)),
            ]),
          ),
        }),
    ...(info.instructionDelimiter === undefined
      ? {}
      : { instructionDelimiter: info.instructionDelimiter }),
    ...(info.instructionListDelimiter === undefined
      ? {}
      : { instructionListDelimiter: info.instructionListDelimiter }),
    ...(info.instructionFallback === undefined
      ? {}
      : { instructionFallback: authoringDescriptor(info.instructionFallback, true) }),
  }
}

describe('generated SC2 data schema metadata', () => {
  it('preserves every classify/validate descriptor exported by the rich authoring model', () => {
    let compared = 0
    for (const [typeName, generated] of Object.entries(STARCRAFT2_VALUE_TYPES)) {
      const authoring = authoringTypes[typeName as keyof typeof authoringTypes]
      if (typeof authoring !== 'function') continue
      expect(generatedDescriptor(generated), typeName).toEqual(
        authoringDescriptor(classifyField(authoring)),
      )
      compared += 1
    }
    expect(compared).toBeGreaterThan(1_000)
  })

  it('records that the corrected local authority supplied metadata absent from the legacy pin', () => {
    expect(STARCRAFT2_DATA_SCHEMA_PROVENANCE).toMatchObject({
      legacySchemaCommit: '8a21060f86336d4d03f5471b03f5de4cbeb9c07e',
      correctedIn: 'modules/data/shared/catalog-engine/sc2-schema/structure-types',
      generationSource: 'corrected-in-repository',
    })
    expect(STARCRAFT2_VALUE_TYPES.CActorKey?.instructionFallback).toMatchObject({
      valueKind: 'link',
      linkNamespace: 'Actor',
    })
    expect(STARCRAFT2_VALUE_TYPES.CActorTerms?.instructionListDelimiter).toBe(';')
    expect(
      Object.keys(STARCRAFT2_VALUE_TYPES.CActorTerms?.instructionArguments ?? {}).length,
    ).toBeGreaterThan(50)
  })

  it('derives the public knowledge identity from the generated provenance digest', () => {
    const commit = STARCRAFT2_DATA_SCHEMA_PROVENANCE.legacySchemaCommit as string
    const digest = STARCRAFT2_DATA_SCHEMA_PROVENANCE.digest as string
    expect(STARCRAFT2_DATA_SCHEMA_REVISION).toBe(
      `full-${commit}-sha256-${digest.slice('sha256:'.length, 'sha256:'.length + 16)}`,
    )
  })

  it('keeps rich value metadata on materialized catalog fields', () => {
    const field = (typeId: string, fieldId: string) =>
      STARCRAFT2_DATA_SCHEMAS.find(schema => schema.typeId === typeId)?.fields.find(
        candidate => candidate.fieldId === fieldId,
      )

    const record = field('CAbil', 'token')
    expect(record).toMatchObject({
      valueKind: 'record',
      valueType: 'CTokenDefinitions',
      itemDescriptor: { valueKind: 'scalar', valueType: 'CTokenType' },
    })
    expect(record?.itemDescriptor).toBe(STARCRAFT2_VALUE_TYPES.CTokenDefinitions?.itemDescriptor)

    const instructions = field('CActor', 'Terms')
    expect(instructions).toMatchObject({
      valueKind: 'instructions',
      valueType: 'CActorTerms',
      instructionDelimiter: ' ',
      instructionListDelimiter: ';',
    })
    expect(instructions?.instructionArguments).toBe(
      STARCRAFT2_VALUE_TYPES.CActorTerms?.instructionArguments,
    )
    expect(Object.keys(instructions?.instructionArguments ?? {})).toHaveLength(93)
    expect(Object.isFrozen(instructions?.instructionArguments)).toBe(true)
    expect(Object.isFrozen(STARCRAFT2_VALUE_TYPES.CActorTerms?.instructionKeywords)).toBe(true)
  })
})
