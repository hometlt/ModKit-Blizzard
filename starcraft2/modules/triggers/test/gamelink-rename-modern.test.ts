import { describe, expect, it } from 'vitest'
import { ModkitError } from '@modkit/core'
import {
  TRIGGER_RENAME_CONFLICT_CODE,
  TRIGGER_RENAME_CUSTOM_SCRIPT_CODE,
  TRIGGER_RENAME_NO_CATALOG_CODE,
  TRIGGER_RENAME_NO_OP_CODE,
  TRIGGER_RENAME_UNKNOWN_ENTITY_CODE,
  createTriggerGamelinkMapper,
  isTriggerFilePath,
  parseTriggerGamelinkRenameInput,
  prepareTriggerGamelinkRename,
  renameTriggerGamelinks,
  type TriggerGamelinkRename,
} from '../services/editing/rename.js'
import {
  TRIGGER_GAMELINK_FIXTURE,
  TRIGGER_GAMELINK_WITH_SCRIPT_FIXTURE,
} from './fixtures/gamelink.js'

const RENAMES: readonly TriggerGamelinkRename[] = [
  { catalog: 'Unit', oldId: 'Marine', newId: 'CUSTOM_*' },
  { catalog: 'Effect', oldId: 'ZapDamage', newId: 'CUSTOM_ZapDamage' },
  { catalog: 'Abil', oldId: 'ZapAbil', newId: 'CUSTOM_ZapAbil' },
]

describe('MK3 TriggerData gamelink edit preparation', () => {
  it('rejects empty or malformed operation input with a qualified ModkitError', () => {
    for (const input of [
      null,
      {},
      { renames: [] },
      { renames: [{ catalog: 'Unit' }] },
      { renames: [{ catalog: '', oldId: 'Marine', newId: 'Marauder' }] },
    ]) {
      expect(() => parseTriggerGamelinkRenameInput(input)).toThrow(ModkitError)
    }
    expect(parseTriggerGamelinkRenameInput({ renames: [...RENAMES] }).renames).toHaveLength(3)
  })

  it('renames only typed gamelinks and only the abilcmd id component', () => {
    const mapper = createTriggerGamelinkMapper(RENAMES)
    const result = renameTriggerGamelinks(TRIGGER_GAMELINK_FIXTURE, mapper)
    expect(result.patched).toBe(3)
    expect(result.xml).toContain('<Value>CUSTOM_Marine</Value>')
    expect(result.xml).toContain('<Value>CUSTOM_ZapDamage</Value>')
    expect(result.xml).toContain('<Value>CUSTOM_ZapAbil,Execute</Value>')
    expect(result.xml).toMatch(/Id="A0000004">[\s\S]*?<Value>Marine<\/Value>/u)
  })

  it('matches catalog names case-insensitively and preserves an unparseable input byte-for-byte', () => {
    const mapper = createTriggerGamelinkMapper([
      { catalog: 'unit', oldId: 'Marine', newId: 'Marauder' },
    ])
    expect(renameTriggerGamelinks(TRIGGER_GAMELINK_FIXTURE, mapper).patched).toBe(1)
    expect(renameTriggerGamelinks('not TriggerData', mapper)).toEqual({
      xml: 'not TriggerData',
      patched: 0,
    })
  })

  it('recognizes only TriggerData-bearing paths', () => {
    expect(isTriggerFilePath('base.sc2data/triggerlibs/voidmultilib.sc2lib')).toBe(true)
    expect(isTriggerFilePath('Triggers')).toBe(true)
    expect(isTriggerFilePath('some/dir/triggers')).toBe(true)
    expect(isTriggerFilePath('GameData/UnitData.xml')).toBe(false)
  })

  it('reports unverifiable catalog context and untouched custom scripts', () => {
    const result = prepareTriggerGamelinkRename(
      TRIGGER_GAMELINK_WITH_SCRIPT_FIXTURE,
      1,
      { renames: RENAMES },
    )
    expect(result.patched).toBe(3)
    expect(result.xml).toContain('<Value>CUSTOM_Marine</Value>')
    expect(result.xml).toContain('UnitCreate(1, "Marine", 0, 1,')
    expect(result.diagnostics.map(item => item.code)).toEqual(
      expect.arrayContaining([TRIGGER_RENAME_NO_CATALOG_CODE, TRIGGER_RENAME_CUSTOM_SCRIPT_CODE]),
    )
  })

  it('refuses conflicting mappings before changing the document', () => {
    const result = prepareTriggerGamelinkRename(TRIGGER_GAMELINK_FIXTURE, 0, {
      renames: [
        { catalog: 'Unit', oldId: 'Marine', newId: 'A' },
        { catalog: 'unit', oldId: 'Marine', newId: 'B' },
      ],
    })
    expect(result.xml).toBe(TRIGGER_GAMELINK_FIXTURE)
    expect(result.patched).toBe(0)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: TRIGGER_RENAME_CONFLICT_CODE, severity: 'error' }),
    ])
  })

  it('uses a supplied catalog only for verification and reports unknown source entities', () => {
    const result = prepareTriggerGamelinkRename(
      TRIGGER_GAMELINK_FIXTURE,
      0,
      { renames: RENAMES },
      { hasEntity: () => false },
    )
    expect(result.patched).toBe(3)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: TRIGGER_RENAME_UNKNOWN_ENTITY_CODE, severity: 'warning' }),
    ])
  })

  it('returns a diagnosed no-op rather than requesting a whole-file rewrite', () => {
    const result = prepareTriggerGamelinkRename(
      TRIGGER_GAMELINK_FIXTURE,
      0,
      { renames: [{ catalog: 'Unit', oldId: 'Zergling', newId: 'Hydralisk' }] },
      { hasEntity: () => true },
    )
    expect(result.xml).toBe(TRIGGER_GAMELINK_FIXTURE)
    expect(result.patched).toBe(0)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: TRIGGER_RENAME_NO_OP_CODE, severity: 'information' }),
    ])
  })

  it('preserves the implicit-map TriggerData shape while patching typed values', () => {
    const mapDocument = TRIGGER_GAMELINK_FIXTURE
      .replace(/\s*<Library Id="DEMO">/u, '')
      .replace(/\s*<\/Library>/u, '')
      .replaceAll(' Library="DEMO"', '')
    const result = renameTriggerGamelinks(
      mapDocument,
      (catalog, id) => catalog.toLowerCase() === 'unit' && id === 'Marine' ? 'Marauder' : undefined,
    )
    expect(result.patched).toBe(1)
    expect(result.xml).toContain('<Value>Marauder</Value>')
    expect(result.xml).not.toContain('<Standard Id="Map"/>')
    expect(result.xml).not.toContain('<Library Id=')
  })
})
