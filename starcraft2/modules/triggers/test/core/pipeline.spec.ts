/**
 * Full pipeline integration test:
 *   vs-test.SC2Mod Triggers XML
 *     → readTriggerLibrary (TriggerLibraryJson)
 *     → triggerLibraryToEngineProgram (EngineProgram)
 *     → GalaxyEngine.loadProgram (runtime state)
 *
 * vs-test structure:
 *   - One root FunctionDef: TestTrigger (A9A17E63)
 *   - One local variable inside TestTrigger: Player (0BBDCAF9, type int)
 *   - No global variables, no Trigger elements
 *   - Body calls native functions (Ntve), some with subFunctions
 */
import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import { readTriggerLibrary } from '@modkit/blizzard-starcraft2/triggers/document/reader.js'
import { triggerLibraryToEngineProgram } from '@modkit/blizzard-starcraft2/triggers/document/to-engine.js'

// `@modkitx/engine` is not committed to this workspace (see
// sc2-arcade-watcher/modkit#3). Load it lazily so this spec module still
// resolves; the runtime cases below skip themselves when it is absent, and run
// automatically once the engine package is restored.
async function loadCreateGalaxyEngine(): Promise<((opts?: any) => any) | null> {
  try {
    const spec = '@modkitx/engine'
    const mod: any = await import(/* @vite-ignore */ spec)
    return mod.createGalaxyEngine ?? null
  } catch {
    return null
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../../..')
const root = resolve(repoRoot, 'testdata/vs-test.SC2Mod')
const triggerPath = resolve(root, 'Triggers')
const triggerStringsPath = resolve(root, 'enUS.SC2Data/LocalizedData/TriggerStrings.txt')
const describeWithVsTest =
  existsSync(triggerPath) && existsSync(triggerStringsPath) ? describe : describe.skip

async function loadVsTestLibrary() {
  const triggerXml = readFileSync(triggerPath, 'utf8')
  const triggerStrings = readFileSync(triggerStringsPath, 'utf8')
  const result = await readTriggerLibrary(triggerXml, triggerStrings)
  return result.library
}

describeWithVsTest('vs-test.SC2Mod full pipeline', () => {
  it('converts Triggers XML to EngineProgram without throwing', async () => {
    const lib = await loadVsTestLibrary()
    const prog = triggerLibraryToEngineProgram(lib, { includeRawFallbacks: true })
    expect(prog.kind).toBe('EngineProgram')
    expect(prog.modules).toHaveLength(1)
    expect(prog.modules[0]!.id).toBe('D970AA02')
  })

  it('emits the TestTrigger function with Player as a local variable', async () => {
    const lib = await loadVsTestLibrary()
    const prog = triggerLibraryToEngineProgram(lib, { includeRawFallbacks: true })
    const mod = prog.modules[0]!

    // TestLib has no global variables — Player is a local of TestTrigger
    expect(mod.globals).toHaveLength(0)

    const fn = mod.functions.find((f: any) => f.name === 'TestTrigger')
    expect(fn).toBeDefined()
    expect(fn!.kind).toBe('EngineFunction')

    // Player is declared as a local variable inside TestTrigger
    const playerLocal = fn!.locals.find((l: any) => l.name === 'Player')
    expect(playerLocal).toBeDefined()
    expect(playerLocal!.scope).toBe('local')
    expect(playerLocal!.type.name).toBe('int')
  })

  it('loads into GalaxyEngine without throwing', async ctx => {
    const createGalaxyEngine = await loadCreateGalaxyEngine()
    if (!createGalaxyEngine) return ctx.skip()
    const lib = await loadVsTestLibrary()
    const prog = triggerLibraryToEngineProgram(lib, { includeRawFallbacks: true })
    const engine = createGalaxyEngine()
    expect(() => engine.loadProgram(prog)).not.toThrow()
  })

  it('makes TestTrigger callable via the runtime (with raw fallbacks disabled)', async ctx => {
    const createGalaxyEngine = await loadCreateGalaxyEngine()
    if (!createGalaxyEngine) return ctx.skip()
    const lib = await loadVsTestLibrary()
    // includeRawFallbacks: false → no EngineRawStatement nodes in the body,
    // so the function can be executed even though native CF isn't lowered.
    const prog = triggerLibraryToEngineProgram(lib, { includeRawFallbacks: false })

    const engine = createGalaxyEngine({
      natives: new Proxy({} as Record<string, () => null>, {
        get: () => () => null,
        has: () => true,
      }),
    })
    engine.loadProgram(prog)
    expect(() => engine.runtime.callFunction('TestTrigger')).not.toThrow()
  })
})
