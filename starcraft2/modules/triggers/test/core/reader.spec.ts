import { describe, it, expect } from 'vitest'
import { readTriggerLibrary } from '@modkit/blizzard-starcraft2/triggers/document/reader.js'
import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../../..')
const triggerPath = resolve(repoRoot, 'testdata/vs-spawn-panel.SC2Mod/Triggers')
const triggerXml = existsSync(triggerPath) ? readFileSync(triggerPath, 'utf8') : ''
const describeWithFixture = existsSync(triggerPath) ? describe : describe.skip

describeWithFixture('readTriggerLibrary', () => {
  it('parses DPAN library', async () => {
    const result = await readTriggerLibrary(triggerXml)
    expect(result.library.id).toBe('DPAN')
  })

  it('finds root items', async () => {
    const result = await readTriggerLibrary(triggerXml)
    expect(result.library.items.length).toBeGreaterThan(0)
  })

  it('finds all element types', async () => {
    const result = await readTriggerLibrary(triggerXml)
    const types = new Set(Object.values(result.library.elements).map(e => e.type))
    expect(types.has('Trigger')).toBe(true)
    expect(types.has('Variable')).toBe(true)
    expect(types.has('FunctionDef')).toBe(true)
    expect(types.has('Param')).toBe(true)
    expect(types.has('FunctionCall')).toBe(true)
    expect(types.has('Category')).toBe(true)
    expect(types.has('ParamDef')).toBe(true)
  })

  it('extracts catalog refs', async () => {
    const result = await readTriggerLibrary(triggerXml)
    expect(result.allRefs.length).toBeGreaterThan(0)

    const abilRefs = result.allRefs.filter(r => r.catalog === 'Abil')
    expect(abilRefs.length).toBeGreaterThan(0)
    expect(abilRefs.some(r => r.entry.startsWith('SpawnCaster'))).toBe(true)

    const raceRefs = result.allRefs.filter(r => r.catalog === 'Race')
    expect(raceRefs.length).toBeGreaterThan(0)
  })

  it('has Trigger elements with events/actions', async () => {
    const result = await readTriggerLibrary(triggerXml)
    const triggers = Object.values(result.library.elements).filter(e => e.type === 'Trigger')
    expect(triggers.length).toBeGreaterThan(0)
    for (const t of triggers) {
      if (t.type === 'Trigger') {
        expect(Array.isArray(t.events)).toBe(true)
        expect(Array.isArray(t.actions)).toBe(true)
      }
    }
  })

  it('has Variable elements with type info', async () => {
    const result = await readTriggerLibrary(triggerXml)
    const variables = Object.values(result.library.elements).filter(e => e.type === 'Variable')
    expect(variables.length).toBeGreaterThan(0)
    for (const v of variables) {
      if (v.type === 'Variable') {
        expect(v.variableType).toBeDefined()
      }
    }
  })
})
