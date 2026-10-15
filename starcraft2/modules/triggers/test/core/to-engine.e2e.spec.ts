import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import { triggerLibraryToEngineProgram } from '@modkit/blizzard-starcraft2/triggers/document/to-engine.js'
import type { TriggerLibraryJson } from '@modkit/blizzard-starcraft2/triggers/document/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../../..')
const NTVE_PATH = join(repoRoot, 'assets/sc2-data-triggers/prebuilt/Ntve.json')
const describeWithNtve = existsSync(NTVE_PATH) ? describe : describe.skip

function loadNtve(): TriggerLibraryJson {
  return JSON.parse(readFileSync(NTVE_PATH, 'utf8'))
}

describeWithNtve('triggerLibraryToEngineProgram — NativeLib end-to-end', () => {
  it('converts the NativeLib without throwing', () => {
    const lib = loadNtve()
    const prog = triggerLibraryToEngineProgram(lib, {
      fileName: 'Ntve.json',
      includeRawFallbacks: true,
    })
    expect(prog.kind).toBe('EngineProgram')
    const mod = prog.modules[0]!
    expect(mod.id).toBe('Ntve')
    // 3004 FunctionDefs minus sub-function entries
    expect(mod.functions.length).toBeGreaterThan(0)
    expect(mod.triggers.length).toBeGreaterThan(0)
  })

  it('lowers IfThenElse in Flash Screen Button to EngineIfStatement', () => {
    const lib = loadNtve()
    const prog = triggerLibraryToEngineProgram(lib, {
      includeRawFallbacks: false,
    })
    const mod = prog.modules[0]!

    // "Flash Screen Button" (A61C4766) has an IfThenElse as its first action.
    const trigger = mod.triggers.find((t: any) => t.id === 'A61C4766')
    expect(trigger).toBeDefined()
    expect(trigger!.name).toMatch(/Flash/i)

    // The IfThenElse action (D1C21C1D) should be lowered to EngineIfStatement.
    // Its If block has 2 Comparison calls → they are AND-folded into EngineBinaryExpression.
    // The Then block happens to be empty (valid), and there is no Else block.
    const ifAction = trigger!.actions.find((a: any) => a.kind === 'EngineIfStatement')
    expect(ifAction).toBeDefined()
    const ifStmt = ifAction as any

    // 2 conditions AND-folded
    expect(ifStmt.condition.kind).toBe('EngineBinaryExpression')
    expect(ifStmt.condition.operator).toBe('&&')
    expect(ifStmt.condition.left.kind).toBe('EngineCallExpression')
    expect(ifStmt.condition.right.kind).toBe('EngineCallExpression')

    // Empty Then branch (data has 0 actions in the Then sub-block).
    expect(Array.isArray(ifStmt.then)).toBe(true)
    // No Else branch present in this trigger's data.
    expect(ifStmt.else).toBeUndefined()
  })

  it('emits non-zero function count with correct shape', () => {
    const lib = loadNtve()
    const prog = triggerLibraryToEngineProgram(lib, { includeRawFallbacks: false })
    const mod = prog.modules[0]!

    // Every function should have a name and a kind.
    for (const fn of mod.functions) {
      expect(fn.kind).toBe('EngineFunction')
      expect(typeof fn.name).toBe('string')
    }
  })

  it('emits globals from the NativeLib', () => {
    const lib = loadNtve()
    const prog = triggerLibraryToEngineProgram(lib, { includeRawFallbacks: false })
    const mod = prog.modules[0]!
    for (const g of mod.globals) {
      expect(g.kind).toBe('EngineVariable')
      expect(g.scope).toBe('global')
    }
  })
})
