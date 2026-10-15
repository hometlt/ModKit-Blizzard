import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { STARCRAFT2_DATA_SCHEMAS } from '../services/schema/full-data-schema.js'
import {
  STARCRAFT2_DATA_SCHEMA_CONTRACT,
  STARCRAFT2_DATA_SCHEMA_REVISION,
} from '../services/schema/data-schema-identity.js'

const SCHEMA = Object.freeze({
  contract: STARCRAFT2_DATA_SCHEMA_CONTRACT,
  major: 1,
  revision: STARCRAFT2_DATA_SCHEMA_REVISION,
})
const SCHEMA_SOURCE = Object.freeze({
  kind: 'schema',
  title: 'Modkit dependency-resolved StarCraft II data schema',
  schema: SCHEMA,
  reviewedAt: '2026-08-29',
})
const COMMUNITY_SOURCE = Object.freeze({
  kind: 'community-wiki',
  title: 'SC2Mapster data types index',
  url: 'https://sc2mapster.wiki.gg/wiki/Data_Types',
  reviewedAt: '2026-08-29',
})

const meanings = Object.freeze({
  Name: 'Localized display-name key shown for this catalog item.',
  Description: 'Localized longer description or tooltip text for this catalog item.',
  Tooltip: 'Localized tooltip key displayed by the user interface.',
  Icon: 'Logical image asset used to represent this catalog item.',
  Model: 'Logical model asset or model catalog link used for presentation.',
  Sound: 'Logical sound catalog link used by this catalog item.',
  Race: 'Race catalog identifier associated with this item.',
  Flags: 'Named behavior switches enabled for this catalog item.',
  LifeMax: 'Maximum life before behaviors and runtime modifiers are applied.',
  LifeArmor: 'Base life armour before upgrades and runtime modifiers are applied.',
  LifeRegenRate: 'Base life restored per game-time unit.',
  ShieldsMax: 'Maximum shields before behaviors and runtime modifiers are applied.',
  ShieldArmor: 'Base shield armour before upgrades and runtime modifiers are applied.',
  ShieldRegenRate: 'Base shields restored per game-time unit.',
  EnergyMax: 'Maximum energy before behaviors and runtime modifiers are applied.',
  EnergyRegenRate: 'Base energy restored per game-time unit.',
  Speed: 'Base movement speed before behaviors and runtime modifiers are applied.',
  Acceleration: 'Base rate at which the unit gains movement speed.',
  Deceleration: 'Base rate at which the unit loses movement speed.',
  TurningRate: 'Base rate at which the unit changes facing.',
  Sight: 'Base sight radius before runtime modifiers are applied.',
  Range: 'Authored range used by this weapon, ability, effect, or sensor rule.',
  MinimumRange: 'Minimum distance at which this action can be used.',
  Period: 'Authored interval between repeated actions or updates.',
  Amount: 'Authored amount applied by this effect or accumulator.',
  Duration: 'Authored lifetime of this behavior, effect, or state.',
  CostResource: 'Authored resource-cost structure for this item.',
  CostTime: 'Authored time cost for production or research.',
  Food: 'Supply consumed by this unit.',
  FoodMade: 'Supply capacity provided by this unit.',
  MaxLevel: 'Maximum level available for this upgrade or leveled item.',
  Effect: 'Catalog link to the effect executed by this record.',
  InitialEffect: 'Effect executed when this record starts.',
  PeriodicEffect: 'Effect executed at each authored period.',
  FinalEffect: 'Effect executed when this record completes.',
  ExpireEffect: 'Effect executed when this behavior expires.',
  ImpactEffect: 'Effect executed when a projectile or action reaches its target.',
  WeaponArray: 'Ordered weapon slots owned by this unit.',
  AbilArray: 'Ordered ability slots owned by this unit.',
  BehaviorArray: 'Behaviors initially attached to this unit.',
  ValidatorArray: 'Validators that must accept the action before it proceeds.',
  TargetFilters: 'Target-category rules used to accept or reject possible targets.',
  Parent: 'Inherited catalog parent used as the base resolved definition.',
})

const words = value =>
  value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[-_]+/gu, ' ')
    .trim()

const slug = value =>
  value
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/[^A-Za-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .toLocaleLowerCase('en-US')

const coordinateTag = (typeId, fieldId) =>
  createHash('sha256').update(`${typeId}\u0000${fieldId}`).digest('hex').slice(0, 8)

const summaryFor = (typeId, field) => {
  const known = meanings[field.fieldId]
  if (known !== undefined) return known
  if (field.linkNamespace !== undefined) {
    return `Selects a ${field.linkNamespace} catalog item from ${typeId}; the exact target is resolved through the dependency-merged catalog graph.`
  }
  if (field.assetKind !== undefined) {
    return `Stores a logical ${field.assetKind} asset reference used by ${typeId}; resource lookup remains owned by the opened Modkit workspace.`
  }
  return `The installed-game schema declares the authored ${words(field.fieldId)} field on ${typeId}; its value shape is known, while a more specific gameplay interpretation is not asserted here.`
}

const detailsFor = field => {
  const details = {
    valueType: field.valueType ?? field.valueKind ?? 'schema-declared value',
  }
  if (field.enumMembers !== undefined && field.enumMembers.length <= 512) {
    details.allowedValues = field.enumMembers
  }
  return details
}

const entries = STARCRAFT2_DATA_SCHEMAS.flatMap(type =>
  type.fields.map((field, fieldIndex) => {
    const known = meanings[field.fieldId] !== undefined
    return {
      id: `blizzard.sc2/schema-${slug(type.typeId)}-${slug(field.fieldId)}-${coordinateTag(type.typeId, field.fieldId)}-${fieldIndex + 1}`,
      target: {
        kind: 'field',
        ecosystem: 'starcraft-2',
        schema: SCHEMA,
        typeId: type.typeId,
        canonicalPath: [field.fieldId],
      },
      locale: 'en',
      title: `${type.typeId}: ${words(field.fieldId)}`,
      summary: summaryFor(type.typeId, field),
      claimKind: known ? 'documented-interpretation' : 'schema-derived-fact',
      confidence: known ? 'high' : 'verified',
      details: detailsFor(field),
      keywords: [type.typeId, field.fieldId],
      sources: [SCHEMA_SOURCE, COMMUNITY_SOURCE],
    }
  }),
)

/*
 * The entries live in a file of their own, named by `entriesPath`: the host reads it when knowledge
 * is first queried. Inline, these 8.5 MB were parsed, validated and projected by every window of
 * every host at start-up (3–5 s of the VS Code extension's activation).
 */
const ENTRIES_PATH = 'contributions/knowledge/schema-data.entries.json'

const manifest = {
  schemaVersion: 1,
  contract: { id: 'modkit/knowledge-pack', major: 1 },
  id: 'blizzard/sc2-data-schema-knowledge',
  displayName: 'StarCraft II generated schema knowledge',
  spec: {
    schemaVersion: 1,
    sourceLocale: 'en',
    priority: 10,
    gameIds: ['blizzard/starcraft-2'],
    entriesPath: ENTRIES_PATH,
  },
}

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
await writeFile(
  resolve(extensionRoot, 'contributions', 'knowledge-schema-data.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
)
await mkdir(dirname(resolve(extensionRoot, ENTRIES_PATH)), { recursive: true })
await writeFile(
  resolve(extensionRoot, ENTRIES_PATH),
  `${JSON.stringify({ entries }, null, 2)}\n`,
  'utf8',
)
await writeFile(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'services',
    'schema',
    'generated',
    'knowledge-coverage.json',
  ),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      schema: SCHEMA,
      fieldTargets: entries.length,
      shortDescriptions: entries.length,
      detailedInterpretations: entries.filter(
        entry => entry.claimKind === 'documented-interpretation',
      ).length,
      schemaOnlyDescriptions: entries.filter(entry => entry.claimKind === 'schema-derived-fact')
        .length,
      sourceBacked: entries.length,
      missing: 0,
    },
    null,
    2,
  )}\n`,
  'utf8',
)
