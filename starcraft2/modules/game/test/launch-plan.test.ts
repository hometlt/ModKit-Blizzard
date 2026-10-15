/**
 * The StarCraft II launch planner: SC2Switcher arguments for a map or a mod tested on a map (the
 * MK2 launcher's defaults), where the run logs, and what its GameLogs files say.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gameLaunchOptionsOf } from '@modkit/host/games'
import { createProvider } from '../providers/launch/runtime.js'
import { SC2_LAUNCH_OPTIONS, interpretSc2Log, sc2LaunchOptions } from '../providers/launch/src/launch.js'

const planner = createProvider({ contract: 'common.game/launch-plan', major: 1 }).value
const installation = {
  gameId: 'blizzard/starcraft-2',
  normalizedPath: 'C:/Apps/StarCraft II',
} as never
const request = (resource: { kind: 'map' | 'mod'; path: string }, options?: Record<string, unknown>) =>
  ({ gameId: 'blizzard/starcraft-2', installation, resource, ...(options === undefined ? {} : { options }) }) as never

describe('StarCraft II launch planning', () => {
  it('runs a map with the MK2 defaults, and says where the run logs and which process is the game', async () => {
    const plan = await planner.plan(request({ kind: 'map', path: 'C:/Maps/Test.SC2Map' }))
    expect(plan.arguments).toEqual([
      '-run', 'C:/Maps/Test.SC2Map', '-preload', '1', '-NoUserCheats',
      '-meleeMod', 'Void', '-difficulty', '2', '-speed', '2', '-displaymode', '1',
    ])
    expect(plan.arguments[plan.resourceArgumentIndex]).toBe('C:/Maps/Test.SC2Map')
    expect(plan.logs).toEqual({
      base: 'user-documents',
      relativePath: 'StarCraft II/GameLogs',
      patterns: ['*ScriptError.txt', '*Alerts.txt'],
    })
    expect(plan.runningProcessNames).toEqual(['SC2_x64.exe', 'SC2.exe'])
  })

  it('applies the launch options: trigger debugger, speed, a test mod', async () => {
    const plan = await planner.plan(
      request({ kind: 'map', path: 'C:/Maps/Test.SC2Map' }, {
        triggerDebug: true, speed: 4, preload: false, testMod: 'C:/Mods/Extra.SC2Mod', meleeMod: '',
      }),
    )
    expect(plan.arguments).toEqual([
      '-run', 'C:/Maps/Test.SC2Map', '-NoUserCheats', '-meleeMod', 'Void', '-difficulty', '2',
      '-speed', '4', '-displaymode', '0', '-TrigDebug', '-testmod', 'C:/Mods/Extra.SC2Mod',
    ])
  })

  it('tests a mod on the map its options name, and refuses without one', async () => {
    const plan = await planner.plan(
      request({ kind: 'mod', path: 'C:/Mods/Mine.SC2Mod' }, { map: 'C:/Maps/Arena.SC2Map' }),
    )
    expect(plan.arguments.slice(0, 2)).toEqual(['-run', 'C:/Maps/Arena.SC2Map'])
    expect(plan.arguments.slice(-2)).toEqual(['-testmod', 'C:/Mods/Mine.SC2Mod'])
    expect(plan.arguments[plan.resourceArgumentIndex]).toBe('C:/Mods/Mine.SC2Mod')
    await expect(planner.plan(request({ kind: 'mod', path: 'C:/Mods/Mine.SC2Mod' }))).rejects.toThrow('map to run it on')
  })

  it('refuses options the game does not know, of the wrong type, or relative paths', async () => {
    const map = { kind: 'map' as const, path: 'C:/Maps/Test.SC2Map' }
    await expect(planner.plan(request(map, { turbo: true }))).rejects.toThrow('no option "turbo"')
    await expect(planner.plan(request(map, { speed: 'fast' }))).rejects.toThrow('must be a number')
    await expect(planner.plan(request(map, { testConfig: 'test.json' }))).rejects.toThrow('absolute path')
    // The ranges of the declared table (the planner's dist takes them on the next build).
    expect(() => sc2LaunchOptions({ speed: 5 })).toThrow('integer from 0 to 4')
    expect(() => sc2LaunchOptions({ difficulty: 1.5 })).toThrow('integer from 0 to 3')
    expect(sc2LaunchOptions({ difficulty: 3, testMod: ' C:/Mods/X.SC2Mod ' })).toEqual({ difficulty: 3, testMod: 'C:/Mods/X.SC2Mod' })
  })

  // Plan 8.8: what an editor offers and checks in launch.json is the planner's own table.
  it('declares its options in the offer, exactly the table the planner checks, and the host reads them', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'providers', 'launch', 'provider.json'), 'utf8'))
    expect(manifest.spec.provides[0].facet.launchOptions).toEqual(SC2_LAUNCH_OPTIONS)
    // One malformed option would drop the whole offer: the host's parser keeps it.
    const inventory = { extensions: [{ contributions: [{ activationEligible: true, manifest }] }] } as never
    expect(gameLaunchOptionsOf(inventory).get('blizzard/starcraft-2')).toEqual(SC2_LAUNCH_OPTIONS)
  })
})

describe('reading StarCraft II GameLogs', () => {
  const resource = { kind: 'map' as const, path: 'C:\\Maps\\Test.SC2Map' }

  it('places script compile errors in the package files and ends the watch', async () => {
    const report = await planner.interpretLog!({
      resource,
      fileName: '2026-09-24 10.00.00 ScriptError.txt',
      text:
        'Script compile error: scripts/main.galaxy (42), Syntax error\n' +
        '    Script code: int x = \n' +
        'Script load failed: Main\n',
    })
    expect(report.final).toBe(true)
    expect(report.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'blizzard/sc2-script-compile-error',
        message: 'Syntax error — int x =',
        path: 'C:\\Maps\\Test.SC2Map\\scripts\\main.galaxy',
        line: 41,
      },
      { severity: 'error', code: 'blizzard/sc2-script-load-failed', message: 'Script load failed: Main' },
    ])
  })

  // Plan 6.16: as warnings, which an application keeps (the source, ahead of the planner's next build).
  it('reports alerts as warnings without ending the watch', async () => {
    const report = await interpretSc2Log({
      resource,
      fileName: 'Alerts.txt',
      text: 'header\n====\nUSER 1 0.00 12.50 Not enough minerals\n',
    } as never)
    expect(report).toEqual({
      diagnostics: [{ severity: 'warning', code: 'blizzard/sc2-alert', message: 'Not enough minerals' }],
      final: false,
    })
  })
})
